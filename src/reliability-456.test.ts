import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ackMessages,
  appendMessage,
  capWarning,
  conversationPath,
  createConversation,
  joinConversation,
  listConversations,
  readConversation,
  readMessages,
  resolveConversation,
  setMessageCap,
} from './store.js';
import { syncContractToWorkspace, writeConversationContract } from './contract.js';

async function temporaryWorkspace(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('ambiguous implicit targets fail with actionable conversation candidates', async (t) => {
  const cwd = await temporaryWorkspace(t, 'agentlink-ambiguous-');
  await createConversation(cwd, { id: 'api-shape', topic: 'API shape' });
  await createConversation(cwd, { id: 'ui-flow', topic: 'UI flow' });

  await assert.rejects(
    resolveConversation(cwd),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /ambiguous/i);
      assert.match(message, /api-shape/);
      assert.match(message, /ui-flow/);
      assert.match(message, /conversationId|--conversation/);
      return true;
    },
  );
  assert.equal((await resolveConversation(cwd, 'api-shape')).topic, 'API shape');
});

test('cursor pagination has durable ids, metadata, body fidelity, and restart-safe ordering', async (t) => {
  const cwd = await temporaryWorkspace(t, 'agentlink-cursor-');
  await createConversation(cwd, { id: 'cursor-thread', topic: 'Cursor protocol' });
  const first = await appendMessage(cwd, 'cursor-thread', {
    role: 'assistant',
    body: '  preserve this body exactly\n  including indentation  ',
    kind: 'proposal',
    refs: [{ type: 'commit', value: 'abcdef1' }, { type: 'pr', value: '#42' }],
    timestamp: '2026-09-23T01:00:00.000Z',
  });
  const second = await appendMessage(cwd, 'cursor-thread', {
    role: 'assistant',
    body: 'Decision recorded.',
    kind: 'decision',
    refs: [{ type: 'msg_id', value: first.messageId! }],
    timestamp: '2026-09-23T01:01:00.000Z',
  });
  await appendMessage(cwd, 'cursor-thread', {
    role: 'assistant',
    body: 'What should happen next?',
    kind: 'question',
    timestamp: '2026-09-23T01:02:00.000Z',
  });

  const pageOne = await readMessages(cwd, 'cursor-thread', { limit: 2 });
  assert.deepEqual(pageOne.messages.map((message) => message.sequence), [1, 2]);
  assert.deepEqual(pageOne.messages.map((message) => message.messageId), [first.messageId, second.messageId]);
  assert.equal(pageOne.messages[0]?.body, '  preserve this body exactly\n  including indentation  ');
  assert.equal(pageOne.messages[0]?.kind, 'proposal');
  assert.deepEqual(pageOne.messages[0]?.refs, [{ type: 'commit', value: 'abcdef1' }, { type: 'pr', value: '#42' }]);
  assert.equal(pageOne.hasMore, true);
  assert.ok(pageOne.nextCursor);
  assert.equal(pageOne.unreadCount, 3);

  const pageTwoAfterRestart = await readMessages(cwd, 'cursor-thread', {
    after: pageOne.nextCursor,
    limit: 2,
  });
  assert.deepEqual(pageTwoAfterRestart.messages.map((message) => message.sequence), [3]);
  assert.equal(pageTwoAfterRestart.hasMore, false);
  assert.equal(pageTwoAfterRestart.unreadCount, 3, 'reading must not acknowledge processing');

  const sinceMessage = await readMessages(cwd, 'cursor-thread', { since: first.messageId, limit: 10 });
  assert.deepEqual(sinceMessage.messages.map((message) => message.sequence), [2, 3]);
  await assert.rejects(readMessages(cwd, 'cursor-thread', { after: 'not-a-cursor' }), /malformed cursor/i);

  await createConversation(cwd, { id: 'other-thread', topic: 'Other' });
  await assert.rejects(
    readMessages(cwd, 'other-thread', { after: pageOne.nextCursor }),
    /cursor belongs to conversation cursor-thread/i,
  );
});

test('legacy messages receive stable derived identities without rewriting legacy records', async (t) => {
  const cwd = await temporaryWorkspace(t, 'agentlink-legacy-message-');
  await createConversation(cwd, { id: 'legacy-thread', topic: 'Legacy timeline' });
  const path = conversationPath(cwd, 'legacy-thread');
  await appendFile(path, `${JSON.stringify({
    type: 'message',
    role: 'assistant',
    from: 'old-agent',
    body: 'Legacy body',
    timestamp: '2026-07-25T08:01:00.000Z',
  })}\n`);

  const firstRead = await readConversation(cwd, 'legacy-thread');
  const secondRead = await readConversation(cwd, 'legacy-thread');
  assert.match(firstRead.messages[0]?.messageId ?? '', /^msg_legacy_/);
  assert.equal(firstRead.messages[0]?.messageId, secondRead.messages[0]?.messageId);
  assert.equal(firstRead.messages[0]?.sequence, 1);
  assert.doesNotMatch(await readFile(path, 'utf8'), /messageId|sequence/);
});

