#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { pairPeer, exposeAgent } from '../dist/network/config.js';
import { exportPublicIdentity, initializeNodeIdentity, loadNodeIdentity } from '../dist/network/identity.js';
import { readMailboxState } from '../dist/network/mailbox.js';
import { startNetworkServer } from '../dist/network/server.js';
import { addGrant, addTrustedPeer } from '../dist/network/trust.js';
import { initializeWorkspaceIdentity, resolveActiveParticipant } from '../dist/workspace.js';

const scriptPath = fileURLToPath(import.meta.url);
const mcpPath = fileURLToPath(new URL('../dist/mcp/server.js', import.meta.url));

async function ensureIdentity(stateRoot, nodeId) {
  try { return await loadNodeIdentity(stateRoot); }
  catch (error) {
    if (!/ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return await initializeNodeIdentity(stateRoot, nodeId);
  }
}

async function runNode(stateRoot, nodeId) {
  await ensureIdentity(stateRoot, nodeId);
  const identity = await exportPublicIdentity(stateRoot);
  let running;
  const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  reply({ ready: true, pid: process.pid, identity });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let command;
    try {
      command = JSON.parse(line);
      let result;
      if (command.action === 'pair') {
        result = await pairPeer(stateRoot, command.input);
      } else if (command.action === 'trust') {
        result = await addTrustedPeer(stateRoot, command.input);
      } else if (command.action === 'expose') {
        result = await exposeAgent(stateRoot, command.input);
      } else if (command.action === 'grant') {
        result = await addGrant(stateRoot, command.input);
      } else if (command.action === 'start') {
        running = await startNetworkServer({ stateRoot, host: '127.0.0.1', port: command.input?.port ?? 0 });
        result = { port: running.port };
      } else if (command.action === 'stop') {
        if (running) await running.close();
        running = undefined;
        result = true;
      } else if (command.action === 'mailbox') {
        result = await readMailboxState(stateRoot);
      } else if (command.action === 'shutdown') {
        if (running) await running.close();
        reply({ id: command.id, ok: true, result: true });
        return;
      } else {
        throw new Error(`Unknown node action: ${command.action}`);
      }
      reply({ id: command.id, ok: true, result });
    } catch (error) {
      reply({ id: command?.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (running) await running.close();
}

class ChildNode {
  constructor(stateRoot, nodeId) {
    this.nextId = 1;
    this.pending = new Map();
    this.process = spawn(process.execPath, [scriptPath, '--node', stateRoot, nodeId], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', (chunk) => process.stderr.write(chunk));
    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${nodeId} initialization timed out`)), 30_000);
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.ready) { clearTimeout(timer); resolve(message); return; }
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error));
        } catch (error) {
          process.stderr.write(`node protocol error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      });
    });
    this.exited = new Promise((resolve) => this.process.once('exit', resolve));
  }

  command(action, input) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${action} timed out`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, action, ...(input === undefined ? {} : { input }) })}\n`);
    });
  }

  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await this.command('shutdown').catch(() => undefined);
    this.process.stdin.end();
    if (await this.wait(2_000)) return;
    this.process.kill('SIGTERM');
    if (await this.wait(2_000)) return;
    this.process.kill('SIGKILL');
    assert.equal(await this.wait(2_000), true, 'node process cleanup');
  }

  async wait(ms) {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return true;
    return await Promise.race([this.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
  }
}

function rawCertificateFingerprint(raw) {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

// Deliberately independent of src/network/a2a.ts client helpers and validators.
async function rawA2A({ stateRoot, peer, endpoint, method = 'POST', version = '1.0', requestBody }) {
  const local = await loadNodeIdentity(stateRoot);
  const payload = requestBody === undefined ? undefined : JSON.stringify(requestBody);
  return await new Promise((resolve, reject) => {
    const req = request(endpoint, {
      method, cert: local.certificatePem, key: local.privateKeyPem, ca: peer.certificatePem,
      checkServerIdentity: (_host, certificate) => !certificate.raw || rawCertificateFingerprint(certificate.raw) !== peer.fingerprint
        ? new Error('independent client rejected unpinned certificate') : undefined,
      headers: {
        'a2a-version': version,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(5_000, () => req.destroy(new Error('independent A2A request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

function independentlyValidateAgentCard(card) {
  assert.equal(typeof card, 'object');
  for (const field of ['name', 'description', 'supportedInterfaces', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) {
    assert.equal(Object.hasOwn(card, field), true, `card missing ${field}`);
  }
  assert.equal(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0, true);
  for (const agentInterface of card.supportedInterfaces) {
    assert.equal(new URL(agentInterface.url).protocol, 'https:');
    assert.equal(agentInterface.protocolBinding, 'JSONRPC');
    assert.equal(agentInterface.protocolVersion, '1.0');
    assert.equal(typeof agentInterface.tenant === 'string' && agentInterface.tenant.length > 0, true);
  }
  assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: false, extendedAgentCard: false });
  assert.equal(typeof card.securitySchemes?.mutualTls?.mtlsSecurityScheme?.description, 'string');
  assert.deepEqual(card.securityRequirements, [{ schemes: { mutualTls: [] } }]);
  assert.deepEqual(card.defaultInputModes, ['text/plain']);
  assert.deepEqual(card.defaultOutputModes, ['text/plain']);
  assert.equal(Array.isArray(card.skills) && card.skills.length === 1, true);
  return card;
}

async function discoverAgentInterface({ stateRoot, peer, baseAddress, agentName }) {
  const discovered = await rawA2A({
    stateRoot, peer, method: 'GET', endpoint: `${baseAddress}/.well-known/agent-card.json`,
  });
  assert.equal(discovered.statusCode, 200);
  const card = independentlyValidateAgentCard(discovered.body);
  const agentInterface = card.supportedInterfaces.find((candidate) => candidate.tenant === agentName);
  assert.ok(agentInterface, `card did not advertise owner-authorized agent ${agentName}`);
  return agentInterface;
}

class RawMcp {
  constructor(cwd, stateRoot) {
    this.nextId = 1;
    this.pending = new Map();
    this.process = spawn(process.execPath, [mcpPath], {
      cwd, env: { ...process.env, AGENTLINK_NETWORK_STATE_ROOT: stateRoot }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) => this.process.once('exit', resolve));
    this.process.stderr.on('data', (chunk) => process.stderr.write(chunk));
    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
      } catch (error) { process.stderr.write(`MCP protocol error: ${error instanceof Error ? error.message : String(error)}\n`); }
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.kill('SIGTERM');
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL');
  }
}

function sendBody({ id, sender, agentInterface, conversation, body }) {
  return {
    jsonrpc: '2.0', id, method: 'SendMessage', params: {
      tenant: agentInterface.tenant,
      configuration: { returnImmediately: true },
      message: { messageId: id, contextId: conversation, role: 'ROLE_USER', parts: [{ text: body, mediaType: 'text/plain' }], metadata: { agentlinkSenderAgentId: sender } },
    },
  };
}

function assertPassEvidence(evidence, actualNodes) {
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.nodes.length, 2);
  assert.deepEqual(evidence.nodes, actualNodes.map((node) => ({ pid: node.process.pid, identity: node.identity.nodeId })));
  assert.equal(new Set(evidence.nodes.map((node) => node.pid)).size, 2);
  for (const node of evidence.nodes) {
    assert.equal(Number.isSafeInteger(node.pid) && node.pid > 0, true);
    assert.equal(typeof node.identity, 'string');
  }
  assert.deepEqual(Object.keys(evidence.checks).sort(), [
    'a2aRoundTrip', 'boundLocalActor', 'deniedGrant', 'rawMcp', 'restart',
    'selectedConversationIsolation', 'unsupportedVersion',
  ]);
  for (const value of Object.values(evidence.checks)) assert.equal(value, 'PASS');
}

async function controller() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentlink-network-bridge-'));
  const aState = join(temporaryRoot, 'node-a');
  const bState = join(temporaryRoot, 'node-b');
  const selectedRepo = join(temporaryRoot, 'selected-repo');
  const otherRepo = join(temporaryRoot, 'other-repo');
  await Promise.all([mkdir(selectedRepo), mkdir(otherRepo)]);
  await initializeWorkspaceIdentity(selectedRepo);
  await initializeWorkspaceIdentity(otherRepo);
  const selectedActor = (await resolveActiveParticipant(selectedRepo)).participantId;
  const clients = [];
  let a = new ChildNode(aState, 'node-a');
  let b = new ChildNode(bState, 'node-b');
  try {
    const [aReady, bReady] = await Promise.all([a.ready, b.ready]);
    await Promise.all([a.command('trust', bReady.identity), b.command('trust', aReady.identity)]);
    const [aListen, bListen] = await Promise.all([a.command('start'), b.command('start')]);
    await a.command('pair', { name: 'node-b-peer', address: `https://127.0.0.1:${bListen.port}`, identity: bReady.identity, expectedFingerprint: bReady.identity.fingerprint });
    await b.command('pair', { name: 'node-a-peer', address: `https://127.0.0.1:${aListen.port}`, identity: aReady.identity, expectedFingerprint: aReady.identity.fingerprint });
    await a.command('expose', { agentId: selectedActor, workspaceRoot: selectedRepo, peerName: 'node-b-peer' });
    const expiry = new Date(Date.now() + 60_000).toISOString();
    await b.command('grant', { grantId: 'a-to-b', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend', collaborationId: 'selected-thread', actions: ['deliver'], expiresAt: expiry });
    await b.command('grant', { grantId: 'a-mcp-to-b', remoteNodeId: 'node-a', remoteAgentId: selectedActor, localAgentId: 'frontend', collaborationId: 'selected-thread', actions: ['deliver'], expiresAt: expiry });
    await a.command('grant', { grantId: 'b-to-a-selected', remoteNodeId: 'node-b', remoteAgentId: 'frontend', localAgentId: selectedActor, collaborationId: 'selected-thread', actions: ['deliver'], expiresAt: expiry });
    await a.command('grant', { grantId: 'b-to-a-other', remoteNodeId: 'node-b', remoteAgentId: 'frontend', localAgentId: selectedActor, collaborationId: 'other-thread', actions: ['deliver'], expiresAt: expiry });
    const aBaseAddress = `https://127.0.0.1:${aListen.port}`;
    const bBaseAddress = `https://127.0.0.1:${bListen.port}`;
    const aInterface = await discoverAgentInterface({ stateRoot: bState, peer: aReady.identity, baseAddress: aBaseAddress, agentName: selectedActor });
    const bInterface = await discoverAgentInterface({ stateRoot: aState, peer: bReady.identity, baseAddress: bBaseAddress, agentName: 'frontend' });
    const aEndpoint = aInterface.url;
    const bEndpoint = bInterface.url;

    const sent = await rawA2A({ stateRoot: aState, peer: bReady.identity, endpoint: bEndpoint, requestBody: sendBody({ id: 'roundtrip-message', sender: 'backend', agentInterface: bInterface, conversation: 'selected-thread', body: 'real a2a round trip' }) });
    assert.equal(sent.statusCode, 200);
    const task = sent.body.result.task;
    assert.equal(task.contextId, 'selected-thread');
    const polled = await rawA2A({ stateRoot: aState, peer: bReady.identity, endpoint: bEndpoint, requestBody: { jsonrpc: '2.0', id: 'poll-1', method: 'GetTask', params: { id: task.id, tenant: bInterface.tenant, historyLength: 1 } } });
    assert.equal(polled.body.result.id, task.id);

    const blockingByDefaultBody = sendBody({ id: 'blocking-default', sender: 'backend', agentInterface: bInterface, conversation: 'selected-thread', body: 'must not submit immediately' });
    delete blockingByDefaultBody.params.configuration;
    const blockingByDefault = await rawA2A({ stateRoot: aState, peer: bReady.identity, endpoint: bEndpoint, requestBody: blockingByDefaultBody });
    assert.equal(blockingByDefault.body.error.code, -32004);
    const pushUnsupported = await rawA2A({ stateRoot: aState, peer: bReady.identity, endpoint: bEndpoint, requestBody: {
      jsonrpc: '2.0', id: 'push-unsupported', method: 'CreateTaskPushNotificationConfig', params: { taskId: task.id },
    } });
    assert.equal(pushUnsupported.body.error.code, -32003);

    const incompatible = await rawA2A({ stateRoot: aState, peer: bReady.identity, endpoint: bEndpoint, version: '0.3', requestBody: sendBody({ id: 'old-version', sender: 'backend', agentInterface: bInterface, conversation: 'selected-thread', body: 'old' }) });
    assert.equal(incompatible.body.error.code, -32009);
    const spoofed = await rawA2A({ stateRoot: aState, peer: bReady.identity, endpoint: bEndpoint, requestBody: sendBody({ id: 'spoofed', sender: 'attacker', agentInterface: bInterface, conversation: 'selected-thread', body: 'spoof' }) });
    assert.equal(spoofed.body.error.code, -32001);
    const denied = await rawA2A({ stateRoot: aState, peer: bReady.identity, endpoint: bEndpoint, requestBody: sendBody({ id: 'denied', sender: 'backend', agentInterface: bInterface, conversation: 'denied-thread', body: 'denied' }) });
    assert.equal(denied.body.error.code, -32001);

    const selectedInbound = await rawA2A({ stateRoot: bState, peer: aReady.identity, endpoint: aEndpoint, requestBody: sendBody({ id: 'selected-inbound', sender: 'frontend', agentInterface: aInterface, conversation: 'selected-thread', body: 'selected only' }) });
    const otherInbound = await rawA2A({ stateRoot: bState, peer: aReady.identity, endpoint: aEndpoint, requestBody: sendBody({ id: 'other-inbound', sender: 'frontend', agentInterface: aInterface, conversation: 'other-thread', body: 'other only' }) });
    assert.equal(selectedInbound.body.result.task.contextId, 'selected-thread');
    assert.equal(otherInbound.body.result.task.contextId, 'other-thread');

    const mcp = new RawMcp(selectedRepo, aState);
    clients.push(mcp);
    const initialized = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-acceptance', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'agentlink-mcp');
    const listed = await mcp.call('tools/list');
    assert.equal(listed.result.tools.some((tool) => tool.name === 'agentlink_remote_receive'), true);
    assert.equal(listed.result.tools.some((tool) => tool.name === 'agentlink_remote_send'), true);
    const rawMcpSend = await mcp.call('tools/call', { name: 'agentlink_remote_send', arguments: {
      peer: 'node-b-peer', agent: 'frontend', conversationId: 'selected-thread', body: 'raw mcp delivery', messageId: 'raw-mcp-message',
    } });
    assert.equal(rawMcpSend.error, undefined);
    assert.equal(rawMcpSend.result.structuredContent.task.contextId, 'selected-thread');
    const afterRawMcp = await a.command('mailbox');
    assert.equal(afterRawMcp.outbox.find((entry) => entry.envelope.body === 'raw mcp delivery')?.status, 'transport-received');
    const status = await mcp.call('tools/call', { name: 'agentlink_remote_status', arguments: {} });
    assert.equal(status.result.structuredContent.actorId, selectedActor);
    const attemptedRebind = await mcp.call('tools/call', { name: 'agentlink_remote_status', arguments: { agentId: 'attacker' } });
    assert.match(attemptedRebind.error.message, /Unsupported remote-tool argument/);
    const received = await mcp.call('tools/call', { name: 'agentlink_remote_receive', arguments: { peer: 'node-b-peer', conversationId: 'selected-thread' } });
    assert.deepEqual(received.result.structuredContent.messages.map((message) => message.body), ['selected only']);
    const selectedMailbox = await a.command('mailbox');
    assert.equal(selectedMailbox.inbox.filter((entry) => entry.envelope.collaborationId === 'selected-thread').length, 1);
    assert.equal(selectedMailbox.inbox.filter((entry) => entry.envelope.collaborationId === 'other-thread').length, 1);

    const otherMcp = new RawMcp(otherRepo, aState);
    clients.push(otherMcp);
    await otherMcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'other-repo', version: '1' } });
    const otherStatus = await otherMcp.call('tools/call', { name: 'agentlink_remote_status', arguments: {} });
    assert.deepEqual(otherStatus.result.structuredContent.peers, []);

    await b.close();
    const queuedAfterFailure = await mcp.call('tools/call', { name: 'agentlink_remote_send', arguments: {
      peer: 'node-b-peer', agent: 'frontend', conversationId: 'selected-thread', body: 'restart durable delivery', messageId: 'restart-message',
    } });
    assert.match(queuedAfterFailure.error.message, /ECONNREFUSED|connect/i);
    const queuedMailbox = await a.command('mailbox');
    assert.equal(queuedMailbox.outbox.find((entry) => entry.envelope.body === 'restart durable delivery')?.status, 'queued');
    await mcp.close();
    b = new ChildNode(bState, 'node-b');
    const restartedReady = await b.ready;
    const restartedListen = await b.command('start', { port: bListen.port });
    const restartedMcp = new RawMcp(selectedRepo, aState);
    clients.push(restartedMcp);
    await restartedMcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-acceptance-restart', version: '1' } });
    const resumed = await restartedMcp.call('tools/call', { name: 'agentlink_remote_send', arguments: {
      peer: 'node-b-peer', agent: 'frontend', conversationId: 'selected-thread', body: 'restart durable delivery', messageId: 'restart-message',
    } });
    assert.equal(resumed.error, undefined);
    const resumedMailbox = await a.command('mailbox');
    assert.equal(resumedMailbox.outbox.find((entry) => entry.envelope.body === 'restart durable delivery')?.status, 'transport-received');
    const restartedInterface = await discoverAgentInterface({ stateRoot: aState, peer: restartedReady.identity, baseAddress: `https://127.0.0.1:${restartedListen.port}`, agentName: 'frontend' });
    const restartedPoll = await rawA2A({ stateRoot: aState, peer: restartedReady.identity, endpoint: restartedInterface.url, requestBody: { jsonrpc: '2.0', id: 'poll-after-restart', method: 'GetTask', params: { id: task.id, tenant: restartedInterface.tenant, historyLength: 1 } } });
    assert.equal(restartedPoll.body.result.id, task.id);
    const bMailbox = await b.command('mailbox');
    assert.equal(bMailbox.inbox.filter((entry) => entry.envelope.body === 'restart durable delivery').length, 1);
    assert.deepEqual(bMailbox.inbox.map((entry) => entry.envelope.body), ['real a2a round trip', 'raw mcp delivery', 'restart durable delivery']);

    const evidence = {
      status: 'PASS',
      nodes: [
        { pid: aReady.pid, identity: aReady.identity.nodeId },
        { pid: restartedReady.pid, identity: restartedReady.identity.nodeId },
      ],
      checks: {
        a2aRoundTrip: 'PASS', unsupportedVersion: 'PASS', rawMcp: 'PASS', boundLocalActor: 'PASS',
        deniedGrant: 'PASS', selectedConversationIsolation: 'PASS', restart: 'PASS',
      },
    };
    assertPassEvidence(evidence, [
      { process: a.process, identity: aReady.identity },
      { process: b.process, identity: restartedReady.identity },
    ]);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await Promise.allSettled([a.close(), b.close()]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--node') {
  await runNode(process.argv[3], process.argv[4]);
} else {
  await controller().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
