#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const evidenceFlag = process.argv.indexOf('--evidence-dir');
if (evidenceFlag === -1 || !process.argv[evidenceFlag + 1]) {
  console.error('Usage: node scripts/verify-auto-wake.mjs --evidence-dir <absolute-path> [--codex <absolute-path>]');
  process.exit(2);
}
const evidenceDirectory = resolve(process.argv[evidenceFlag + 1]);
const codexFlag = process.argv.indexOf('--codex');
const codexExecutable = resolve(codexFlag === -1 ? '/opt/homebrew/bin/codex' : process.argv[codexFlag + 1]);
const root = await mkdtemp(join(tmpdir(), 'agentlink-real-wake-'));
const source = join(root, 'source');
const peer = join(root, 'peer');
const prefix = join(root, 'prefix');
const user = join(root, 'user');
const cache = join(root, 'npm-cache');
const configPath = join(user, 'wake.json');
const statePath = join(user, 'state');
const trustPath = join(user, 'notifications.json');
const supervisorLog = join(root, 'supervisor.log');
const commandLog = join(root, 'commands.jsonl');
const resultPath = join(evidenceDirectory, 'auto-wake-e2e-summary.json');
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const stateEvidencePath = join(evidenceDirectory, `auto-wake-e2e-state-${nonce}`);
let supervisor;
let installedAgentlink = '';
let blockedReason;

function isProviderPrerequisiteBlock(message) {
  return /(?:429|quota|rate.?limit|too many requests|dns|network|connection (?:failed|refused)|failed to lookup|error sending request|request failed|provider unavailable)/i.test(message);
}

await mkdir(evidenceDirectory, { recursive: true });
await mkdir(source);
await mkdir(peer);
await mkdir(prefix);
await mkdir(user);
await mkdir(cache);

function commandString(command, args) {
  return [command, ...args].map((value) => JSON.stringify(value)).join(' ');
}

async function record(entry) {
  await writeFile(commandLog, `${await readFile(commandLog, 'utf8').catch(() => '')}${JSON.stringify(entry)}\n`, 'utf8');
}

async function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = await new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => resolveRun({ code: null, signal: null, stdout, stderr, error: error.message }));
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
  await record({ command: commandString(command, args), cwd: options.cwd ?? root, startedAt, durationMs: Date.now() - startedAt, ...result });
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(`${basename(command)} exited ${result.code}: ${result.stderr || result.stdout}`);
  }
  return { ...result, durationMs: Date.now() - startedAt };
}

async function status() {
  const result = await run(installedAgentlink, ['wake', 'status', '--config', configPath], { cwd: peer });
  return JSON.parse(result.stdout);
}

async function waitForJobCount(expected, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const current = await status();
    if (current.counts.completed >= expected) return current;
    const suspended = current.jobs.find((job) => job.state === 'suspended');
    if (suspended) {
      const detail = suspended.lastError || 'Codex job suspended without a diagnostic';
      throw Object.assign(new Error(detail), { blocked: isProviderPrerequisiteBlock(detail), status: current });
    }
    if (Date.now() - startedAt >= timeoutMs) throw Object.assign(new Error(`Timed out after ${timeoutMs}ms waiting for ${expected} completed jobs`), { blocked: false, status: current });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
}

