import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ENVELOPE_FUTURE_SKEW_MS,
  MAX_INBOX_EVENTS_PER_PEER,
  MAX_REPLAY_TOMBSTONES,
  REPLAY_TOMBSTONE_RETENTION_MS,
  queueOutboundEvent,
  readMailboxState,
  receiveInboundEvent,
  recordOutboundReceipt,
} from './mailbox.js';
import { parseEnvelope } from './types.js';

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-network-mailbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const envelope = (body = 'hello') => parseEnvelope({
  version: 1,
  eventId: 'event-1',
  sender: { nodeId: 'node-a', agentId: 'backend' },
  recipient: { nodeId: 'node-b', agentId: 'frontend' },
  collaborationId: 'orders-v2',
  kind: 'message',
  body,
  createdAt: '2026-10-10T04:00:00.000Z',
});

test('inbox persists before receipt and identical retries return the original durable receipt', async (t) => {
  const root = await temporaryRoot(t);
  const payload = JSON.stringify(envelope());
  const first = await receiveInboundEvent(root, envelope(), payload, new Date('2026-10-10T04:01:00.000Z'));
  const duplicate = await receiveInboundEvent(root, envelope(), payload, new Date('2026-10-10T05:00:00.000Z'));
  assert.deepEqual(duplicate, first);
  assert.equal(first.status, 'transport-received');

  const restarted = await readMailboxState(root);
  assert.equal(restarted.inbox.length, 1);
  assert.deepEqual(restarted.inbox[0]?.receipt, first);
  assert.equal(restarted.inbox[0]?.envelope.body, 'hello');
});

test('reused sender/event identity with different payload bytes is rejected durably', async (t) => {
  const root = await temporaryRoot(t);
  await receiveInboundEvent(root, envelope(), JSON.stringify(envelope()));
  const conflict = envelope('changed');
  await assert.rejects(receiveInboundEvent(root, conflict, JSON.stringify(conflict)), /conflicting replay/);
  assert.equal((await readMailboxState(root)).inbox.length, 1);
});

test('outbox is durable before transmission and stores only a transport receipt', async (t) => {
  const root = await temporaryRoot(t);
  const queued = await queueOutboundEvent(root, envelope());
  assert.equal(queued.status, 'queued');
  assert.equal((await readMailboxState(root)).outbox[0]?.status, 'queued');

  const receiverRoot = await temporaryRoot(t);
  const receipt = await receiveInboundEvent(receiverRoot, envelope(), queued.payload);
  await recordOutboundReceipt(root, envelope().eventId, receipt);
  const persisted = (await readMailboxState(root)).outbox[0];
  assert.equal(persisted?.status, 'transport-received');
  assert.deepEqual(persisted?.receipt, receipt);
  assert.equal('processedAt' in (persisted ?? {}), false);
});

test('inbox enforces a finite per-peer quota and keeps existing durable entries', async (t) => {
  const root = await temporaryRoot(t);
  for (let index = 0; index < MAX_INBOX_EVENTS_PER_PEER; index += 1) {
    const item = parseEnvelope({ ...envelope(), eventId: `event-${index}` });
    await receiveInboundEvent(root, item, JSON.stringify(item));
  }
  const overflow = parseEnvelope({ ...envelope(), eventId: 'event-overflow' });
  await assert.rejects(receiveInboundEvent(root, overflow, JSON.stringify(overflow)), /quota/i);
  assert.equal((await readMailboxState(root)).inbox.length, MAX_INBOX_EVENTS_PER_PEER);
});

