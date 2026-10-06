import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { associateWorkspace, initializeWorkspaceIdentity } from './workspace.js';
import { appendMessage, createConversation, joinConversation, readMessages } from './store.js';
import {
  enqueueCodexWake,
  enrollCodexWake,
  readCodexWakeStatus,
  reconcileCodexWake,
  requestCodexWakeStop,
  retryCodexWakeJob,
  runCodexWakeOnce,
  setCodexWakePaused,
} from './auto-wake.js';
import { runCli } from './cli.js';

const cliEntrypoint = fileURLToPath(new URL('./cli.js', import.meta.url));

async function fixture(t: test.TestContext, prefix: string): Promise<{
  root: string;
  source: string;
  peer: string;
  conversationId: string;
  sourceParticipantId: string;
  peerParticipantId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const source = join(root, 'source');
  const peer = join(root, 'peer');
  await mkdir(source);
  await mkdir(peer);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourceContext = await initializeWorkspaceIdentity(source);
  const conversation = await createConversation(source, { id: 'wake-thread', topic: 'Wake work' });
  await associateWorkspace(source, peer, { conversationId: conversation.id });
  const peerContext = await initializeWorkspaceIdentity(peer);
  const joined = await joinConversation(peer, conversation.id);
  return {
    root,
    source,
    peer,
    conversationId: conversation.id,
    sourceParticipantId: conversation.ownerParticipantId!,
    peerParticipantId: joined.participantId,
  };
}

async function fakeCodex(root: string, behavior: 'success' | 'claim-only' | 'quota' | 'timeout' = 'success'): Promise<string> {
  const path = join(root, `fake-codex-${behavior}.mjs`);
  const body = behavior === 'success'
    ? `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const prompt = readFileSync(0, 'utf8');
const messageId = prompt.match(/msg_[A-Za-z0-9_-]+/)?.[0];
const conversationId = prompt.match(/conversation ([A-Za-z0-9_-]+)/)?.[1];
const log = new URL('./fake-invocations.jsonl', import.meta.url);
appendFileSync(log, JSON.stringify({ args, prompt, startedAt: Date.now() }) + '\\n');
await new Promise((resolve) => setTimeout(resolve, 30));
const threadId = args[0] === 'exec' && args[1] === 'resume' ? args[args.indexOf('resume') + 1] : '019faaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n');
const report = spawnSync(process.execPath, [${JSON.stringify(cliEntrypoint)}, 'send', '--conversation', conversationId, '--kind', 'status', '--refs', 'msg_id:' + messageId, '--body', 'fake completed'], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
if (report.status !== 0) { process.stderr.write(report.stderr || report.stdout); process.exit(report.status || 1); }
writeFileSync(output, JSON.stringify({ outcome: 'completed', messageId, summary: 'fake completed' }));
`
    : behavior === 'claim-only'
      ? `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const prompt = readFileSync(0, 'utf8');
const messageId = prompt.match(/msg_[A-Za-z0-9_-]+/)?.[0];
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '019faaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' }) + '\\n');
writeFileSync(output, JSON.stringify({ outcome: 'completed', messageId, summary: 'claim only' }));
`
    : behavior === 'quota'
      ? `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '019f9999-bbbb-7ccc-8ddd-eeeeeeeeeeee' }) + '\\n');
process.stderr.write('429 provider quota exceeded\\n');
process.exit(1);
`
      : `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./fake-started.json', import.meta.url), JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 1000);
`;
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function enroll(t: test.TestContext, behavior: 'success' | 'claim-only' | 'quota' | 'timeout' = 'success', overrides: Record<string, unknown> = {}) {
  const item = await fixture(t, `agentlink-wake-${behavior}-`);
  const executable = await fakeCodex(item.root, behavior);
  const configPath = join(item.root, 'user', 'wake.json');
  const statePath = join(item.root, 'user', 'state');
  const trustPath = join(item.root, 'user', 'notifications.json');
  const config = await enrollCodexWake({
    recipientId: 'peer_headless',
    workspacePath: item.peer,
    conversationIds: [item.conversationId],
    configPath,
    statePath,
    trustPath,
    codexExecutable: executable,
    agentlinkCliEntrypoint: cliEntrypoint,
    model: 'gpt-5.6-sol',
    turnTimeoutMs: behavior === 'timeout' ? 75 : 2_000,
    retryBackoffMs: 1,
    maxAttempts: 2,
    ...overrides,
  });
  return { ...item, executable, configPath, statePath, trustPath, config };
}

test('re-enrollment preserves durable pending jobs and the original reconciliation baseline', async (t) => {
  const item = await enroll(t);
  const message = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'must survive re-enrollment', recipientParticipantId: item.peerParticipantId,
  });
  await enqueueCodexWake(item.configPath, refs(item.config, message.messageId!));

  const reEnrolled = await enrollCodexWake({
    recipientId: item.config.recipientId,
    workspacePath: item.peer,
    conversationIds: [item.conversationId],
    configPath: item.configPath,
    statePath: item.statePath,
    trustPath: item.trustPath,
    codexExecutable: item.executable,
    agentlinkCliEntrypoint: cliEntrypoint,
    model: 'gpt-5.6-sol',
    turnTimeoutMs: 2_000,
    retryBackoffMs: 1,
    maxAttempts: 2,
  });

  const status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.jobs.length, 1);
  assert.equal(status.jobs[0]?.messageId, message.messageId);
  assert.equal(status.jobs[0]?.state, 'pending');
  assert.equal(reEnrolled.enrolledSequences[item.conversationId], 0);
  assert.equal((await reconcileCodexWake(item.configPath)).queued, 0);
});

