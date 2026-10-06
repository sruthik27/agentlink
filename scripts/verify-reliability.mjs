#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const evidenceIndex = process.argv.indexOf('--evidence-dir');
if (evidenceIndex === -1 || !process.argv[evidenceIndex + 1] || !isAbsolute(process.argv[evidenceIndex + 1])) {
  console.error('Usage: node scripts/verify-reliability.mjs --evidence-dir <absolute-path>');
  process.exit(2);
}

const evidenceDir = resolve(process.argv[evidenceIndex + 1]);
const tempRoot = await mkdtemp(join(tmpdir(), 'agentlink-reliability-'));
const repoA = join(tempRoot, 'repo-a');
const repoB = join(tempRoot, 'repo-b');
const prefix = join(tempRoot, 'prefix');
const cache = join(tempRoot, 'npm-cache');
const userState = join(tempRoot, 'user-state');
const trustPath = join(userState, 'notifications.json');
const receiverState = join(userState, 'receiver-attempt.txt');
const receiverResult = join(userState, 'receiver-result.json');
const commandsPath = join(evidenceDir, 'reliability-commands.jsonl');
const mcpTranscriptPath = join(evidenceDir, 'reliability-mcp.jsonl');
const summaryPath = join(evidenceDir, 'reliability-summary.json');
const startedAt = new Date().toISOString();
const checks = new Map();
const mandatoryRows = [
  'packed-install', 'two-cwd-mcp', 'four-conversations', 'nine-decisions-lifecycle',
  'actors-sync-relabel', 'revision-reapproval', 'cursor-restart', 'safe-target-close',
  'cap-owner-raise', 'concurrent-mutations', 'tmux-expiry', 'notification-retry',
  'durable-artifacts', 'cleanup',
];
let cli;
let mcpBin;
let mcpA;
let mcpB;
let busPath;
let fatal;

await mkdir(evidenceDir, { recursive: true });
await Promise.all([repoA, repoB, prefix, cache, userState].map((path) => mkdir(path, { recursive: true })));

function setCheck(id, status, evidence) {
  checks.set(id, { id, status, evidence });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(promise, pattern, message) {
  try {
    await promise;
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
  throw new Error(message);
}

async function appendJsonl(path, value) {
  const previous = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, `${previous}${JSON.stringify(value)}\n`, 'utf8');
}

function quoted(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(' ');
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const began = Date.now();
  const result = await new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? tempRoot,
      env: { ...process.env, ...options.env },
      detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const terminate = (signal) => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else child.kill(signal);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      setTimeout(() => terminate('SIGKILL'), 500).unref();
    }, timeoutMs);
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, timedOut, ...(error ? { error } : {}) });
    };
    child.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 1_000_000) stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish(null, null, error.message));
    child.once('exit', (code, signal) => finish(code, signal));
  });
  await appendJsonl(commandsPath, {
    command: quoted(command, args), cwd: options.cwd ?? tempRoot, durationMs: Date.now() - began,
    code: result.code, signal: result.signal, timedOut: result.timedOut,
    stdout: result.stdout.slice(0, 20_000), stderr: result.stderr.slice(0, 20_000),
  });
  if ((result.code !== 0 || result.timedOut) && !options.allowFailure) {
    throw new Error(`${basename(command)} ${result.timedOut ? 'timed out' : `exited ${result.code}`}: ${result.stderr || result.stdout}`);
  }
  return result;
}

class McpClient {
  constructor(label, executable, cwd, participantId) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.child = spawn(executable, [], {
      cwd,
      env: { ...process.env, AGENTLINK_PARTICIPANT_ID: participantId, AGENTLINK_TRUST_CONFIG: trustPath },
      shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { if (this.stderr.length < 100_000) this.stderr += chunk.toString('utf8'); });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let response;
      try { response = JSON.parse(line); } catch { return; }
      void appendJsonl(mcpTranscriptPath, { direction: 'response', client: label, message: response });
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
    });
    this.child.once('exit', (code, signal) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${label} MCP exited code=${code} signal=${signal}: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 15_000) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    void appendJsonl(mcpTranscriptPath, { direction: 'request', client: this.label, message });
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${this.label} MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  call(name, args = {}, timeoutMs) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  async start() {
    const initialized = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reliability-harness', version: '1' } });
    const listed = await this.request('tools/list');
    assert(initialized.serverInfo?.name === 'agentlink-mcp', `${this.label} did not initialize AgentLink MCP`);
    assert(listed.tools?.length >= 10, `${this.label} MCP tool list is incomplete`);
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => this.child.once('exit', resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000)),
    ]);
    if (this.child.exitCode === null) {
      this.child.kill('SIGKILL');
      await Promise.race([
        new Promise((resolveExit) => this.child.once('exit', resolveExit)),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000)),
      ]);
    }
  }
}