async function startSupervisor() {
  const handle = await import('node:fs');
  const output = handle.openSync(supervisorLog, 'a');
  supervisor = spawn(installedAgentlink, ['wake', 'run', '--config', configPath], {
    cwd: peer,
    env: { ...process.env, AGENTLINK_TRUST_CONFIG: trustPath },
    detached: false,
    shell: false,
    stdio: ['ignore', output, output],
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  if (supervisor.exitCode !== null) throw new Error(`Supervisor exited early with code ${supervisor.exitCode}`);
}

async function stopSupervisor() {
  if (!supervisor || supervisor.exitCode !== null) return;
  await run(installedAgentlink, ['wake', 'stop', '--config', configPath], { cwd: peer, allowFailure: true });
  await Promise.race([
    new Promise((resolveWait) => supervisor.once('exit', resolveWait)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (supervisor.exitCode === null) supervisor.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveWait) => supervisor.once('exit', resolveWait)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
}

const summary = {
  schemaVersion: 1,
  nonce,
  tempRoot: root,
  startedAt: new Date().toISOString(),
  result: 'FAIL',
  supportBoundary: 'supervised/headless Codex only; arbitrary GUI/interactive Codex, Claude, tmux, and IDE wake unverified',
  stateEvidencePath,
};

try {
  await access(codexExecutable).catch((error) => {
    throw Object.assign(new Error(`Codex executable unavailable at ${codexExecutable}: ${error.message}`), { blocked: true });
  });
  await run('git', ['init', '-q'], { cwd: source });
  await run('git', ['init', '-q'], { cwd: peer });

  const packed = await run('npm', ['pack', '--pack-destination', root, '--json'], {
    cwd: process.cwd(), env: { npm_config_cache: cache },
  });
  const packData = JSON.parse(packed.stdout);
  const tarball = join(root, packData[0].filename);
  summary.tarball = packData[0].filename;
  await run('npm', ['install', '--global', '--prefix', prefix, tarball], { env: { npm_config_cache: cache } });
  installedAgentlink = join(prefix, 'bin', 'agentlink');
  summary.installedAgentlink = installedAgentlink;

  await run(installedAgentlink, ['init'], { cwd: source });
  await run(installedAgentlink, ['init'], { cwd: peer });
  const started = await run(installedAgentlink, ['start', '--topic', `Auto wake ${nonce}`], { cwd: source });
  const conversationId = started.stdout.match(/Started conversation ([A-Za-z0-9_-]+)/)?.[1];
  if (!conversationId) throw new Error(`Could not parse conversation id: ${started.stdout}`);
  summary.conversationId = conversationId;
  await run(installedAgentlink, ['contract', '--conversation', conversationId, '--sync-to', peer], { cwd: source });
  await run(installedAgentlink, ['join', '--conversation', conversationId], { cwd: peer });
  const actor = await run(installedAgentlink, ['actor', 'show'], { cwd: peer });
  const participantId = actor.stdout.trim().split(/\s+/)[0];
  summary.recipientParticipantId = participantId;
  await run(installedAgentlink, [
    'wake', 'enroll', '--recipient', 'real_peer_codex', '--conversation', conversationId,
    '--codex', codexExecutable, '--model', 'gpt-5.6-sol', '--config', configPath,
    '--state', statePath, '--trust-config', trustPath, '--timeout-ms', '120000',
    '--retry-backoff-ms', '2000', '--max-attempts', '2', '--poll-ms', '250', '--ttl', '60',
  ], { cwd: peer, env: { AGENTLINK_TRUST_CONFIG: trustPath } });

  summary.before = {
    firstArtifactExists: await access(join(peer, `auto-wake-${nonce}-one.txt`)).then(() => true).catch(() => false),
    status: await status(),
    activeAgentTurn: false,
  };
  if (summary.before.firstArtifactExists || summary.before.status.jobs.length !== 0) throw new Error('Recipient was not idle before the first send');
  await startSupervisor();

  const firstBody = `Create auto-wake-${nonce}-one.txt in this repository with exact content FIRST-${nonce} followed by a newline. Then report completion.`;
  const firstSend = await run(installedAgentlink, [
    'send', '--conversation', conversationId, '--to', participantId, '--body', firstBody,
  ], { cwd: source, env: { AGENTLINK_TRUST_CONFIG: trustPath } });
  summary.firstSendDurationMs = firstSend.durationMs;
  summary.firstMessageId = firstSend.stdout.match(/Persisted message (msg_[A-Za-z0-9_-]+)/)?.[1];
  if (!summary.firstMessageId || firstSend.durationMs > 10_000) throw new Error('First send did not return promptly with a durable message id');
  const afterFirst = await waitForJobCount(1, 150_000);
  const firstBytes = await readFile(join(peer, `auto-wake-${nonce}-one.txt`), 'utf8');
  if (firstBytes !== `FIRST-${nonce}\n`) throw new Error(`First artifact bytes mismatch: ${JSON.stringify(firstBytes)}`);
  const firstJob = afterFirst.jobs.find((job) => job.messageId === summary.firstMessageId);
  if (!firstJob?.threadId || !firstJob.transcriptPath) throw new Error('First completed job lacks real thread/transcript evidence');
  summary.threadId = firstJob.threadId;
  summary.firstJob = firstJob;
  await stopSupervisor();

  const secondBody = `Create auto-wake-${nonce}-two.txt in this repository with exact content SECOND-${nonce} followed by a newline. Then report completion.`;
  const secondSend = await run(installedAgentlink, [
    'send', '--conversation', conversationId, '--to', participantId, '--body', secondBody,
  ], { cwd: source, env: { AGENTLINK_TRUST_CONFIG: trustPath } });
  summary.secondSendDurationMs = secondSend.durationMs;
  summary.secondMessageId = secondSend.stdout.match(/Persisted message (msg_[A-Za-z0-9_-]+)/)?.[1];
  const pending = await status();
  const secondJob = pending.jobs.find((job) => job.messageId === summary.secondMessageId);
  if (!secondJob || secondJob.state !== 'pending') throw new Error('Second message was not durably queued while supervisor was stopped');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const duplicate = await run(installedAgentlink, [
    'wake', 'enqueue', '--config', configPath, '--event-id', 'evt_manual_duplicate',
    '--bus-id', config.busId, '--conversation-id', conversationId, '--message-id', summary.secondMessageId,
    '--registration-id', config.registrationId,
  ], { cwd: peer });
  if (!/Wake enqueue: duplicate/.test(duplicate.stdout)) throw new Error(`Duplicate enqueue was not deduplicated: ${duplicate.stdout}`);
  await startSupervisor();
  const afterSecond = await waitForJobCount(2, 150_000);
  const secondBytes = await readFile(join(peer, `auto-wake-${nonce}-two.txt`), 'utf8');
  if (secondBytes !== `SECOND-${nonce}\n`) throw new Error(`Second artifact bytes mismatch: ${JSON.stringify(secondBytes)}`);
  const completedSecond = afterSecond.jobs.find((job) => job.messageId === summary.secondMessageId);
  if (completedSecond?.threadId !== summary.threadId) throw new Error('Second task did not resume the saved conversation thread');
  summary.secondJob = completedSecond;
  summary.finalStatus = afterSecond;
  const acknowledgementPath = join(config.busPath, 'acknowledgements', conversationId, `${participantId}.json`);
  const acknowledgement = JSON.parse(await readFile(acknowledgementPath, 'utf8'));
  if (acknowledgement.acknowledgedMessageId !== summary.secondMessageId) {
    throw new Error(`Durable acknowledgement did not name the second message: ${JSON.stringify(acknowledgement)}`);
  }
  const timeline = (await readFile(join(config.busPath, 'conversations', `${conversationId}.jsonl`), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  const resultMessage = timeline.find((record) => record.type === 'message'
    && record.participantId === participantId
    && record.kind === 'status'
    && record.refs?.some((ref) => ref.type === 'msg_id' && ref.value === summary.secondMessageId));
  if (!resultMessage || completedSecond?.resultMessageId !== resultMessage.messageId) {
    throw new Error('Second task lacks a matching durable recipient-authored result checkpoint');
  }
  summary.ackEvidence = { acknowledgement, resultMessage };
  summary.result = 'PASS';
} catch (error) {
  blockedReason = error instanceof Error ? error.message : String(error);
  summary.error = blockedReason;
  summary.result = error?.blocked === true || isProviderPrerequisiteBlock(blockedReason) ? 'BLOCKED' : 'FAIL';
  if (error?.status) summary.failureStatus = error.status;
} finally {
  await stopSupervisor().catch(() => undefined);
  summary.finishedAt = new Date().toISOString();
  await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await cp(commandLog, join(evidenceDirectory, 'auto-wake-e2e-commands.jsonl')).catch(() => undefined);
  await cp(supervisorLog, join(evidenceDirectory, 'auto-wake-e2e-supervisor.log')).catch(() => undefined);
  await cp(statePath, stateEvidencePath, { recursive: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.result === 'PASS' ? 0 : summary.result === 'BLOCKED' ? 2 : 1;