test('a model completion claim without an exact recipient-authored status reference stays unacknowledged', async (t) => {
  const item = await enroll(t, 'claim-only');
  const message = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'claim is not evidence', recipientParticipantId: item.peerParticipantId,
  });
  await enqueueCodexWake(item.configPath, refs(item.config, message.messageId!));

  const result = await runCodexWakeOnce(item.configPath);
  assert.equal(result.outcome, 'suspended');
  assert.match(result.detail!, /status message|completion evidence/i);
  assert.equal((await readMessages(item.peer, item.conversationId)).acknowledgedMessageId, undefined);
});

test('reconciliation runs lower sequences first and acknowledgement never crosses an incomplete gap', async (t) => {
  const item = await enroll(t);
  const first = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'first must run first', recipientParticipantId: item.peerParticipantId,
  });
  const second = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'second arrived at callback first', recipientParticipantId: item.peerParticipantId,
  });
  await enqueueCodexWake(item.configPath, refs(item.config, second.messageId!, 'second-first'));

  const firstRun = await runCodexWakeOnce(item.configPath);
  assert.equal(firstRun.outcome, 'completed');
  let status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.jobs.find((job) => job.messageId === first.messageId)?.state, 'completed');
  assert.equal(status.jobs.find((job) => job.messageId === second.messageId)?.state, 'pending');
  assert.equal((await readMessages(item.peer, item.conversationId)).acknowledgedMessageId, first.messageId);

  assert.equal((await runCodexWakeOnce(item.configPath)).outcome, 'completed');
  status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.jobs.find((job) => job.messageId === second.messageId)?.state, 'completed');
  assert.equal((await readMessages(item.peer, item.conversationId)).acknowledgedMessageId, second.messageId);
});

function refs(config: Awaited<ReturnType<typeof enroll>>['config'], messageId: string, suffix = '1') {
  return {
    eventId: `evt_${suffix}`,
    busId: config.busId,
    conversationId: config.conversationIds[0]!,
    messageId,
    registrationId: config.registrationId,
  };
}

test('enqueue is fast and separate from a serialized Codex run; success persists thread and exact acknowledgement', async (t) => {
  const item = await enroll(t);
  const first = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'first task', recipientParticipantId: item.peerParticipantId,
  });
  const second = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'second task', recipientParticipantId: item.peerParticipantId,
  });

  const started = Date.now();
  assert.equal((await enqueueCodexWake(item.configPath, refs(item.config, first.messageId!, 'one'))).outcome, 'queued');
  assert.ok(Date.now() - started < 500);
  assert.equal((await enqueueCodexWake(item.configPath, refs(item.config, second.messageId!, 'two'))).outcome, 'queued');

  const [left, right] = await Promise.all([runCodexWakeOnce(item.configPath), runCodexWakeOnce(item.configPath)]);
  assert.deepEqual([left.outcome, right.outcome].sort(), ['busy', 'completed']);
  assert.equal((await runCodexWakeOnce(item.configPath)).outcome, 'completed');

  const status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.counts.completed, 2);
  assert.equal(status.threadIds[item.conversationId], '019faaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
  const invocationLines = (await readFile(join(item.root, 'fake-invocations.jsonl'), 'utf8')).trim().split('\n');
  const invocations = invocationLines.map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert.equal(invocations.length, 2);
  assert.ok(invocations[0]!.args.includes('workspace-write'));
  assert.ok(invocations[0]!.args.includes(item.config.busPath));
  assert.equal(invocations[1]!.args[1], 'resume');
  assert.equal(invocations[1]!.args[2], status.threadIds[item.conversationId]);
  assert.doesNotMatch(invocations[0]!.args.join(' '), /first task/);
  assert.match(invocations[0]!.prompt, new RegExp(first.messageId!));
  const page = await readMessages(item.peer, item.conversationId, { limit: 20 });
  assert.equal(page.acknowledgedMessageId, second.messageId);
});

