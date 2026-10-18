import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, readUtf8IfExists, withFileLock } from '../atomic.js';
import {
  NETWORK_SCHEMA_VERSION,
  type NetworkEnvelope,
  type TransportReceipt,
  parseEnvelope,
  parseReceipt,
  sha256,
} from './types.js';
import { withDeliveryAuthorization } from './trust.js';

export const MAX_INBOX_EVENTS = 128;
export const MAX_INBOX_EVENTS_PER_PEER = 64;
export const MAX_OUTBOX_EVENTS = 128;
export const MAX_OUTBOX_EVENTS_PER_PEER = 64;
export const MAX_MAILBOX_STATE_BYTES = 20 * 1024 * 1024;
export const MAILBOX_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const REPLAY_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const MAX_REPLAY_TOMBSTONES = 512;
export const MAX_ENVELOPE_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export interface InboxEntry {
  envelope: NetworkEnvelope;
  payload: string;
  payloadHash: string;
  receipt: TransportReceipt;
}

export interface OutboxEntry {
  envelope: NetworkEnvelope;
  payload: string;
  payloadHash: string;
  status: 'queued' | 'transport-received';
  queuedAt: string;
  receipt?: TransportReceipt;
}

export interface ReplayTombstone {
  senderNodeId: string;
  eventId: string;
  payloadHash: string;
  receipt: TransportReceipt;
  expiresAt: string;
}

export interface MailboxState {
  version: 1;
  inbox: InboxEntry[];
  outbox: OutboxEntry[];
  tombstones: ReplayTombstone[];
}

const mailboxPath = (root: string): string => join(root, 'mailbox.json');
const locksPath = (root: string): string => join(root, 'locks');
const emptyState = (): MailboxState => ({ version: NETWORK_SCHEMA_VERSION, inbox: [], outbox: [], tombstones: [] });

function parseMailboxState(value: unknown): MailboxState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid mailbox state');
  const state = value as Partial<MailboxState>;
  if (state.version !== NETWORK_SCHEMA_VERSION || !Array.isArray(state.inbox) || !Array.isArray(state.outbox)
    || (state.tombstones !== undefined && !Array.isArray(state.tombstones))) {
    throw new Error('Invalid mailbox state');
  }
  for (const entry of state.inbox) {
    entry.envelope = parseEnvelope(entry.envelope);
    entry.receipt = parseReceipt(entry.receipt);
    if (typeof entry.payload !== 'string' || entry.payloadHash !== sha256(entry.payload)) throw new Error('Invalid inbox payload');
  }
  for (const entry of state.outbox) {
    entry.envelope = parseEnvelope(entry.envelope);
    if (typeof entry.payload !== 'string' || entry.payloadHash !== sha256(entry.payload)) throw new Error('Invalid outbox payload');
    if (entry.status !== 'queued' && entry.status !== 'transport-received') throw new Error('Invalid outbox status');
    if (entry.receipt) entry.receipt = parseReceipt(entry.receipt);
  }
  state.tombstones ??= [];
  for (const tombstone of state.tombstones) {
    if (typeof tombstone !== 'object' || tombstone === null
      || typeof tombstone.senderNodeId !== 'string' || typeof tombstone.eventId !== 'string'
      || typeof tombstone.payloadHash !== 'string' || typeof tombstone.expiresAt !== 'string') {
      throw new Error('Invalid replay tombstone');
    }
    tombstone.receipt = parseReceipt(tombstone.receipt);
  }
  if (state.tombstones.length > MAX_REPLAY_TOMBSTONES) throw new Error('Replay tombstone quota exceeded');
  return state as MailboxState;
}

function compact(state: MailboxState, now: Date): void {
  const inboxCutoff = now.getTime() - MAILBOX_ENTRY_RETENTION_MS;
  state.tombstones = state.tombstones
    .filter((entry) => Date.parse(entry.expiresAt) >= now.getTime())
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
  const retainedInbox: InboxEntry[] = [];
  for (const entry of state.inbox) {
    if (Date.parse(entry.receipt.receivedAt) >= inboxCutoff) {
      retainedInbox.push(entry);
    } else {
      const expiresAt = Date.parse(entry.receipt.receivedAt)
        + REPLAY_TOMBSTONE_RETENTION_MS + MAX_ENVELOPE_FUTURE_SKEW_MS;
      if (expiresAt < now.getTime()) continue;
      if (state.tombstones.length >= MAX_REPLAY_TOMBSTONES) {
        retainedInbox.push(entry);
      } else {
        state.tombstones.push({
          senderNodeId: entry.envelope.sender.nodeId,
          eventId: entry.envelope.eventId,
          payloadHash: entry.payloadHash,
          receipt: entry.receipt,
          expiresAt: new Date(expiresAt).toISOString(),
        });
      }
    }
  }
  state.inbox = retainedInbox;
  state.outbox = state.outbox.filter((entry) => Date.parse(entry.queuedAt) >= inboxCutoff);
  state.tombstones.sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
}

function assertStateSize(state: MailboxState): void {
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_MAILBOX_STATE_BYTES) {
    throw new Error('Mailbox total byte quota exceeded');
  }
}

