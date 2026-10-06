import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, readUtf8IfExists, withFileLock } from './atomic.js';
import { computeContractRevision } from './contract-content.js';
import {
  busContractsPath,
  busAcknowledgementsPath,
  busConversationsPath,
  busLocksPath,
  initializeWorkspaceIdentity,
  resolveActiveParticipant,
  type ParticipantIdentity,
} from './workspace.js';

export const AGENTLINK_DIRECTORY = '.agentlink';
export const CONVERSATIONS_DIRECTORY = 'conversations';

export type ConversationStatus = 'open' | 'closed';
export const MESSAGE_KINDS = ['proposal', 'decision', 'status', 'question', 'blocker'] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];
export const MESSAGE_REFERENCE_TYPES = ['commit', 'pr', 'msg_id'] as const;
export type MessageReferenceType = typeof MESSAGE_REFERENCE_TYPES[number];

export interface MessageReference {
  type: MessageReferenceType;
  value: string;
}

export interface ConversationStartedRecord {
  type: 'conversation';
  id: string;
  topic: string;
  createdAt: string;
  status: 'open';
  target?: string;
  messageCap?: number;
  maxRounds?: number;
  requiredApprovals?: number;
  ownerParticipantId?: string;
  participantIds?: string[];
}

export interface ConversationMessageRecord {
  type: 'message';
  role: string;
  from: string;
  body: string;
  timestamp: string;
  participantId?: string;
  workspaceId?: string;
  messageId?: string;
  sequence?: number;
  kind?: MessageKind;
  refs?: MessageReference[];
  recipientParticipantId?: string;
}

export interface ConversationStatusRecord {
  type: 'status';
  status: ConversationStatus;
  timestamp: string;
}

export interface ConversationApprovalRecord {
  type: 'approval';
  from: string;
  timestamp: string;
  participantId?: string;
  workspaceId?: string;
  revision?: string;
}

export interface ConversationParticipantRecord {
  type: 'participant';
  participantId: string;
  workspaceId: string;
  displayName: string;
  timestamp: string;
}

export interface ConversationParticipantRevokedRecord {
  type: 'participant_revoked';
  participantId: string;
  revokedByParticipantId: string;
  workspaceId: string;
  timestamp: string;
}

export interface ConversationSettingsRecord {
  type: 'settings';
  messageCap: number | null;
  participantId: string;
  workspaceId: string;
  timestamp: string;
}

export interface ConversationContractMutationRecord {
  type: 'contract_mutation';
  transactionId: string;
  participantId: string;
  workspaceId: string;
  previousRevision?: string;
  revision: string;
  status: string;
  timestamp: string;
}

export type ConversationRecord =
  | ConversationStartedRecord
  | ConversationMessageRecord
  | ConversationStatusRecord
  | ConversationApprovalRecord
  | ConversationParticipantRecord
  | ConversationParticipantRevokedRecord
  | ConversationSettingsRecord
  | ConversationContractMutationRecord;

export interface Conversation {
  id: string;
  topic: string;
  createdAt: string;
  updatedAt: string;
  status: ConversationStatus;
  target?: string;
  messageCap?: number;
  maxRounds?: number;
  requiredApprovals?: number;
  ownerParticipantId?: string;
  participantIds: string[];
  revokedParticipantIds: string[];
  messages: ConversationMessageRecord[];
  approvals: ConversationApprovalRecord[];
}

export interface ConversationSummary extends Omit<Conversation, 'messages' | 'approvals'> {
  messageCount: number;
  latestMessageAt?: string;
  latestMessageId?: string;
  currentApprovalCount: number;
  currentContractRevision?: string;
}

export interface CreateConversationInput {
  topic: string;
  target?: string;
  id?: string;
  createdAt?: string;
  maxRounds?: number;
  maxMessages?: number;
  requiredApprovals?: number;
}

export interface AppendMessageInput {
  role: string;
  body: string;
  from?: string;
  timestamp?: string;
  kind?: MessageKind;
  refs?: MessageReference[];
  recipientParticipantId?: string;
}

export interface ApproveConversationInput {
  from?: string;
  timestamp?: string;
  revision?: string;
}