test('ordinary send automatically invokes an enrolled recipient without --notify', async (t) => {
  const item = await enroll(t);
  const previousTrust = process.env.AGENTLINK_TRUST_CONFIG;
  process.env.AGENTLINK_TRUST_CONFIG = item.trustPath;
  t.after(() => {
    if (previousTrust === undefined) delete process.env.AGENTLINK_TRUST_CONFIG;
    else process.env.AGENTLINK_TRUST_CONFIG = previousTrust;
  });
  const lines: string[] = [];
  await runCli([
    'send', '--conversation', item.conversationId, '--to', item.peerParticipantId,
    '--body', 'automatically queued task',
  ], item.source, { log: (line) => lines.push(line), error: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /Notification: attempted; delivered=1, failed=0/);
  const status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.counts.pending, 1);
});

test('routing validates provenance, suppresses duplicates, own sends, status noise, and other recipients', async (t) => {
  const item = await enroll(t);
  const task = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'routed task', recipientParticipantId: item.peerParticipantId,
  });
  assert.equal((await enqueueCodexWake(item.configPath, refs(item.config, task.messageId!))).outcome, 'queued');
  assert.equal((await enqueueCodexWake(item.configPath, refs(item.config, task.messageId!))).outcome, 'duplicate');
  await assert.rejects(enqueueCodexWake(item.configPath, { ...refs(item.config, task.messageId!), busId: 'wrong_bus' }), /bus/i);
  await assert.rejects(enqueueCodexWake(item.configPath, { ...refs(item.config, task.messageId!), registrationId: 'reg_wrong' }), /registration/i);

  const own = await appendMessage(item.peer, item.conversationId, { role: 'assistant', body: 'own result' });
  assert.equal((await enqueueCodexWake(item.configPath, refs(item.config, own.messageId!, 'own'))).outcome, 'ignored');
  const noise = await appendMessage(item.source, item.conversationId, { role: 'assistant', body: 'lifecycle only', kind: 'status' });
  assert.equal((await enqueueCodexWake(item.configPath, refs(item.config, noise.messageId!, 'noise'))).outcome, 'ignored');
  const other = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'not yours', recipientParticipantId: item.sourceParticipantId,
  });
  assert.equal((await enqueueCodexWake(item.configPath, refs(item.config, other.messageId!, 'other'))).outcome, 'ignored');
});

test('pause preserves queued work, stop is durable, and startup reconciliation recovers offline allowed messages', async (t) => {
  const item = await enroll(t);
  await setCodexWakePaused(item.configPath, true);
  const offline = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'persisted while listener offline', recipientParticipantId: item.peerParticipantId,
  });
  assert.equal((await reconcileCodexWake(item.configPath)).queued, 1);
  assert.equal((await runCodexWakeOnce(item.configPath)).outcome, 'paused');
  assert.equal((await readCodexWakeStatus(item.configPath)).counts.pending, 1);
  await setCodexWakePaused(item.configPath, false);
  assert.equal((await runCodexWakeOnce(item.configPath)).outcome, 'completed');
  assert.equal((await reconcileCodexWake(item.configPath)).queued, 0);
  assert.equal((await enqueueCodexWake(item.configPath, refs(item.config, offline.messageId!, 'again'))).outcome, 'duplicate');
  await requestCodexWakeStop(item.configPath);
  assert.equal((await runCodexWakeOnce(item.configPath)).outcome, 'stopped');
});

test('restart suspends an unacknowledged stale running job until explicit retry', async (t) => {
  const item = await enroll(t);
  const message = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'possibly side-effecting task', recipientParticipantId: item.peerParticipantId,
  });
  const queued = await enqueueCodexWake(item.configPath, refs(item.config, message.messageId!));
  const queuePath = join(item.statePath, 'queue.json');
  const state = JSON.parse(await readFile(queuePath, 'utf8')) as { jobs: Array<{ state: string; startedAt?: string }> };
  state.jobs[0]!.state = 'running';
  state.jobs[0]!.startedAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(queuePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  assert.equal((await runCodexWakeOnce(item.configPath)).outcome, 'idle');
  let status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.jobs[0]!.state, 'suspended');
  assert.match(status.jobs[0]!.lastError!, /side effects may have occurred/);
  await retryCodexWakeJob(item.configPath, queued.job!.jobId);
  assert.equal((await runCodexWakeOnce(item.configPath)).outcome, 'completed');
  status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.jobs[0]!.state, 'completed');
});

