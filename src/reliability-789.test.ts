import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  associateWorkspace,
  heartbeatAgent,
  initializeWorkspaceIdentity,
  listAgentRegistrations,
  registerAgent,
} from './workspace.js';
import {
  appendMessage,
  createConversation,
  joinConversation,
  readConversation,
  readMessages,
  waitForMessages,
} from './store.js';
import { writeConversationContract } from './contract.js';
import {
  configureTrustedNotificationAdapter,
  notifyMessage,
  retryNotification,
} from './notifications.js';

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

async function fixture(t: test.TestContext, prefix: string): Promise<{ root: string; source: string; peer: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const source = join(root, 'source');
  const peer = join(root, 'peer');
  await mkdir(source);
  await mkdir(peer);
  t.after(async () => rm(root, { recursive: true, force: true }));
  await initializeWorkspaceIdentity(source);
  await initializeWorkspaceIdentity(peer);
  return { root, source, peer };
}

test('explicit IDE-independent registrations heartbeat and expire without changing stable participants', async (t) => {
  const { source, peer } = await fixture(t, 'agentlink-registry-');
  await associateWorkspace(source, peer);
  const start = new Date('2026-09-23T00:00:00.000Z');
  const sourceRegistration = await registerAgent(source, {
    registrationId: 'reg_source', label: 'API Codex', clientKind: 'codex', ttlSeconds: 60,
  }, { now: start });
  const peerRegistration = await registerAgent(peer, {
    registrationId: 'reg_peer', label: 'Web IDE', clientKind: 'other-ide', ttlSeconds: 10,
  }, { now: start });

  assert.deepEqual((await listAgentRegistrations(source, { now: new Date(start.getTime() + 5_000) })).map((entry) => entry.registrationId), ['reg_peer', 'reg_source']);
  await assert.rejects(heartbeatAgent(source, peerRegistration.registrationId, 60, { now: start }), /owned by participant/);
  const renewed = await heartbeatAgent(peer, peerRegistration.registrationId, 30, { now: new Date(start.getTime() + 5_000) });
  assert.equal(renewed.participantId, peerRegistration.participantId);
  assert.equal(sourceRegistration.participantId === peerRegistration.participantId, false);

  assert.deepEqual((await listAgentRegistrations(source, { now: new Date(start.getTime() + 36_000) })).map((entry) => entry.registrationId), ['reg_source']);
  await assert.rejects(heartbeatAgent(peer, 'reg_peer', 30, { now: new Date(start.getTime() + 36_000) }), /not found or expired/);
});