function receiveIntoState(
  state: MailboxState,
  envelope: NetworkEnvelope,
  payload: string,
  payloadHash: string,
  now: Date,
): TransportReceipt {
  compact(state, now);
  const existing = state.inbox.find((entry) => entry.envelope.sender.nodeId === envelope.sender.nodeId
    && entry.envelope.eventId === envelope.eventId);
  const tombstone = state.tombstones.find((entry) => entry.senderNodeId === envelope.sender.nodeId
    && entry.eventId === envelope.eventId);
  if (existing || tombstone) {
    const prior = existing ?? tombstone!;
    if (prior.payloadHash !== payloadHash) throw new Error(`Event ${envelope.eventId} is a conflicting replay`);
    return prior.receipt;
  }
  const createdAt = Date.parse(envelope.createdAt);
  if (createdAt > now.getTime() + MAX_ENVELOPE_FUTURE_SKEW_MS) {
    throw new Error(`Event ${envelope.eventId} has a future timestamp outside the allowed clock skew`);
  }
  if (createdAt < now.getTime() - REPLAY_TOMBSTONE_RETENTION_MS) {
    throw new Error(`Event ${envelope.eventId} is an expired replay`);
  }
  if (state.inbox.length >= MAX_INBOX_EVENTS
    || state.inbox.filter((entry) => entry.envelope.sender.nodeId === envelope.sender.nodeId).length >= MAX_INBOX_EVENTS_PER_PEER) {
    throw new Error('Inbox event quota exceeded');
  }
  const receipt: TransportReceipt = {
    version: NETWORK_SCHEMA_VERSION,
    receiptId: `receipt-${randomUUID()}`,
    eventId: envelope.eventId,
    status: 'transport-received',
    payloadHash,
    receivedAt: now.toISOString(),
  };
  state.inbox.push({ envelope, payload, payloadHash, receipt });
  assertStateSize(state);
  return receipt;
}

export async function readMailboxState(root: string): Promise<MailboxState> {
  const content = await readUtf8IfExists(mailboxPath(root));
  return content === undefined ? emptyState() : parseMailboxState(JSON.parse(content));
}

async function locked<T>(root: string, operation: (state: MailboxState) => T | Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await withFileLock(locksPath(root), 'network-mailbox', async () => {
    const state = await readMailboxState(root);
    const result = await operation(state);
    await atomicWriteFile(mailboxPath(root), `${JSON.stringify(state)}\n`);
    return result;
  });
}

export async function queueOutboundEvent(root: string, input: NetworkEnvelope, now = new Date()): Promise<OutboxEntry> {
  const envelope = parseEnvelope(input);
  const payload = JSON.stringify(envelope);
  const payloadHash = sha256(payload);
  return await locked(root, (state) => {
    compact(state, now);
    const existing = state.outbox.find((entry) => entry.envelope.eventId === envelope.eventId
      && entry.envelope.sender.nodeId === envelope.sender.nodeId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error(`Event ${envelope.eventId} is a conflicting replay`);
      return existing;
    }
    if (state.outbox.length >= MAX_OUTBOX_EVENTS
      || state.outbox.filter((candidate) => candidate.envelope.recipient.nodeId === envelope.recipient.nodeId).length >= MAX_OUTBOX_EVENTS_PER_PEER) {
      throw new Error('Outbox event quota exceeded');
    }
    const entry: OutboxEntry = { envelope, payload, payloadHash, status: 'queued', queuedAt: now.toISOString() };
    state.outbox.push(entry);
    assertStateSize(state);
    return entry;
  });
}

export async function receiveInboundEvent(
  root: string,
  input: NetworkEnvelope,
  payload: string,
  now = new Date(),
): Promise<TransportReceipt> {
  const envelope = parseEnvelope(input);
  let payloadEnvelope: NetworkEnvelope;
  try {
    payloadEnvelope = parseEnvelope(JSON.parse(payload));
  } catch {
    throw new Error('Inbound payload does not contain a valid envelope');
  }
  if (JSON.stringify(payloadEnvelope) !== JSON.stringify(envelope)) {
    throw new Error('Inbound payload does not match the supplied envelope');
  }
  const payloadHash = sha256(payload);
  return await locked(root, (state) => receiveIntoState(state, envelope, payload, payloadHash, now));
}

export async function receiveAuthorizedInboundEvent(
  root: string,
  input: NetworkEnvelope,
  payload: string,
  authenticatedNodeId: string,
  now?: Date,
): Promise<TransportReceipt> {
  const envelope = parseEnvelope(input);
  let payloadEnvelope: NetworkEnvelope;
  try {
    payloadEnvelope = parseEnvelope(JSON.parse(payload));
  } catch {
    throw new Error('Inbound payload does not contain a valid envelope');
  }
  if (JSON.stringify(payloadEnvelope) !== JSON.stringify(envelope)) throw new Error('Inbound payload does not match the supplied envelope');
  const payloadHash = sha256(payload);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await withFileLock(locksPath(root), 'network-mailbox', async () => {
    const state = await readMailboxState(root);
    return await withDeliveryAuthorization(
      root,
      authenticatedNodeId,
      envelope.sender.agentId,
      envelope.recipient.agentId,
      envelope.collaborationId,
      async (authorizedAt) => {
        const receipt = receiveIntoState(state, envelope, payload, payloadHash, authorizedAt);
        await atomicWriteFile(mailboxPath(root), `${JSON.stringify(state)}\n`);
        return receipt;
      },
      now,
    );
  });
}

export async function recordOutboundReceipt(root: string, eventId: string, input: TransportReceipt): Promise<void> {
  const receipt = parseReceipt(input);
  await locked(root, (state) => {
    const entry = state.outbox.find((candidate) => candidate.envelope.eventId === eventId);
    if (!entry) throw new Error(`Outbox event ${eventId} does not exist`);
    if (receipt.eventId !== entry.envelope.eventId || receipt.payloadHash !== entry.payloadHash) {
      throw new Error('Transport receipt does not match the queued event');
    }
    if (entry.receipt && entry.receipt.receiptId !== receipt.receiptId) throw new Error('Conflicting transport receipt');
    entry.status = 'transport-received';
    entry.receipt = receipt;
  });
}