test('expired inbox entries compact to bounded replay tombstones and stale envelopes stay rejected', async (t) => {
  const root = await temporaryRoot(t);
  const first = envelope();
  const original = await receiveInboundEvent(root, first, JSON.stringify(first), new Date('2026-10-10T04:01:00.000Z'));
  const later = new Date('2026-11-24T04:01:00.000Z');
  const current = parseEnvelope({ ...envelope(), eventId: 'event-current', createdAt: later.toISOString() });
  await receiveInboundEvent(root, current, JSON.stringify(current), later);
  let state = await readMailboxState(root);
  assert.equal(state.inbox.some((entry) => entry.envelope.eventId === first.eventId), false);
  assert.equal(state.tombstones.some((entry) => entry.eventId === first.eventId), true);
  state = await readMailboxState(root);
  assert.equal(state.tombstones.some((entry) => entry.eventId === first.eventId), true);
  assert.deepEqual(await receiveInboundEvent(root, first, JSON.stringify(first), later), original);

  const afterReplayWindow = new Date('2027-01-20T04:01:00.000Z');
  const newest = parseEnvelope({ ...envelope(), eventId: 'event-newest', createdAt: afterReplayWindow.toISOString() });
  await receiveInboundEvent(root, newest, JSON.stringify(newest), afterReplayWindow);
  state = await readMailboxState(root);
  assert.equal(state.tombstones.some((entry) => entry.eventId === first.eventId), false);
  await assert.rejects(receiveInboundEvent(root, first, JSON.stringify(first), afterReplayWindow), /expired|stale|replay/i);
});

test('future timestamps cannot outlive bounded replay protection', async (t) => {
  const root = await temporaryRoot(t);
  const now = new Date('2026-10-10T04:01:00.000Z');
  const future = parseEnvelope({
    ...envelope(),
    eventId: 'event-future',
    createdAt: new Date(now.getTime() + MAX_ENVELOPE_FUTURE_SKEW_MS + 1).toISOString(),
  });
  await assert.rejects(receiveInboundEvent(root, future, JSON.stringify(future), now), /future timestamp/i);
  assert.equal((await readMailboxState(root)).inbox.length, 0);
});

test('replay tombstones cover the full future-skew window including the expiry boundary', async (t) => {
  const root = await temporaryRoot(t);
  const receivedAt = new Date('2026-10-10T04:00:00.000Z');
  const future = parseEnvelope({
    ...envelope(),
    eventId: 'event-skew-boundary',
    createdAt: new Date(receivedAt.getTime() + MAX_ENVELOPE_FUTURE_SKEW_MS).toISOString(),
  });
  const payload = JSON.stringify(future);
  const original = await receiveInboundEvent(root, future, payload, receivedAt);
  const boundary = new Date(receivedAt.getTime() + REPLAY_TOMBSTONE_RETENTION_MS + MAX_ENVELOPE_FUTURE_SKEW_MS);

  const replay = await receiveInboundEvent(root, future, payload, boundary);
  assert.deepEqual(replay, original);
  assert.equal((await readMailboxState(root)).tombstones.some((entry) => entry.eventId === future.eventId), true);

  await assert.rejects(
    receiveInboundEvent(root, future, payload, new Date(boundary.getTime() + 1)),
    /expired replay/i,
  );
});

test('a full tombstone quota retains replay evidence instead of forgetting a live event', async (t) => {
  const root = await temporaryRoot(t);
  const first = envelope();
  const payload = JSON.stringify(first);
  const original = await receiveInboundEvent(root, first, payload, new Date('2026-10-10T04:01:00.000Z'));
  const state = await readMailboxState(root);
  state.tombstones = Array.from({ length: MAX_REPLAY_TOMBSTONES }, (_unused, index) => ({
    senderNodeId: 'node-other',
    eventId: `prior-${index}`,
    payloadHash: state.inbox[0]!.payloadHash,
    receipt: {
      ...original,
      receiptId: `receipt-prior-${index}`,
      eventId: `prior-${index}`,
    },
    expiresAt: '2099-01-01T00:00:00.000Z',
  }));
  await writeFile(join(root, 'mailbox.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 });

  const later = new Date('2026-11-24T04:01:00.000Z');
  const current = parseEnvelope({ ...envelope(), eventId: 'event-current-at-cap', createdAt: later.toISOString() });
  await receiveInboundEvent(root, current, JSON.stringify(current), later);
  const retained = await readMailboxState(root);
  assert.equal(retained.tombstones.length, MAX_REPLAY_TOMBSTONES);
  assert.equal(retained.inbox.some((entry) => entry.envelope.eventId === first.eventId), true);
  assert.deepEqual(await receiveInboundEvent(root, first, payload, later), original);
});