test('bounded waits observe concurrent sends, time out normally, and cancel without acknowledgement', async (t) => {
  const { source } = await fixture(t, 'agentlink-wait-');
  const conversation = await createConversation(source, { id: 'wait-thread', topic: 'Bounded wait' });
  await writeConversationContract(source, { conversationId: conversation.id, topic: conversation.topic });
  const initial = await readMessages(source, conversation.id, { limit: 20 });

  const waiting = waitForMessages(source, conversation.id, { after: initial.nextCursor, timeoutMs: 1_000, limit: 20 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  await appendMessage(source, conversation.id, { role: 'assistant', body: 'arrived while waiting' });
  const received = await waiting;
  assert.equal(received.outcome, 'message');
  assert.equal(received.messages[0]?.body, 'arrived while waiting');

  const after = await readMessages(source, conversation.id, { limit: 20 });
  const timedOut = await waitForMessages(source, conversation.id, { after: after.nextCursor, timeoutMs: 75, limit: 20 });
  assert.equal(timedOut.outcome, 'timeout');
  assert.equal(timedOut.messages.length, 0);

  const controller = new AbortController();
  const cancelled = waitForMessages(source, conversation.id, { after: after.nextCursor, timeoutMs: 1_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(cancelled, (error: Error) => error.name === 'AbortError' && /cancelled/.test(error.message));
});

test('trusted argv notification receiver gets references only, failures preserve messages, and retries deduplicate', async (t) => {
  const { root, source, peer } = await fixture(t, 'agentlink-notify-');
  const trustPath = join(root, 'user-notification-trust.json');
  const inbox = join(root, 'receiver', 'events.jsonl');
  const oldTrustPath = process.env.AGENTLINK_TRUST_CONFIG;
  process.env.AGENTLINK_TRUST_CONFIG = trustPath;
  t.after(() => {
    if (oldTrustPath === undefined) delete process.env.AGENTLINK_TRUST_CONFIG;
    else process.env.AGENTLINK_TRUST_CONFIG = oldTrustPath;
  });

  const conversation = await createConversation(source, { id: 'notify-thread', topic: 'Safe notification' });
  await writeConversationContract(source, { conversationId: conversation.id, topic: conversation.topic });
  await associateWorkspace(source, peer, { conversationId: conversation.id });
  await joinConversation(peer, conversation.id);
  await registerAgent(peer, {
    registrationId: 'reg_receiver', label: 'Peer receiver', clientKind: 'test', notificationAdapterId: 'local_receiver', ttlSeconds: 300,
  });

  const untrustedMarker = join(root, 'repo-command-ran');
  await writeFile(join(source, '.agentlink', 'notifications.json'), JSON.stringify({
    schemaVersion: 1,
    adapters: [{ id: 'local_receiver', argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(untrustedMarker)}, 'bad')`], timeoutMs: 2_000 }],
  }), 'utf8');
  const untrustedMessage = await appendMessage(source, conversation.id, { role: 'assistant', body: 'repo config is not trust' });
  const untrusted = await notifyMessage(source, conversation.id, untrustedMessage.messageId!, untrustedMessage.participantId!);
  assert.equal(untrusted.failed, 1);
  assert.match(untrusted.warnings[0]!, /not trusted in user config/);
  await assert.rejects(readFile(untrustedMarker, 'utf8'), /ENOENT/);

  await configureTrustedNotificationAdapter(source, {
    id: 'local_receiver', argv: [process.execPath, cliPath, 'receiver', '--inbox', inbox], timeoutMs: 2_000,
  }, trustPath);
  const firstMessage = await appendMessage(source, conversation.id, { role: 'assistant', body: 'secret body must not enter hook argv or inbox' });
  const delivered = await notifyMessage(source, conversation.id, firstMessage.messageId!, firstMessage.participantId!);
  assert.equal(delivered.delivered, 1);
  const received = await readFile(inbox, 'utf8');
  assert.match(received, new RegExp(firstMessage.messageId!));
  assert.doesNotMatch(received, /secret body/);

  await configureTrustedNotificationAdapter(source, {
    id: 'local_receiver', argv: [process.execPath, '-e', 'process.exit(7)'], timeoutMs: 2_000,
  }, trustPath);
  const failedMessage = await appendMessage(source, conversation.id, { role: 'assistant', body: 'persistence survives failure' });
  const failed = await notifyMessage(source, conversation.id, failedMessage.messageId!, failedMessage.participantId!);
  assert.equal(failed.failed, 1);
  assert.equal((await readConversation(source, conversation.id)).messages.at(-1)?.body, 'persistence survives failure');
  assert.match(failed.warnings[0]!, /failed.*Retry explicitly/i);

  await configureTrustedNotificationAdapter(source, {
    id: 'local_receiver', argv: [process.execPath, cliPath, 'receiver', '--inbox', inbox], timeoutMs: 2_000,
  }, trustPath);
  const retried = await retryNotification(source, failed.events[0]!.eventId);
  assert.equal(retried.state, 'delivered');
  assert.equal(retried.attempts.length, 2);
  const deduplicated = await retryNotification(source, failed.events[0]!.eventId);
  assert.equal(deduplicated.attempts.length, 2);
  const inboxEntries = (await readFile(inbox, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { eventId: string });
  assert.equal(inboxEntries.filter((entry) => entry.eventId === failed.events[0]!.eventId).length, 1);
});

test('notification timeout terminates the receiver process group before returning', async (t) => {
  const { root, source, peer } = await fixture(t, 'agentlink-notify-timeout-');
  const trustPath = join(root, 'user-notification-trust.json');
  const marker = join(root, 'receiver-survived.txt');
  const receiver = join(root, 'ignores-term.mjs');
  const previousTrust = process.env.AGENTLINK_TRUST_CONFIG;
  process.env.AGENTLINK_TRUST_CONFIG = trustPath;
  t.after(() => {
    if (previousTrust === undefined) delete process.env.AGENTLINK_TRUST_CONFIG;
    else process.env.AGENTLINK_TRUST_CONFIG = previousTrust;
  });
  await writeFile(receiver, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 300);\nsetTimeout(() => process.exit(0), 1000);\n`, 'utf8');
  await chmod(receiver, 0o755);

  const conversation = await createConversation(source, { id: 'timeout-thread', topic: 'Bound receiver' });
  await writeConversationContract(source, { conversationId: conversation.id, topic: conversation.topic });
  await associateWorkspace(source, peer, { conversationId: conversation.id });
  const joined = await joinConversation(peer, conversation.id);
  await configureTrustedNotificationAdapter(source, {
    id: 'slow_receiver', argv: [process.execPath, receiver], timeoutMs: 50,
  }, trustPath);
  await registerAgent(peer, {
    registrationId: 'reg_slow', label: 'Slow receiver', clientKind: 'test', notificationAdapterId: 'slow_receiver', ttlSeconds: 300,
  });
  const message = await appendMessage(source, conversation.id, {
    role: 'user', body: 'terminate receiver', recipientParticipantId: joined.participantId,
  });
  const result = await notifyMessage(source, conversation.id, message.messageId!, message.participantId!);
  assert.equal(result.failed, 1);
  assert.match(result.events[0]!.attempts.at(-1)!.detail, /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(readFile(marker, 'utf8'), /ENOENT/);
});

test('notification timeout kills descendants after the receiver group leader exits on SIGTERM', async (t) => {
  const { root, source, peer } = await fixture(t, 'agentlink-notify-descendant-timeout-');
  const trustPath = join(root, 'user-notification-trust.json');
  const marker = join(root, 'descendant-survived.txt');
  const descendant = join(root, 'ignores-term-descendant.mjs');
  const receiver = join(root, 'exits-on-term-parent.mjs');
  const previousTrust = process.env.AGENTLINK_TRUST_CONFIG;
  process.env.AGENTLINK_TRUST_CONFIG = trustPath;
  t.after(() => {
    if (previousTrust === undefined) delete process.env.AGENTLINK_TRUST_CONFIG;
    else process.env.AGENTLINK_TRUST_CONFIG = previousTrust;
  });
  await writeFile(descendant, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 300);\nsetTimeout(() => process.exit(0), 1000);\n`, 'utf8');
  await writeFile(receiver, `#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\nspawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`, 'utf8');
  await chmod(descendant, 0o755);
  await chmod(receiver, 0o755);

  const conversation = await createConversation(source, { id: 'descendant-timeout-thread', topic: 'Bound receiver descendants' });
  await writeConversationContract(source, { conversationId: conversation.id, topic: conversation.topic });
  await associateWorkspace(source, peer, { conversationId: conversation.id });
  const joined = await joinConversation(peer, conversation.id);
  await configureTrustedNotificationAdapter(source, {
    id: 'descendant_receiver', argv: [process.execPath, receiver], timeoutMs: 100,
  }, trustPath);
  await registerAgent(peer, {
    registrationId: 'reg_descendant', label: 'Descendant receiver', clientKind: 'test', notificationAdapterId: 'descendant_receiver', ttlSeconds: 300,
  });
  const message = await appendMessage(source, conversation.id, {
    role: 'user', body: 'terminate receiver descendants', recipientParticipantId: joined.participantId,
  });
  const result = await notifyMessage(source, conversation.id, message.messageId!, message.participantId!);
  assert.equal(result.failed, 1);
  assert.match(result.events[0]!.attempts.at(-1)!.detail, /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(readFile(marker, 'utf8'), /ENOENT/);
});