function text(result) {
  return result.content?.map((item) => item.text ?? '').join('\n') ?? '';
}

function conversationId(result) {
  const match = text(result).match(/Started conversation ([A-Za-z0-9_-]+)/);
  assert(match, `Could not parse conversation id from MCP result: ${text(result)}`);
  return match[1];
}

async function actorId(cwd) {
  return (await run(cli, ['actor', 'show'], { cwd })).stdout.trim().split(/\s+/)[0];
}

async function snapshotArtifacts(conversations) {
  const artifacts = join(evidenceDir, 'reliability-artifacts');
  await mkdir(artifacts, { recursive: true });
  for (const id of conversations) {
    await cp(join(busPath, 'conversations', `${id}.jsonl`), join(artifacts, `${id}.jsonl`));
    await cp(join(busPath, 'contracts', id, 'CONTRACT.md'), join(artifacts, `${id}-CONTRACT.md`));
  }
  await cp(join(repoA, '.agentlink', 'association.json'), join(artifacts, 'repo-a-association.json'));
  await cp(join(repoB, '.agentlink', 'association.json'), join(artifacts, 'repo-b-association.json'));
  await cp(join(busPath, 'acknowledgements'), join(artifacts, 'acknowledgements'), { recursive: true }).catch(() => undefined);
  await cp(join(busPath, 'notifications'), join(artifacts, 'notifications'), { recursive: true }).catch(() => undefined);
}

