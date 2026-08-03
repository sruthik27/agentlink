import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendMessage,
  approveConversation,
  closeConversation,
  conversationPath,
  createConversation,
  listConversations,
  readConversation,
  resolveConversation,
} from './store.js';

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentlink-store-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('conversation store appends messages and status changes as JSONL', async (t) => {
  const cwd = await temporaryWorkspace(t);
  const conversation = await createConversation(cwd, {
    id: 'conversation-1',
    topic: 'OAuth contract change',
    target: '%2',
    createdAt: '2026-07-25T08:00:00.000Z',
  });

  assert.equal(conversation.status, 'open');
  await appendMessage(cwd, conversation.id, {
    role: 'assistant',
    from: 'api-agent',
    body: 'I propose adding expiresAt.',
    timestamp: '2026-07-25T08:01:00.000Z',
  });
  const closed = await closeConversation(cwd, conversation.id, '2026-07-25T08:02:00.000Z');

  assert.equal(closed.status, 'closed');
  assert.equal(closed.messages.length, 1);
  assert.deepEqual(closed.messages[0], {
    type: 'message',
    role: 'assistant',
    from: 'api-agent',
    body: 'I propose adding expiresAt.',
    timestamp: '2026-07-25T08:01:00.000Z',
  });

  const lines = (await readFile(conversationPath(cwd, conversation.id), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => JSON.parse(line).type), ['conversation', 'message', 'status']);
  await assert.rejects(
    appendMessage(cwd, conversation.id, {
      role: 'user',
      from: 'human',
      body: 'Too late',
    }),
    /is closed/,
  );
});

test('listing and default resolution choose the latest open conversation', async (t) => {
  const cwd = await temporaryWorkspace(t);
  await createConversation(cwd, {
    id: 'older',
    topic: 'Older topic',
    createdAt: '2026-07-25T08:00:00.000Z',
  });
  await createConversation(cwd, {
    id: 'newer',
    topic: 'Newer topic',
    createdAt: '2026-07-25T09:00:00.000Z',
  });
  await closeConversation(cwd, 'newer', '2026-07-25T09:01:00.000Z');

  const conversations = await listConversations(cwd);
  assert.deepEqual(conversations.map(({ id, status }) => ({ id, status })), [
    { id: 'newer', status: 'closed' },
    { id: 'older', status: 'open' },
  ]);
  assert.equal((await resolveConversation(cwd)).id, 'older');
  assert.equal((await readConversation(cwd, 'newer')).status, 'closed');
});


test('conversation gates enforce max rounds and record unique approvals', async (t) => {
  const cwd = await temporaryWorkspace(t);
  await createConversation(cwd, {
    id: 'gated-conversation',
    topic: 'Bounded negotiation',
    maxRounds: 1,
    requiredApprovals: 2,
    createdAt: '2026-07-29T08:00:00.000Z',
  });

  await appendMessage(cwd, 'gated-conversation', {
    role: 'assistant',
    from: 'producer-agent',
    body: 'Proposal v1',
    timestamp: '2026-07-29T08:01:00.000Z',
  });
  await assert.rejects(
    appendMessage(cwd, 'gated-conversation', {
      role: 'assistant',
      from: 'consumer-agent',
      body: 'Proposal v2',
    }),
    /reached its max round limit \(1\)/,
  );

  await approveConversation(cwd, 'gated-conversation', {
    from: 'producer-agent',
    timestamp: '2026-07-29T08:02:00.000Z',
  });
  await assert.rejects(
    approveConversation(cwd, 'gated-conversation', { from: 'producer-agent' }),
    /already has approval from producer-agent/,
  );

  const conversation = await readConversation(cwd, 'gated-conversation');
  assert.equal(conversation.maxRounds, 1);
  assert.equal(conversation.requiredApprovals, 2);
  assert.deepEqual(conversation.approvals.map((approval) => approval.from), ['producer-agent']);
});
