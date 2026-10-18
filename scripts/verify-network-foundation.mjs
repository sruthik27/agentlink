#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resumePendingNetworkEnvelopes, sendNetworkEnvelope, NetworkResponseError } from '../dist/network/client.js';
import { exportPublicIdentity, initializeNodeIdentity, loadNodeIdentity } from '../dist/network/identity.js';
import { readMailboxState } from '../dist/network/mailbox.js';
import { startNetworkServer } from '../dist/network/server.js';
import { addGrant, addTrustedPeer, certificateDerFingerprint, revokeGrant } from '../dist/network/trust.js';
import { MAX_WIRE_BYTES } from '../dist/network/types.js';

const scriptPath = fileURLToPath(import.meta.url);

async function rawPost({ endpoint, stateRoot, peer, body }) {
  const identity = await loadNodeIdentity(stateRoot);
  return await new Promise((resolve, reject) => {
    const req = request(endpoint, {
      method: 'POST',
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      ca: peer.certificatePem,
      checkServerIdentity: (_host, certificate) => {
        if (!certificate.raw) return new Error('Remote certificate is missing');
        return certificateDerFingerprint(certificate.raw) === peer.fingerprint
          ? undefined : new Error('Remote certificate is not the pinned peer');
      },
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error('Raw HTTPS request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function runChild(stateRoot, nodeId) {
  await initializeNodeIdentity(stateRoot, nodeId);
  const publicIdentity = await exportPublicIdentity(stateRoot);
  let running;
  const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  reply({ ready: true, pid: process.pid, identity: publicIdentity });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let command;
    try {
      command = JSON.parse(line);
      let result;
      switch (command.action) {
        case 'trust':
          await addTrustedPeer(stateRoot, command.peer);
          result = true;
          break;
        case 'grant':
          result = await addGrant(stateRoot, command.grant);
          break;
        case 'revoke':
          await revokeGrant(stateRoot, command.grantId);
          result = true;
          break;
        case 'start':
          if (running) throw new Error('Server is already running');
          running = await startNetworkServer({ stateRoot, host: '127.0.0.1', port: 0 });
          result = { url: running.url, port: running.port };
          break;
        case 'stop-server':
          if (running) await running.close();
          running = undefined;
          result = true;
          break;
        case 'send':
          result = await sendNetworkEnvelope({ stateRoot, endpoint: command.endpoint, peer: command.peer, envelope: command.envelope });
          break;
        case 'resume':
          result = await resumePendingNetworkEnvelopes({ stateRoot, endpoint: command.endpoint, peer: command.peer });
          break;
        case 'raw-post':
          result = await rawPost({ endpoint: command.endpoint, stateRoot, peer: command.peer, body: command.body });
          break;
        case 'mailbox':
          result = await readMailboxState(stateRoot);
          break;
        case 'shutdown':
          if (running) await running.close();
          reply({ id: command.id, ok: true, result: true });
          return;
        default:
          throw new Error(`Unknown child action: ${command.action}`);
      }
      reply({ id: command.id, ok: true, result });
    } catch (error) {
      reply({
        id: command?.id,
        ok: false,
        error: error instanceof NetworkResponseError
          ? { message: error.message, statusCode: error.statusCode, code: error.code }
          : { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  if (running) await running.close();
}

class ChildNode {
  constructor(stateRoot, nodeId) {
    this.nextId = 1;
    this.pending = new Map();
    this.process = spawn(process.execPath, [scriptPath, '--child', stateRoot, nodeId], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.process.stderr.on('data', (chunk) => process.stderr.write(chunk));
    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${nodeId} did not initialize within 30 seconds`)), 30_000);
      this.onReady = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.ready) {
          this.onReady(message);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        message.ok ? pending.resolve(message.result) : pending.reject(Object.assign(new Error(message.error.message), message.error));
      } catch (error) {
        process.stderr.write(`Invalid child protocol response from ${nodeId}: ${error.message}\n`);
      }
    });
    this.process.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${nodeId} exited (${code ?? signal})`));
      }
      this.pending.clear();
    });
    this.exited = new Promise((resolve) => this.process.once('exit', resolve));
  }

  command(action, fields = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Child command ${action} timed out`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, action, ...fields })}\n`);
    });
  }

  async crash() {
    assert.equal(this.process.kill('SIGKILL'), true, 'Forced exit must reach a live node');
    assert.equal(await this.waitForExit(2_000), true, 'Forced-exit node must terminate');
    assert.equal(this.process.signalCode, 'SIGKILL');
  }

  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await this.command('shutdown').catch(() => undefined);
    this.process.stdin.end();
    if (await this.waitForExit(2_000)) return;
    this.process.kill('SIGTERM');
    if (await this.waitForExit(2_000)) return;
    this.process.kill('SIGKILL');
    if (!await this.waitForExit(2_000)) throw new Error(`Child ${this.process.pid} did not exit after SIGKILL`);
  }

  async waitForExit(timeoutMs) {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return true;
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    const exited = this.exited.then(() => true);
    const result = await Promise.race([exited, timedOut]);
    clearTimeout(timer);
    return result;
  }
}

function envelope(eventId, body = 'hello', senderAgent = 'backend') {
  return {
    version: 1,
    eventId,
    sender: { nodeId: 'node-a', agentId: senderAgent },
    recipient: { nodeId: 'node-b', agentId: 'frontend' },
    collaborationId: 'orders-v2',
    kind: 'message',
    body,
    createdAt: '2026-10-10T04:00:00.000Z',
  };
}

async function expectRemoteStatus(operation, statusCode) {
  await assert.rejects(operation, (error) => error?.statusCode === statusCode);
}

async function runController() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentlink-network-foundation-'));
  const aRoot = join(temporaryRoot, 'node-a');
  const bRoot = join(temporaryRoot, 'node-b');
  const unknownRoot = join(temporaryRoot, 'unknown');
  let a = new ChildNode(aRoot, 'node-a');
  let b = new ChildNode(bRoot, 'node-b');
  const checks = {};
  try {
    let [aReady, bReady] = await Promise.all([a.ready, b.ready]);
    assert.notEqual(aReady.pid, bReady.pid);
    assert.notEqual(aReady.identity.fingerprint, bReady.identity.fingerprint);
    await Promise.all([
      a.command('trust', { peer: bReady.identity }),
      b.command('trust', { peer: aReady.identity }),
    ]);
    await b.command('grant', { grant: {
      grantId: 'grant-1', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
      collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    } });
    let endpoint = (await b.command('start')).url;

    const first = await a.command('send', { endpoint, peer: bReady.identity, envelope: envelope('event-1') });
    assert.equal(first.status, 'transport-received');
    const [aMailbox, bMailbox] = await Promise.all([a.command('mailbox'), b.command('mailbox')]);
    assert.equal(aMailbox.outbox[0].receipt.receiptId, first.receiptId);
    assert.equal(bMailbox.inbox[0].receipt.receiptId, first.receiptId);
    checks.durableExchange = 'PASS';

    const duplicate = await a.command('send', { endpoint, peer: bReady.identity, envelope: envelope('event-1') });
    assert.deepEqual(duplicate, first);
    assert.equal((await b.command('mailbox')).inbox.length, 1);
    checks.duplicateRetry = 'PASS';

    const conflict = await a.command('raw-post', {
      endpoint, peer: bReady.identity, body: JSON.stringify(envelope('event-1', 'changed')),
    });
    assert.equal(conflict.statusCode, 409);
    checks.conflictingReplay = 'PASS';

    const receiverFingerprint = bReady.identity.fingerprint;
    await b.crash();
    b = new ChildNode(bRoot, 'node-b');
    bReady = await b.ready;
    assert.equal(bReady.identity.fingerprint, receiverFingerprint);
    assert.equal((await b.command('mailbox')).inbox[0].receipt.receiptId, first.receiptId);
    await assert.rejects(a.command('send', {
      endpoint, peer: bReady.identity, envelope: envelope('restart-queued'),
    }));
    assert.equal((await a.command('mailbox')).outbox.find((entry) => entry.envelope.eventId === 'restart-queued').status, 'queued');
    await a.crash();
    a = new ChildNode(aRoot, 'node-a');
    aReady = await a.ready;
    endpoint = (await b.command('start')).url;
    const resumed = await a.command('resume', { endpoint, peer: bReady.identity });
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].eventId, 'restart-queued');
    const afterRestart = await a.command('send', { endpoint, peer: bReady.identity, envelope: envelope('event-1') });
    assert.deepEqual(afterRestart, first);
    assert.equal((await a.command('mailbox')).outbox[0].receipt.receiptId, first.receiptId);
    assert.equal((await b.command('mailbox')).inbox.length, 2);
    checks.restart = 'PASS';
    checks.crashRestart = 'PASS';

    // Keep graceful restart coverage separate from forced-exit recovery.
    await Promise.all([a.close(), b.close()]);
    a = new ChildNode(aRoot, 'node-a');
    b = new ChildNode(bRoot, 'node-b');
    [aReady, bReady] = await Promise.all([a.ready, b.ready]);
    endpoint = (await b.command('start')).url;
    assert.deepEqual(await a.command('send', { endpoint, peer: bReady.identity, envelope: envelope('event-1') }), first);
    assert.equal((await b.command('mailbox')).inbox.length, 2);
    checks.gracefulRestart = 'PASS';

    await initializeNodeIdentity(unknownRoot, 'node-unknown');
    await assert.rejects(rawPost({
      endpoint, stateRoot: unknownRoot, peer: bReady.identity,
      body: JSON.stringify({ ...envelope('unknown'), sender: { nodeId: 'node-unknown', agentId: 'backend' } }),
    }), /certificate|socket|TLS|alert/i);
    checks.unknownPeer = 'PASS';

    await expectRemoteStatus(a.command('send', {
      endpoint, peer: bReady.identity,
      envelope: { ...envelope('spoofed'), sender: { nodeId: 'node-other', agentId: 'backend' } },
    }), 403);
    checks.spoofedActor = 'PASS';

    const inboxBeforeWrongRecipient = (await b.command('mailbox')).inbox.length;
    const wrongRecipient = await a.command('raw-post', {
      endpoint,
      peer: bReady.identity,
      body: JSON.stringify({
        ...envelope('wrong-recipient'),
        recipient: { nodeId: 'node-other', agentId: 'frontend' },
      }),
    });
    assert.equal(wrongRecipient.statusCode, 403);
    assert.equal((await b.command('mailbox')).inbox.length, inboxBeforeWrongRecipient);
    checks.wrongRecipient = 'PASS';

    await expectRemoteStatus(a.command('send', {
      endpoint, peer: bReady.identity, envelope: envelope('denied', 'hello', 'ungranted-agent'),
    }), 403);
    checks.deniedGrant = 'PASS';

    await b.command('revoke', { grantId: 'grant-1' });
    await expectRemoteStatus(a.command('send', { endpoint, peer: bReady.identity, envelope: envelope('revoked') }), 403);
    checks.revokedGrant = 'PASS';

    const oversize = await a.command('raw-post', {
      endpoint, peer: bReady.identity, body: 'x'.repeat(MAX_WIRE_BYTES + 1),
    });
    assert.equal(oversize.statusCode, 413);
    checks.oversizeInput = 'PASS';

    const report = {
      status: 'PASS',
      nodes: [
        { pid: aReady.pid, identity: aReady.identity.nodeId },
        { pid: bReady.pid, identity: bReady.identity.nodeId },
      ],
      checks,
    };
    assert.deepEqual(Object.keys(checks), [
      'durableExchange', 'duplicateRetry', 'conflictingReplay', 'restart', 'crashRestart', 'gracefulRestart', 'unknownPeer',
      'spoofedActor', 'wrongRecipient', 'deniedGrant', 'revokedGrant', 'oversizeInput',
    ]);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') {
  runChild(process.argv[3], process.argv[4]).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  runController().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