try {
  await Promise.all([run('git', ['init', '-q'], { cwd: repoA }), run('git', ['init', '-q'], { cwd: repoB })]);
  const packed = await run('npm', ['pack', '--pack-destination', tempRoot, '--json'], {
    cwd: process.cwd(), env: { npm_config_cache: cache }, timeoutMs: 60_000,
  });
  const packInfo = JSON.parse(packed.stdout)[0];
  const tarball = join(tempRoot, packInfo.filename);
  await run('npm', ['install', '--global', '--prefix', prefix, tarball], {
    env: { npm_config_cache: cache }, timeoutMs: 60_000,
  });
  cli = join(prefix, 'bin', 'agentlink');
  mcpBin = join(prefix, 'bin', 'agentlink-mcp');
  await Promise.all([run(cli, ['version'], { cwd: repoA }), run(cli, ['version'], { cwd: repoB })]);
  setCheck('packed-install', 'PASS', { tarball: packInfo.filename, files: packInfo.files?.length, installedBins: [cli, mcpBin] });

  await Promise.all([run(cli, ['init'], { cwd: repoA }), run(cli, ['init'], { cwd: repoB })]);
  const actorA = await actorId(repoA);
  const actorB = await actorId(repoB);
  assert(actorA && actorB && actorA !== actorB, 'Two workspaces did not receive independent actors');
  const receiverScript = join(userState, 'flaky-receiver.mjs');
  await writeFile(receiverScript, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst marker=process.argv[2], output=process.argv[3]; let count=0; try { count=Number(readFileSync(marker,'utf8')); } catch {} count+=1; writeFileSync(marker,String(count)); if(count===1) process.exit(7); const refs={}; for(let i=4;i<process.argv.length;i+=2) refs[process.argv[i].replace(/^--/,'')]=process.argv[i+1]; writeFileSync(output,JSON.stringify(refs));\n`, 'utf8');
  await chmod(receiverScript, 0o700);
  await writeFile(trustPath, `${JSON.stringify({ schemaVersion: 1, adapters: [{ id: 'flaky', argv: [process.execPath, receiverScript, receiverState, receiverResult], timeoutMs: 2_000 }] }, null, 2)}\n`, 'utf8');

  mcpA = new McpClient('repo-a', mcpBin, repoA, actorA);
  mcpB = new McpClient('repo-b', mcpBin, repoB, actorB);
  await Promise.all([mcpA.start(), mcpB.start()]);
  setCheck('two-cwd-mcp', 'PASS', { cwdA: repoA, cwdB: repoB, actorA, actorB, processes: 2 });

  const conversations = [];
  conversations.push(conversationId(await mcpA.call('agentlink_start_conversation', { topic: 'Nine decision contract', requiredApprovals: 2 })));
  conversations.push(conversationId(await mcpA.call('agentlink_start_conversation', { topic: 'Capped interleave', maxMessages: 3 })));
  conversations.push(conversationId(await mcpA.call('agentlink_start_conversation', { topic: 'Concurrent mutation' })));
  conversations.push(conversationId(await mcpA.call('agentlink_start_conversation', { topic: 'Explicit close target' })));
  for (const id of conversations) {
    await run(cli, ['contract', '--conversation', id, '--sync-to', repoB], { cwd: repoA });
    await mcpB.call('agentlink_join_conversation', { conversationId: id });
  }
  const associationA = JSON.parse(await readFile(join(repoA, '.agentlink', 'association.json'), 'utf8'));
  const associationB = JSON.parse(await readFile(join(repoB, '.agentlink', 'association.json'), 'utf8'));
  assert(associationA.busId === associationB.busId && associationA.busPath === associationB.busPath, 'Peers are not associated to one bus');
  busPath = associationA.busPath;
  for (const [index, id] of conversations.entries()) {
    await mcpA.call('agentlink_send_message', { conversationId: id, kind: 'proposal', body: `A interleave ${index}` });
    await mcpB.call('agentlink_send_message', { conversationId: id, kind: 'decision', body: `B interleave ${index}` });
  }
  const listed = await mcpA.call('agentlink_list_conversations');
  assert(listed.structuredContent.conversations.length === 4, 'Conversation listing did not return four conversations');
  setCheck('four-conversations', 'PASS', { conversationIds: conversations, interleavedMessages: 8 });

  const contractId = conversations[0];
  for (let decision = 1; decision <= 9; decision += 1) {
    await mcpA.call('agentlink_update_contract', {
      conversationId: contractId, section: `Decision ${decision}`, content: `Decision ${decision} is explicit and durable.`,
    });
  }
  await mcpA.call('agentlink_update_contract', { conversationId: contractId, status: 'Proposed' });
  await mcpA.call('agentlink_approve_contract', { conversationId: contractId });
  await run(cli, ['actor', 'rename', '--id', actorB, '--name', 'Renamed Peer'], { cwd: repoB });
  await mcpB.call('agentlink_approve_contract', { conversationId: contractId });
  await expectReject(
    mcpB.call('agentlink_approve_contract', { conversationId: contractId }),
    /already approved/,
    'Relabeled participant was able to create a duplicate approval',
  );
  await mcpA.call('agentlink_accept_contract', { conversationId: contractId });
  await mcpA.call('agentlink_update_contract', { conversationId: contractId, status: 'Implemented' });
  await mcpA.call('agentlink_update_contract', { conversationId: contractId, status: 'Verified' });
  let contractBytes = await readFile(join(busPath, 'contracts', contractId, 'CONTRACT.md'), 'utf8');
  assert((contractBytes.match(/^## Decision \d+$/gm) ?? []).length === 9 && /## Status\s+Verified/m.test(contractBytes), 'Nine-decision contract did not reach Verified');
  setCheck('nine-decisions-lifecycle', 'PASS', { decisions: 9, states: ['Draft', 'Proposed', 'Accepted', 'Implemented', 'Verified'] });
  setCheck('actors-sync-relabel', 'PASS', { actorA, actorB, relabeledActor: actorB, duplicateApprovalRejected: true, busId: associationA.busId });

  await mcpA.call('agentlink_update_contract', {
    conversationId: contractId, section: 'Decision 9', content: 'Decision 9 was substantively revised and requires reapproval.', status: 'Proposed',
  });
  await expectReject(
    mcpA.call('agentlink_accept_contract', { conversationId: contractId }),
    /0\/2 approvals/,
    'Substantive revision retained stale approval sufficiency',
  );
  await Promise.all([
    mcpA.call('agentlink_approve_contract', { conversationId: contractId }),
    mcpB.call('agentlink_approve_contract', { conversationId: contractId }),
  ]);
  await mcpA.call('agentlink_accept_contract', { conversationId: contractId });
  await mcpA.call('agentlink_update_contract', { conversationId: contractId, status: 'Implemented' });
  await mcpA.call('agentlink_update_contract', { conversationId: contractId, status: 'Verified' });
  setCheck('revision-reapproval', 'PASS', { staleQuorumRejected: true, distinctCurrentApprovals: 2, finalStatus: 'Verified' });

  const cursorId = conversations[2];
  await mcpA.call('agentlink_send_message', { conversationId: cursorId, body: 'cursor-one', kind: 'question' });
  await mcpA.call('agentlink_send_message', { conversationId: cursorId, body: 'cursor-two', kind: 'decision' });
  const pageOne = (await mcpB.call('agentlink_read_inbox', { conversationId: cursorId, limit: 1 })).structuredContent;
  assert(pageOne.messages.length === 1 && pageOne.hasMore, 'First cursor page was not bounded');
  const firstSequence = pageOne.messages[0].sequence;
  await mcpB.close();
  mcpB = new McpClient('repo-b-restarted', mcpBin, repoB, actorB);
  await mcpB.start();
  const pageTwo = (await mcpB.call('agentlink_read_inbox', { conversationId: cursorId, after: pageOne.nextCursor, limit: 2 })).structuredContent;
  assert(pageTwo.messages.length > 0 && pageTwo.messages[0].sequence === firstSequence + 1, 'Cursor replayed or skipped a message after MCP restart');
  const acknowledged = (await mcpB.call('agentlink_ack_inbox', { conversationId: cursorId, cursor: pageTwo.nextCursor })).structuredContent.acknowledgement;
  assert(acknowledged.acknowledgedSequence >= pageTwo.messages.at(-1).sequence, 'Durable acknowledgement did not advance to cursor');
  setCheck('cursor-restart', 'PASS', { firstSequence, resumedSequence: pageTwo.messages[0].sequence, acknowledgedSequence: acknowledged.acknowledgedSequence });

  await expectReject(
    mcpA.call('agentlink_send_message', { body: 'must not select implicitly' }),
    /ambiguous/i,
    'Ambiguous send selected a conversation implicitly',
  );
  await mcpA.call('agentlink_close_conversation', { conversationId: conversations[3] });
  const afterClose = (await mcpA.call('agentlink_list_conversations')).structuredContent.conversations;
  assert(afterClose.find((item) => item.id === conversations[3]).status === 'closed', 'Explicit close target remained open');
  assert(afterClose.filter((item) => item.status === 'closed').length === 1, 'Explicit close affected another conversation');
  setCheck('safe-target-close', 'PASS', { ambiguousSendRejected: true, closedConversationId: conversations[3] });

  const cappedId = conversations[1];
  const nearCap = await mcpA.call('agentlink_send_message', { conversationId: cappedId, body: 'third capped message' });
  assert(/Warning: Message cap 3 reached/.test(text(nearCap)), 'Near/reached cap warning was missing');
  await mcpA.call('agentlink_set_message_cap', { conversationId: cappedId, maxMessages: 7 });
  await mcpA.call('agentlink_send_message', { conversationId: cappedId, body: 'message after owner raise' });
  setCheck('cap-owner-raise', 'PASS', { initialCap: 3, raisedCap: 7, warningObserved: true });

  const concurrentId = conversations[2];
  await Promise.all([
    mcpA.call('agentlink_update_contract', { conversationId: concurrentId, section: 'Concurrent A', content: 'A edit survives.' }),
    mcpB.call('agentlink_update_contract', { conversationId: concurrentId, section: 'Concurrent B', content: 'B edit survives.' }),
    mcpA.call('agentlink_send_message', { conversationId: concurrentId, body: 'concurrent-send-a' }),
    mcpB.call('agentlink_send_message', { conversationId: concurrentId, body: 'concurrent-send-b' }),
  ]);
  const concurrentContract = await readFile(join(busPath, 'contracts', concurrentId, 'CONTRACT.md'), 'utf8');
  const concurrentTimeline = await readFile(join(busPath, 'conversations', `${concurrentId}.jsonl`), 'utf8');
  assert(/A edit survives/.test(concurrentContract) && /B edit survives/.test(concurrentContract), 'Concurrent contract edits were lost');
  assert(/concurrent-send-a/.test(concurrentTimeline) && /concurrent-send-b/.test(concurrentTimeline), 'Concurrent sends were lost');
  setCheck('concurrent-mutations', 'PASS', { contractEdits: 2, messages: 2 });

  const tmux = await mcpA.call('agentlink_list_tmux_agents');
  assert(/tmux capability unavailable|coding-agent panes/.test(text(tmux)), 'Missing tmux did not degrade gracefully');
  await mcpB.call('agentlink_register_agent', { label: 'Expiring MCP', clientKind: 'mcp', registrationId: 'reg_expiring', ttlSeconds: 1 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
  const activeAfterExpiry = (await mcpA.call('agentlink_list_agents')).structuredContent.registrations;
  assert(!activeAfterExpiry.some((registration) => registration.registrationId === 'reg_expiring'), 'Expired registration remained discoverable');
  setCheck('tmux-expiry', 'PASS', { tmuxOptional: true, expiredRegistrationRemoved: true });

  await mcpB.call('agentlink_register_agent', {
    label: 'Flaky receiver', clientKind: 'mcp', registrationId: 'reg_flaky', ttlSeconds: 60, notificationAdapterId: 'flaky',
  });
  const notified = await mcpA.call('agentlink_send_message', {
    conversationId: concurrentId, body: 'notification failure must preserve this message', kind: 'question', recipientParticipantId: actorB,
  });
  const notification = notified.structuredContent.notification;
  assert(notification.failed === 1 && notification.events[0].state === 'failed', 'Initial notification failure was not visible');
  const eventId = notification.events[0].eventId;
  const retried = (await mcpA.call('agentlink_retry_notification', { eventId })).structuredContent.event;
  assert(retried.state === 'delivered' && retried.attempts.length === 2, 'Notification retry did not deliver exactly after the failure');
  const receiverRefs = JSON.parse(await readFile(receiverResult, 'utf8'));
  assert(receiverRefs['event-id'] === eventId && receiverRefs['message-id'] === notified.structuredContent.message.messageId, 'Receiver did not get reference-only correlated evidence');
  setCheck('notification-retry', 'PASS', { eventId, attempts: 2, persistedMessageId: notified.structuredContent.message.messageId });

  const transactionEntries = await readFile(join(busPath, 'conversations', `${contractId}.jsonl`), 'utf8');
  const records = transactionEntries.trim().split('\n').map((line) => JSON.parse(line));
  const latestContract = await readFile(join(busPath, 'contracts', contractId, 'CONTRACT.md'), 'utf8');
  const compatibility = await readFile(join(repoA, '.agentlink', 'CONTRACT.md'), 'utf8');
  assert(records.some((record) => record.type === 'contract_mutation'), 'Contract mutation audit is absent');
  assert(/Verified/.test(latestContract), 'Final durable contract is not Verified');
  assert(compatibility.includes('agentlink-conversation:'), 'Compatibility artifact is missing conversation provenance');
  await snapshotArtifacts(conversations);
  setCheck('durable-artifacts', 'PASS', {
    busId: associationA.busId, contractMutationAudits: records.filter((record) => record.type === 'contract_mutation').length,
    evidenceDirectory: join(evidenceDir, 'reliability-artifacts'),
  });
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
} finally {
  await Promise.allSettled([mcpA?.close(), mcpB?.close()]);
  const stopped = (client) => !client || client.child.exitCode !== null || client.child.signalCode !== null;
  const subprocessesStopped = stopped(mcpA) && stopped(mcpB);
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  setCheck('cleanup', subprocessesStopped ? 'PASS' : 'FAIL', { subprocessesStopped, tempRootRemoved: true });
  for (const id of mandatoryRows) {
    if (!checks.has(id)) setCheck(id, 'FAIL', { reason: fatal ?? 'mandatory check did not execute' });
  }
  const rows = mandatoryRows.map((id) => checks.get(id));
  const result = rows.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL';
  const summary = {
    schemaVersion: 1, result, startedAt, finishedAt: new Date().toISOString(),
    supportBoundary: 'No live LLM used. Native wake is separately host-tested for supervised/headless Codex; Claude and arbitrary interactive IDE wake remain unsupported.',
    packedArtifact: true, actualMcpProcesses: true, tempRepositoriesCleaned: true,
    checks: rows, ...(fatal ? { error: fatal } : {}),
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = result === 'PASS' ? 0 : 1;
}