export interface ReadMessagesOptions {
  after?: string;
  since?: string;
  limit?: number;
}

export interface MessagePage {
  conversationId: string;
  messages: ConversationMessageRecord[];
  nextCursor: string;
  hasMore: boolean;
  unreadCount: number;
  acknowledgedMessageId?: string;
}

export interface WaitForMessagesOptions extends ReadMessagesOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WaitForMessagesResult extends MessagePage {
  outcome: 'message' | 'timeout';
  waitedMs: number;
}

export interface AcknowledgeMessagesInput {
  messageId?: string;
  cursor?: string;
}

export interface AcknowledgementState {
  schemaVersion: 1;
  busId: string;
  conversationId: string;
  participantId: string;
  acknowledgedSequence: number;
  acknowledgedMessageId?: string;
  updatedAt: string;
}

export function workspacePath(cwd = process.cwd()): string {
  return join(cwd, AGENTLINK_DIRECTORY);
}

export function conversationsPath(cwd = process.cwd()): string {
  try {
    const association = JSON.parse(requireRead(join(workspacePath(cwd), 'association.json'))) as { busPath?: unknown };
    if (typeof association.busPath === 'string') return busConversationsPath(association.busPath);
  } catch {
    // Legacy path before initialization.
  }
  return join(workspacePath(cwd), CONVERSATIONS_DIRECTORY);
}

function requireRead(path: string): string {
  return readFileSync(path, 'utf8');
}

export async function ensureWorkspace(cwd = process.cwd()): Promise<string> {
  const context = await initializeWorkspaceIdentity(cwd);
  return context.statePath;
}

function assertNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} cannot be empty`);
  return trimmed;
}

function assertPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function assertConversationId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`Invalid conversation id: ${id}`);
  return id;
}

export function conversationPath(cwd: string, id: string): string {
  return join(conversationsPath(cwd), `${assertConversationId(id)}.jsonl`);
}

async function authoritativeConversationPath(cwd: string, id: string): Promise<{ path: string; locks: string; busId: string; busPath: string }> {
  const context = await initializeWorkspaceIdentity(cwd);
  return {
    path: join(busConversationsPath(context.association.busPath), `${assertConversationId(id)}.jsonl`),
    locks: busLocksPath(context.association.busPath),
    busId: context.bus.busId,
    busPath: context.association.busPath,
  };
}

async function readRecordsFromPath(path: string, id: string): Promise<ConversationRecord[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Conversation not found: ${id}`);
    throw error;
  }
  return content.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as ConversationRecord;
    } catch {
      throw new Error(`Invalid JSONL in conversation ${id} at line ${index + 1}`);
    }
  });
}