test('durable acknowledgements are per participant and shared across distinct repo cwd values', async (t) => {
  const source = await temporaryWorkspace(t, 'agentlink-ack-source-');
  const peer = await temporaryWorkspace(t, 'agentlink-ack-peer-');
  await createConversation(source, { id: 'shared-thread', topic: 'Shared routing' });
  await writeConversationContract(source, { conversationId: 'shared-thread', topic: 'Shared routing' });
  await syncContractToWorkspace(source, peer, 'shared-thread');
  await joinConversation(peer, 'shared-thread');

  const fromSource = await appendMessage(source, 'shared-thread', { role: 'assistant', body: 'source message' });
  const fromPeer = await appendMessage(peer, 'shared-thread', { role: 'assistant', body: 'peer message' });
  assert.equal(conversationPath(source, 'shared-thread'), conversationPath(peer, 'shared-thread'));
  assert.deepEqual(
    (await readConversation(source, 'shared-thread')).messages.map((message) => message.messageId),
    [fromSource.messageId, fromPeer.messageId],
  );

  assert.equal((await readMessages(peer, 'shared-thread', { limit: 10 })).unreadCount, 2);
  assert.equal((await readMessages(peer, 'shared-thread', { limit: 10 })).unreadCount, 2);
  const acknowledged = await ackMessages(peer, 'shared-thread', { messageId: fromSource.messageId! });
  assert.equal(acknowledged.acknowledgedMessageId, fromSource.messageId);
  assert.equal((await readMessages(peer, 'shared-thread', { limit: 10 })).unreadCount, 1);
  assert.equal((await readMessages(source, 'shared-thread', { limit: 10 })).unreadCount, 2);

  await ackMessages(peer, 'shared-thread', { cursor: (await readMessages(peer, 'shared-thread', { limit: 10 })).nextCursor });
  assert.equal((await readMessages(peer, 'shared-thread', { limit: 10 })).unreadCount, 0);
  await assert.rejects(ackMessages(peer, 'shared-thread', { messageId: 'msg_missing' }), /not found/i);
});

test('message caps default to unlimited and only the owner can raise or remove a configured cap', async (t) => {
  const owner = await temporaryWorkspace(t, 'agentlink-cap-owner-');
  const peer = await temporaryWorkspace(t, 'agentlink-cap-peer-');
  await createConversation(owner, { id: 'unlimited', topic: 'Unlimited by default' });
  for (let index = 1; index <= 13; index += 1) {
    await appendMessage(owner, 'unlimited', { role: 'assistant', body: `message ${index}` });
  }
  assert.equal((await readConversation(owner, 'unlimited')).messages.length, 13);

  await createConversation(owner, { id: 'capped', topic: 'Owner-adjustable cap', maxRounds: 3 });
  await writeConversationContract(owner, { conversationId: 'capped', topic: 'Owner-adjustable cap' });
  const contractBefore = await readFile(join(owner, '.agentlink', 'bus', 'contracts', 'capped', 'CONTRACT.md'), 'utf8');
  await syncContractToWorkspace(owner, peer, 'capped');
  await joinConversation(peer, 'capped');
  await appendMessage(owner, 'capped', { role: 'assistant', body: 'one' });
  await appendMessage(owner, 'capped', { role: 'assistant', body: 'two' });
  assert.match(capWarning(await readConversation(owner, 'capped')) ?? '', /1 message remains/i);

  await assert.rejects(setMessageCap(peer, 'capped', 5), /only owner/i);
  const raised = await setMessageCap(owner, 'capped', 5);
  assert.equal(raised.messageCap, 5);
  await appendMessage(peer, 'capped', { role: 'assistant', body: 'three' });
  await appendMessage(owner, 'capped', { role: 'assistant', body: 'four' });
  await appendMessage(owner, 'capped', { role: 'assistant', body: 'five' });
  await assert.rejects(appendMessage(owner, 'capped', { role: 'assistant', body: 'blocked' }), /message cap \(5\)/i);

  const uncapped = await setMessageCap(owner, 'capped', null);
  assert.equal(uncapped.messageCap, undefined);
  await appendMessage(owner, 'capped', { role: 'assistant', body: 'six' });
  assert.equal((await readConversation(owner, 'capped')).messages.length, 6);
  assert.equal(await readFile(join(owner, '.agentlink', 'bus', 'contracts', 'capped', 'CONTRACT.md'), 'utf8'), contractBefore);

  const summaries = await listConversations(peer);
  assert.equal(summaries.find((summary) => summary.id === 'capped')?.messageCount, 6);
});