test('quota retries are bounded while timeout and malformed completion stay unacknowledged and suspended', async (t) => {
  const quota = await enroll(t, 'quota');
  const message = await appendMessage(quota.source, quota.conversationId, {
    role: 'user', body: 'quota task', recipientParticipantId: quota.peerParticipantId,
  });
  await enqueueCodexWake(quota.configPath, refs(quota.config, message.messageId!));
  assert.equal((await runCodexWakeOnce(quota.configPath)).outcome, 'retry_scheduled');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await runCodexWakeOnce(quota.configPath)).outcome, 'suspended');
  let status = await readCodexWakeStatus(quota.configPath);
  assert.equal(status.jobs[0]!.attempts, 2);
  assert.equal(status.jobs[0]!.state, 'suspended');
  assert.equal(status.threadIds[quota.conversationId], '019f9999-bbbb-7ccc-8ddd-eeeeeeeeeeee');
  assert.equal((await readMessages(quota.peer, quota.conversationId)).acknowledgedMessageId, undefined);
  await retryCodexWakeJob(quota.configPath, status.jobs[0]!.jobId);
  assert.equal((await readCodexWakeStatus(quota.configPath)).jobs[0]!.state, 'pending');

  const timeout = await enroll(t, 'timeout');
  const hanging = await appendMessage(timeout.source, timeout.conversationId, {
    role: 'user', body: 'timeout task', recipientParticipantId: timeout.peerParticipantId,
  });
  await enqueueCodexWake(timeout.configPath, refs(timeout.config, hanging.messageId!));
  assert.equal((await runCodexWakeOnce(timeout.configPath)).outcome, 'suspended');
  status = await readCodexWakeStatus(timeout.configPath);
  assert.match(status.jobs[0]!.lastError!, /timed out/i);
  assert.equal((await readMessages(timeout.peer, timeout.conversationId)).acknowledgedMessageId, undefined);
});

test('stop before child startup preserves pending work without acknowledgement', async (t) => {
  const item = await enroll(t, 'timeout');
  const message = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'do not start this turn', recipientParticipantId: item.peerParticipantId,
  });
  await enqueueCodexWake(item.configPath, refs(item.config, message.messageId!));
  await requestCodexWakeStop(item.configPath);
  assert.equal((await runCodexWakeOnce(item.configPath)).outcome, 'stopped');
  const status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.jobs[0]!.state, 'pending');
  assert.equal(status.jobs[0]!.attempts, 0);
  await assert.rejects(readFile(join(item.root, 'fake-started.json'), 'utf8'), { code: 'ENOENT' });
  assert.equal((await readMessages(item.peer, item.conversationId)).acknowledgedMessageId, undefined);
});

test('stop terminates only the supervised hanging child and leaves its message suspended and unacknowledged', async (t) => {
  const item = await enroll(t, 'timeout', { turnTimeoutMs: 15_000 });
  const message = await appendMessage(item.source, item.conversationId, {
    role: 'user', body: 'stop this turn', recipientParticipantId: item.peerParticipantId,
  });
  await enqueueCodexWake(item.configPath, refs(item.config, message.messageId!));
  const running = runCodexWakeOnce(item.configPath);
  let childPid: number | undefined;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const started = JSON.parse(await readFile(join(item.root, 'fake-started.json'), 'utf8')) as { pid: number };
        assert.ok(Number.isInteger(started.pid) && started.pid > 0);
        process.kill(started.pid, 0);
        childPid = started.pid;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(childPid, 'supervised child must actually start before exercising running-turn shutdown');
  } finally {
    await requestCodexWakeStop(item.configPath);
    await running;
  }
  const result = await running;
  assert.equal(result.outcome, 'suspended');
  assert.match(result.detail!, /shutdown/i);
  assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' });
  const status = await readCodexWakeStatus(item.configPath);
  assert.equal(status.jobs[0]!.state, 'suspended');
  assert.equal((await readMessages(item.peer, item.conversationId)).acknowledgedMessageId, undefined);
});

test('user-owned config, state, executable and canonical workspace reject unsafe symlink or cwd changes', async (t) => {
  const item = await enroll(t);
  const linkedConfig = join(item.root, 'linked-config.json');
  await symlink(item.configPath, linkedConfig);
  await assert.rejects(readCodexWakeStatus(linkedConfig), /symbolic link/i);

  const moved = `${item.peer}-moved`;
  await mkdir(moved);
  await assert.rejects(enrollCodexWake({
    recipientId: 'bad', workspacePath: moved, conversationIds: [item.conversationId],
    configPath: join(item.root, 'bad', 'config.json'), statePath: join(item.root, 'bad', 'state'),
    trustPath: join(item.root, 'bad', 'trust.json'), codexExecutable: item.executable,
    agentlinkCliEntrypoint: cliEntrypoint, model: 'gpt-5.6-sol',
  }), /conversation|bus|workspace/i);
});