async function mutateRecords<T>(cwd: string, id: string, mutation: (records: ConversationRecord[], busId: string) => Promise<{ records: ConversationRecord[]; result: T }> | { records: ConversationRecord[]; result: T }): Promise<T> {
  const resolved = await authoritativeConversationPath(cwd, id);
  return withFileLock(resolved.locks, `conversation-${id}`, async () => {
    const records = await readRecordsFromPath(resolved.path, id);
    const changed = await mutation(records, resolved.busId);
    await atomicWriteFile(resolved.path, `${changed.records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    return changed.result;
  });
}

export async function createConversation(cwd: string, input: CreateConversationInput): Promise<Conversation> {
  const context = await initializeWorkspaceIdentity(cwd);
  const actor = await resolveActiveParticipant(cwd);
  const id = assertConversationId(input.id ?? randomUUID());
  const createdAt = input.createdAt ?? new Date().toISOString();
  const target = input.target?.trim();
  if (input.maxMessages !== undefined && input.maxRounds !== undefined && input.maxMessages !== input.maxRounds) {
    throw new Error('maxMessages and compatibility maxRounds cannot specify different message caps');
  }
  const messageCap = assertPositiveInteger(input.maxMessages ?? input.maxRounds, 'Message cap');
  const record: ConversationStartedRecord = {
    type: 'conversation', id, topic: assertNonEmpty(input.topic, 'Topic'), createdAt, status: 'open',
    ownerParticipantId: actor.participantId,
    participantIds: [actor.participantId],
    ...(target ? { target } : {}),
    ...(messageCap ? { messageCap } : {}),
    ...(input.maxRounds !== undefined ? { maxRounds: messageCap } : {}),
    ...(assertPositiveInteger(input.requiredApprovals, 'Required approvals') ? { requiredApprovals: input.requiredApprovals } : {}),
  };
  const path = join(busConversationsPath(context.association.busPath), `${id}.jsonl`);
  await withFileLock(busLocksPath(context.association.busPath), `conversation-${id}`, async () => {
    if (await readUtf8IfExists(path) !== undefined) throw new Error(`Conversation already exists: ${id}`);
    await atomicWriteFile(path, `${JSON.stringify(record)}\n`);
  });
  return hydrateConversation(id, [record], context.bus.busId);
}

export async function readConversationRecords(cwd: string, id: string): Promise<ConversationRecord[]> {
  const resolved = await authoritativeConversationPath(cwd, id);
  return readRecordsFromPath(resolved.path, assertConversationId(id));
}

function legacyMessageId(busId: string, conversationId: string, recordIndex: number, record: ConversationMessageRecord): string {
  const digest = createHash('sha256')
    .update(busId)
    .update('\0')
    .update(conversationId)
    .update('\0')
    .update(String(recordIndex))
    .update('\0')
    .update(JSON.stringify(record))
    .digest('hex');
  return `msg_legacy_${digest.slice(0, 24)}`;
}

function normalizeMessage(
  busId: string,
  conversationId: string,
  recordIndex: number,
  sequence: number,
  record: ConversationMessageRecord,
): ConversationMessageRecord {
  return {
    ...record,
    messageId: record.messageId ?? legacyMessageId(busId, conversationId, recordIndex, record),
    sequence: record.sequence ?? sequence,
  };
}

function hydrateConversation(id: string, records: ConversationRecord[], busId: string): Conversation {
  const started = records[0];
  if (!started || started.type !== 'conversation' || started.id !== id) throw new Error(`Conversation ${id} has no valid start record`);
  let status: ConversationStatus = started.status;
  let updatedAt = started.createdAt;
  const messages: ConversationMessageRecord[] = [];
  const approvals: ConversationApprovalRecord[] = [];
  const participants = new Set(started.participantIds ?? []);
  const revokedParticipants = new Set<string>();
  let messageCap = started.messageCap ?? started.maxRounds;
  let messageSequence = 0;
  if (started.ownerParticipantId) participants.add(started.ownerParticipantId);
  for (const [offset, record] of records.slice(1).entries()) {
    if (record.type === 'message') {
      messageSequence += 1;
      messages.push(normalizeMessage(busId, id, offset + 1, messageSequence, record));
    }
    else if (record.type === 'status') status = record.status;
    else if (record.type === 'approval') approvals.push(record);
    else if (record.type === 'participant') {
      if (!revokedParticipants.has(record.participantId)) participants.add(record.participantId);
    }
    else if (record.type === 'participant_revoked') {
      revokedParticipants.add(record.participantId);
      participants.delete(record.participantId);
    }
    else if (record.type === 'settings') messageCap = record.messageCap ?? undefined;
    if ('timestamp' in record) updatedAt = record.timestamp;
  }
  return {
    id: started.id, topic: started.topic, createdAt: started.createdAt, updatedAt, status,
    ...(started.target ? { target: started.target } : {}),
    ...(messageCap ? { messageCap, maxRounds: messageCap } : {}),
    ...(started.requiredApprovals ? { requiredApprovals: started.requiredApprovals } : {}),
    ...(started.ownerParticipantId ? { ownerParticipantId: started.ownerParticipantId } : {}),
    participantIds: [...participants], revokedParticipantIds: [...revokedParticipants], messages, approvals,
  };
}

export async function readConversation(cwd: string, id: string): Promise<Conversation> {
  const resolved = await authoritativeConversationPath(cwd, id);
  return hydrateConversation(assertConversationId(id), await readRecordsFromPath(resolved.path, id), resolved.busId);
}

export async function listConversations(cwd = process.cwd()): Promise<ConversationSummary[]> {
  const context = await initializeWorkspaceIdentity(cwd);
  const entries = await readdir(busConversationsPath(context.association.busPath), { withFileTypes: true });
  const conversations = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => readConversation(cwd, entry.name.slice(0, -6))));
  return Promise.all(conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(async ({ messages, approvals, ...conversation }) => {
    const contract = await readUtf8IfExists(join(busContractsPath(context.association.busPath), conversation.id, 'CONTRACT.md'));
    const revision = contract === undefined ? undefined : computeContractRevision(contract);
    return {
      ...conversation,
      messageCount: messages.length,
      currentApprovalCount: revision === undefined ? 0 : countRevisionApprovals({ ...conversation, approvals }, revision),
      ...(revision ? { currentContractRevision: revision } : {}),
      ...(messages.at(-1)?.timestamp ? { latestMessageAt: messages.at(-1)!.timestamp } : {}),
      ...(messages.at(-1)?.messageId ? { latestMessageId: messages.at(-1)!.messageId } : {}),
    };
  }));
}

export async function resolveConversation(cwd: string, id?: string, options: { allowLatestClosed?: boolean } = {}): Promise<Conversation> {
  if (id) return readConversation(cwd, id);
  const conversations = await listConversations(cwd);
  const candidates = options.allowLatestClosed
    ? conversations
    : conversations.filter((conversation) => conversation.status === 'open');
  if (candidates.length === 0) throw new Error('No open conversation found. Start one with `agentlink start`.');
  if (candidates.length > 1) {
    const details = candidates.map((conversation) => `${conversation.id} [${conversation.status}] ${conversation.topic}`).join('; ');
    throw new Error(`Conversation target is ambiguous. Specify conversationId or --conversation explicitly. Candidates: ${details}`);
  }
  return readConversation(cwd, candidates[0]!.id);
}

function assertActorAlias(inputAlias: string | undefined, actor: ParticipantIdentity): void {
  if (inputAlias !== undefined && inputAlias.trim() !== actor.displayName) {
    throw new Error(`Sender aliases are not identities. Active participant is ${actor.displayName} (${actor.participantId}); omit --from or select another actor.`);
  }
}

function assertMessageKind(value: MessageKind | undefined): MessageKind | undefined {
  if (value === undefined) return undefined;
  if (!MESSAGE_KINDS.includes(value)) throw new Error(`Invalid message kind: ${value}. Expected one of: ${MESSAGE_KINDS.join(', ')}`);
  return value;
}

function assertMessageReference(reference: MessageReference, messages: ConversationMessageRecord[]): MessageReference {
  if (!reference || !MESSAGE_REFERENCE_TYPES.includes(reference.type)) {
    throw new Error(`Invalid message reference type. Expected one of: ${MESSAGE_REFERENCE_TYPES.join(', ')}`);
  }
  const value = reference.value?.trim();
  if (!value) throw new Error(`Message reference ${reference.type} cannot be empty`);
  if (reference.type === 'commit' && !/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new Error(`Invalid commit reference: ${reference.value}`);
  }
  if (reference.type === 'pr' && !/^(?:#[1-9]\d*|[A-Za-z0-9_.-]+#[1-9]\d*|https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid PR reference: ${reference.value}`);
  }
  if (reference.type === 'msg_id' && !messages.some((message) => message.messageId === value)) {
    throw new Error(`Referenced message id not found in this conversation: ${value}`);
  }
  return { type: reference.type, value };
}

function assertBodyPreserved(value: string): string {
  if (!value.trim()) throw new Error('Message body cannot be empty');
  return value;
}

export async function joinConversation(cwd: string, id: string, timestamp = new Date().toISOString()): Promise<ConversationParticipantRecord> {
  const actor = await resolveActiveParticipant(cwd);
  return mutateRecords(cwd, id, (records, busId) => {
    const conversation = hydrateConversation(id, records, busId);
    if (conversation.status !== 'open') throw new Error(`Conversation ${id} is closed`);
    if (conversation.revokedParticipantIds.includes(actor.participantId)) {
      throw new Error(`Participant ${actor.participantId} was revoked from conversation ${id}; only the owner can restore eligibility through a new audited workflow`);
    }
    const existing = records.find((record): record is ConversationParticipantRecord => record.type === 'participant' && record.participantId === actor.participantId);
    if (conversation.participantIds.includes(actor.participantId)) {
      return { records, result: existing ?? { type: 'participant', participantId: actor.participantId, workspaceId: actor.workspaceId, displayName: actor.displayName, timestamp } };
    }
    const record: ConversationParticipantRecord = { type: 'participant', participantId: actor.participantId, workspaceId: actor.workspaceId, displayName: actor.displayName, timestamp };
    return { records: [...records, record], result: record };
  });
}

export async function revokeConversationParticipant(
  cwd: string,
  id: string,
  participantId: string,
  timestamp = new Date().toISOString(),
): Promise<ConversationParticipantRevokedRecord> {
  const actor = await resolveActiveParticipant(cwd);
  const targetId = assertConversationId(participantId);
  return mutateRecords(cwd, id, (records, busId) => {
    const conversation = hydrateConversation(id, records, busId);
    if (conversation.status !== 'open') throw new Error(`Conversation ${id} is closed`);
    if (conversation.ownerParticipantId !== actor.participantId) {
      throw new Error(`Only owner ${conversation.ownerParticipantId ?? '<legacy owner unavailable>'} can revoke conversation participants`);
    }
    if (targetId === conversation.ownerParticipantId) throw new Error('The conversation owner cannot revoke itself');
    if (!conversation.participantIds.includes(targetId)) {
      if (conversation.revokedParticipantIds.includes(targetId)) throw new Error(`Participant ${targetId} is already revoked from conversation ${id}`);
      throw new Error(`Participant ${targetId} is not eligible in conversation ${id}`);
    }
    const record: ConversationParticipantRevokedRecord = {
      type: 'participant_revoked', participantId: targetId, revokedByParticipantId: actor.participantId,
      workspaceId: actor.workspaceId, timestamp,
    };
    return { records: [...records, record], result: record };
  });
}

export async function appendMessage(cwd: string, id: string, input: AppendMessageInput): Promise<ConversationMessageRecord> {
  const actor = await resolveActiveParticipant(cwd);
  assertActorAlias(input.from, actor);
  return mutateRecords(cwd, id, (records, busId) => {
    const conversation = hydrateConversation(id, records, busId);
    if (conversation.status !== 'open') throw new Error(`Conversation ${id} is closed`);
    if (!conversation.participantIds.includes(actor.participantId)) throw new Error(`Participant ${actor.participantId} is not eligible in conversation ${id}; join it first`);
    if (input.recipientParticipantId !== undefined && !conversation.participantIds.includes(input.recipientParticipantId)) {
      throw new Error(`Recipient participant ${input.recipientParticipantId} is not eligible in conversation ${id}`);
    }
    if (conversation.messageCap !== undefined && conversation.messages.length >= conversation.messageCap) {
      throw new Error(`Conversation ${id} reached its message cap (${conversation.messageCap})`);
    }
    const maxSequence = conversation.messages.reduce((maximum, message) => Math.max(maximum, message.sequence ?? 0), 0);
    const refs = input.refs?.map((reference) => assertMessageReference(reference, conversation.messages));
    const record: ConversationMessageRecord = {
      type: 'message', role: assertNonEmpty(input.role, 'Role'), from: actor.displayName,
      body: assertBodyPreserved(input.body), timestamp: input.timestamp ?? new Date().toISOString(),
      participantId: actor.participantId, workspaceId: actor.workspaceId,
      messageId: `msg_${randomUUID()}`,
      sequence: maxSequence + 1,
      ...(assertMessageKind(input.kind) ? { kind: input.kind } : {}),
      ...(refs && refs.length > 0 ? { refs } : {}),
      ...(input.recipientParticipantId ? { recipientParticipantId: input.recipientParticipantId } : {}),
    };
    return { records: [...records, record], result: record };
  });
}

export async function approveConversation(cwd: string, id: string, input: ApproveConversationInput = {}): Promise<ConversationApprovalRecord> {
  const conversationId = assertConversationId(id);
  const context = await initializeWorkspaceIdentity(cwd);
  const actor = await resolveActiveParticipant(cwd);
  assertActorAlias(input.from, actor);
  const path = join(busConversationsPath(context.association.busPath), `${conversationId}.jsonl`);
  const contract = join(busContractsPath(context.association.busPath), conversationId, 'CONTRACT.md');
  return withFileLock(busLocksPath(context.association.busPath), `conversation-${conversationId}`, async () => {
    const records = await readRecordsFromPath(path, conversationId);
    const contractContent = await readUtf8IfExists(contract);
    if (contractContent === undefined) throw new Error(`Conversation ${conversationId} has no authoritative contract`);
    const revision = computeContractRevision(contractContent);
    if (input.revision !== undefined && input.revision !== revision) {
      throw new Error(`Cannot approve stale contract revision ${input.revision}; current revision is ${revision}`);
    }
    const conversation = hydrateConversation(conversationId, records, context.bus.busId);
    if (conversation.status !== 'open') throw new Error(`Conversation ${id} is closed`);
    if (!conversation.participantIds.includes(actor.participantId)) throw new Error(`Participant ${actor.participantId} is not eligible to approve conversation ${id}; join it first`);
    if (conversation.approvals.some((approval) => approval.participantId === actor.participantId && approval.revision === revision)) {
      throw new Error(`Participant ${actor.participantId} already approved revision ${revision}`);
    }
    const record: ConversationApprovalRecord = {
      type: 'approval', from: actor.displayName, participantId: actor.participantId,
      workspaceId: actor.workspaceId, revision, timestamp: input.timestamp ?? new Date().toISOString(),
    };
    await atomicWriteFile(path, `${[...records, record].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    return record;
  });
}

export function countRevisionApprovals(conversation: Pick<Conversation, 'participantIds' | 'approvals'>, revision: string): number {
  const eligible = new Set(conversation.participantIds);
  return new Set(conversation.approvals.filter((approval) => approval.revision === revision && approval.participantId && eligible.has(approval.participantId)).map((approval) => approval.participantId!)).size;
}

export async function closeConversation(cwd: string, id: string, timestamp = new Date().toISOString()): Promise<Conversation> {
  await mutateRecords(cwd, id, (records, busId) => {
    const conversation = hydrateConversation(id, records, busId);
    if (conversation.status === 'closed') return { records, result: undefined };
    return { records: [...records, { type: 'status', status: 'closed', timestamp } satisfies ConversationStatusRecord], result: undefined };
  });
  return readConversation(cwd, id);
}

interface CursorPayload {
  v: 1;
  busId: string;
  conversationId: string;
  afterSequence: number;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value: string): CursorPayload {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid alphabet');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (parsed.v !== 1 || typeof parsed.busId !== 'string' || typeof parsed.conversationId !== 'string'
      || !Number.isInteger(parsed.afterSequence) || parsed.afterSequence! < 0) {
      throw new Error('invalid payload');
    }
    return parsed as CursorPayload;
  } catch {
    throw new Error('Malformed cursor. Start again without after, or use a nextCursor returned by AgentLink.');
  }
}

function validateCursor(payload: CursorPayload, busId: string, conversationId: string, maximumSequence: number): number {
  if (payload.busId !== busId) throw new Error(`Cursor belongs to bus ${payload.busId}, not ${busId}`);
  if (payload.conversationId !== conversationId) {
    throw new Error(`Cursor belongs to conversation ${payload.conversationId}, not ${conversationId}`);
  }
  if (payload.afterSequence > maximumSequence) throw new Error(`Cursor sequence ${payload.afterSequence} is beyond conversation ${conversationId}`);
  return payload.afterSequence;
}

function acknowledgementPath(busPath: string, conversationId: string, participantId: string): string {
  return join(busAcknowledgementsPath(busPath), assertConversationId(conversationId), `${participantId}.json`);
}

async function readAcknowledgement(busPath: string, conversationId: string, participantId: string): Promise<AcknowledgementState | undefined> {
  const content = await readUtf8IfExists(acknowledgementPath(busPath, conversationId, participantId));
  if (content === undefined) return undefined;
  try {
    const state = JSON.parse(content) as AcknowledgementState;
    if (state.schemaVersion !== 1 || state.conversationId !== conversationId || state.participantId !== participantId
      || !Number.isInteger(state.acknowledgedSequence) || state.acknowledgedSequence < 0) {
      throw new Error('invalid state');
    }
    return state;
  } catch {
    throw new Error(`Invalid acknowledgement state for conversation ${conversationId} and participant ${participantId}`);
  }
}

export async function readAcknowledgementForParticipant(
  cwd: string,
  conversationId: string,
  participantId: string,
): Promise<AcknowledgementState | undefined> {
  const resolved = await authoritativeConversationPath(cwd, conversationId);
  return readAcknowledgement(resolved.busPath, conversationId, participantId);
}

function assertReadLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error('Message limit must be an integer from 1 to 1000');
  return limit;
}

export async function readMessages(cwd: string, id: string, options: ReadMessagesOptions = {}): Promise<MessagePage> {
  if (options.after !== undefined && options.since !== undefined) throw new Error('Specify after or since, not both');
  const resolved = await authoritativeConversationPath(cwd, id);
  const actor = await resolveActiveParticipant(cwd);
  const conversation = hydrateConversation(id, await readRecordsFromPath(resolved.path, id), resolved.busId);
  if (!conversation.participantIds.includes(actor.participantId)) {
    throw new Error(`Participant ${actor.participantId} is not eligible in conversation ${id}; join it first`);
  }
  const maximumSequence = conversation.messages.at(-1)?.sequence ?? 0;
  let afterSequence = 0;
  if (options.after !== undefined) afterSequence = validateCursor(decodeCursor(options.after), resolved.busId, id, maximumSequence);
  if (options.since !== undefined) {
    const message = conversation.messages.find((candidate) => candidate.messageId === options.since);
    if (!message) throw new Error(`Message id not found in conversation ${id}: ${options.since}`);
    afterSequence = message.sequence!;
  }
  const limit = assertReadLimit(options.limit);
  const remaining = conversation.messages.filter((message) => message.sequence! > afterSequence);
  const messages = remaining.slice(0, limit);
  const cursorSequence = messages.at(-1)?.sequence ?? afterSequence;
  const acknowledgement = await readAcknowledgement(resolved.busPath, id, actor.participantId);
  const acknowledgedSequence = acknowledgement?.acknowledgedSequence ?? 0;
  return {
    conversationId: id,
    messages,
    nextCursor: encodeCursor({ v: 1, busId: resolved.busId, conversationId: id, afterSequence: cursorSequence }),
    hasMore: remaining.length > messages.length,
    unreadCount: conversation.messages.filter((message) => message.sequence! > acknowledgedSequence).length,
    ...(acknowledgement?.acknowledgedMessageId ? { acknowledgedMessageId: acknowledgement.acknowledgedMessageId } : {}),
  };
}

export async function readMessage(cwd: string, id: string, messageId: string): Promise<ConversationMessageRecord> {
  const actor = await resolveActiveParticipant(cwd);
  const conversation = await readConversation(cwd, id);
  if (!conversation.participantIds.includes(actor.participantId)) {
    throw new Error(`Participant ${actor.participantId} is not eligible in conversation ${id}; join it first`);
  }
  const message = conversation.messages.find((candidate) => candidate.messageId === messageId);
  if (!message) throw new Error(`Message id not found in conversation ${id}: ${messageId}`);
  return message;
}

function waitDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Message wait cancelled'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Message wait cancelled'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForMessages(cwd: string, id: string, options: WaitForMessagesOptions): Promise<WaitForMessagesResult> {
  if (options.after === undefined && options.since === undefined) {
    throw new Error('Bounded wait requires an after cursor or since message id from a prior read');
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('Wait timeout must be an integer from 1 to 30000 milliseconds');
  }
  const startedAt = Date.now();
  for (;;) {
    if (options.signal?.aborted) throw Object.assign(new Error('Message wait cancelled'), { name: 'AbortError' });
    const page = await readMessages(cwd, id, options);
    if (page.messages.length > 0) return { ...page, outcome: 'message', waitedMs: Date.now() - startedAt };
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return { ...page, outcome: 'timeout', waitedMs: elapsed };
    await waitDelay(Math.min(50, timeoutMs - elapsed), options.signal);
  }
}

export async function ackMessagesForParticipant(
  cwd: string,
  id: string,
  input: AcknowledgeMessagesInput,
  participantId: string,
): Promise<AcknowledgementState> {
  if ((input.messageId === undefined) === (input.cursor === undefined)) throw new Error('Specify exactly one of messageId or cursor');
  const resolved = await authoritativeConversationPath(cwd, id);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(participantId)) throw new Error(`Invalid participant id: ${participantId}`);
  return withFileLock(resolved.locks, `ack-${id}-${participantId}`, async () => {
    const conversation = hydrateConversation(id, await readRecordsFromPath(resolved.path, id), resolved.busId);
    if (!conversation.participantIds.includes(participantId)) {
      throw new Error(`Participant ${participantId} is not eligible in conversation ${id}; join it first`);
    }
    const maximumSequence = conversation.messages.at(-1)?.sequence ?? 0;
    let acknowledgedSequence: number;
    if (input.cursor !== undefined) {
      acknowledgedSequence = validateCursor(decodeCursor(input.cursor), resolved.busId, id, maximumSequence);
    } else {
      const message = conversation.messages.find((candidate) => candidate.messageId === input.messageId);
      if (!message) throw new Error(`Message id not found in conversation ${id}: ${input.messageId}`);
      acknowledgedSequence = message.sequence!;
    }
    const current = await readAcknowledgement(resolved.busPath, id, participantId);
    const effectiveSequence = Math.max(current?.acknowledgedSequence ?? 0, acknowledgedSequence);
    const effectiveMessage = conversation.messages.find((message) => message.sequence === effectiveSequence);
    const state: AcknowledgementState = {
      schemaVersion: 1,
      busId: resolved.busId,
      conversationId: id,
      participantId,
      acknowledgedSequence: effectiveSequence,
      ...(effectiveMessage?.messageId ? { acknowledgedMessageId: effectiveMessage.messageId } : {}),
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteFile(acknowledgementPath(resolved.busPath, id, participantId), `${JSON.stringify(state, null, 2)}\n`);
    return state;
  });
}

export async function ackMessages(cwd: string, id: string, input: AcknowledgeMessagesInput): Promise<AcknowledgementState> {
  const actor = await resolveActiveParticipant(cwd);
  return ackMessagesForParticipant(cwd, id, input, actor.participantId);
}

export function capWarning(conversation: Conversation): string | undefined {
  if (conversation.messageCap === undefined) return undefined;
  const remaining = conversation.messageCap - conversation.messages.length;
  const warningWindow = Math.max(1, Math.ceil(conversation.messageCap * 0.2));
  if (remaining > warningWindow) return undefined;
  if (remaining <= 0) return `Message cap ${conversation.messageCap} reached; the owner must raise or remove it before another message can be persisted.`;
  return `${remaining} message${remaining === 1 ? '' : 's'} remains before message cap ${conversation.messageCap}.`;
}

export async function setMessageCap(cwd: string, id: string, messageCap: number | null, timestamp = new Date().toISOString()): Promise<Conversation> {
  if (messageCap !== null) assertPositiveInteger(messageCap, 'Message cap');
  const actor = await resolveActiveParticipant(cwd);
  await mutateRecords(cwd, id, (records, busId) => {
    const conversation = hydrateConversation(id, records, busId);
    if (conversation.status !== 'open') throw new Error(`Conversation ${id} is closed`);
    if (conversation.ownerParticipantId !== actor.participantId) {
      throw new Error(`Only owner ${conversation.ownerParticipantId ?? '<legacy owner unavailable>'} can change the message cap for conversation ${id}`);
    }
    if (messageCap !== null && messageCap < conversation.messages.length) {
      throw new Error(`Message cap ${messageCap} cannot be below the current message count ${conversation.messages.length}`);
    }
    const record: ConversationSettingsRecord = {
      type: 'settings', messageCap, participantId: actor.participantId, workspaceId: actor.workspaceId, timestamp,
    };
    return { records: [...records, record], result: undefined };
  });
  return readConversation(cwd, id);
}
