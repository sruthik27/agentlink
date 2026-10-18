import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, request } from 'node:https';
import { connect } from 'node:tls';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from '../atomic.js';
import { resumePendingNetworkEnvelopes, sendNetworkEnvelope, NetworkResponseError } from './client.js';
import { exportPublicIdentity, initializeNodeIdentity, loadNodeIdentity } from './identity.js';
import { readMailboxState, receiveInboundEvent } from './mailbox.js';
import { startNetworkServer } from './server.js';
import { addGrant, addTrustedPeer, certificateDerFingerprint, revokeGrant } from './trust.js';
import { MAX_WIRE_BYTES, parseEnvelope, type NodePublicIdentity } from './types.js';

async function temporaryRoot(t: test.TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `agentlink-network-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const makeEnvelope = (overrides: Record<string, unknown> = {}) => parseEnvelope({
  version: 1,
  eventId: 'event-1',
  sender: { nodeId: 'node-a', agentId: 'backend' },
  recipient: { nodeId: 'node-b', agentId: 'frontend' },
  collaborationId: 'orders-v2',
  kind: 'message',
  body: 'hello',
  createdAt: '2026-10-10T04:00:00.000Z',
  ...overrides,
});

const futureExpiry = (): string => new Date(Date.now() + 60 * 60 * 1_000).toISOString();

async function expectStatus(operation: Promise<unknown>, statusCode: number): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof NetworkResponseError && error.statusCode === statusCode);
}

async function postRaw(
  url: string,
  identityRoot: string,
  peer: NodePublicIdentity,
  body: string,
): Promise<number> {
  const identity = await loadNodeIdentity(identityRoot);
  return await new Promise<number>((resolve, reject) => {
    const req = request(url, {
      method: 'POST', cert: identity.certificatePem, key: identity.privateKeyPem, ca: peer.certificatePem,
      checkServerIdentity: (_host, certificate) => certificate.raw.length > 0 ? undefined : new Error('Missing certificate'),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function postPartial(url: string, identityRoot: string, peer: NodePublicIdentity, trickle = false): Promise<number> {
  const identity = await loadNodeIdentity(identityRoot);
  const endpoint = new URL(url);
  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    let response = '';
    const socket = connect({
      host: endpoint.hostname,
      port: Number(endpoint.port),
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      ca: peer.certificatePem,
      rejectUnauthorized: true,
      checkServerIdentity: (_host, certificate) => certificate.raw.length > 0 ? undefined : new Error('Missing certificate'),
    });
    const timer = setTimeout(() => socket.destroy(new Error('Partial request did not receive a response')), 5_000);
    let trickleTimer: NodeJS.Timeout | undefined;
    socket.once('secureConnect', () => {
      socket.write([
        `POST ${endpoint.pathname} HTTP/1.1`,
        `Host: ${endpoint.host}`,
        'Content-Type: application/json',
        'Content-Length: 100',
        '',
        '{',
      ].join('\r\n'));
      if (trickle) trickleTimer = setInterval(() => socket.write('x'), 10);
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (!settled && response.includes('\r\n')) {
        settled = true;
        clearTimeout(timer);
        clearInterval(trickleTimer);
        const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
        socket.destroy();
        match ? resolve(Number(match[1])) : reject(new Error('Partial request received an invalid HTTP response'));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      clearInterval(trickleTimer);
      if (!settled) reject(error);
    });
  });
}

async function holdPartialHeaders(url: string, identityRoot: string, peer: NodePublicIdentity): Promise<void> {
  const identity = await loadNodeIdentity(identityRoot);
  const endpoint = new URL(url);
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const socket = connect({
      host: endpoint.hostname,
      port: Number(endpoint.port),
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      ca: peer.certificatePem,
      rejectUnauthorized: true,
      checkServerIdentity: (_host, certificate) => certificate.raw.length > 0 ? undefined : new Error('Missing certificate'),
    });
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error('Partial-header connection exceeded the server deadline'));
    }, 2_000);
    socket.once('secureConnect', () => {
      socket.write(`POST ${endpoint.pathname} HTTP/1.1\r\nHost: ${endpoint.host}\r\nContent-Type: application/json\r\n`);
    });
    socket.once('error', () => finish());
    socket.once('close', () => finish());
  });
}

for (const mode of ['deadline', 'wire-limit'] as const) {
  test(`client promptly enforces ${mode} against a trickling TLS peer`, async (t) => {
    const aRoot = await temporaryRoot(t, 'deadline-a');
    const bRoot = await temporaryRoot(t, 'deadline-b');
    await Promise.all([initializeNodeIdentity(aRoot, 'node-a'), initializeNodeIdentity(bRoot, 'node-b')]);
    const [aPublic, bPublic, identity] = await Promise.all([
      exportPublicIdentity(aRoot), exportPublicIdentity(bRoot), loadNodeIdentity(bRoot),
    ]);
    await addTrustedPeer(aRoot, bPublic);
    const server = createServer({
      cert: identity.certificatePem, key: identity.privateKeyPem,
      ca: aPublic.certificatePem, requestCert: true, rejectUnauthorized: true,
    }, (req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      if (mode === 'wire-limit') res.write(Buffer.alloc(MAX_WIRE_BYTES + 1));
      const trickle = setInterval(() => res.write('x'), 10);
      const end = setTimeout(() => res.end(), 1_000);
      res.once('close', () => { clearInterval(trickle); clearTimeout(end); });
    });
    t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const started = Date.now();
    await assert.rejects(sendNetworkEnvelope({
      stateRoot: aRoot, endpoint: `https://127.0.0.1:${address.port}/`,
      peer: bPublic, envelope: makeEnvelope(), timeoutMs: mode === 'deadline' ? 100 : 5_000,
    }), mode === 'deadline' ? /timed out/ : /wire limit/);
    assert.ok(Date.now() - started < 750, 'Client must reject before the peer finishes its response');
    assert.equal((await readMailboxState(aRoot)).outbox[0].status, 'queued');
  });
}

test('real HTTPS transport authenticates, scopes, persists, deduplicates, and revokes per request', async (t) => {
  const aRoot = await temporaryRoot(t, 'a');
  const bRoot = await temporaryRoot(t, 'b');
  const unknownRoot = await temporaryRoot(t, 'unknown');
  await Promise.all([
    initializeNodeIdentity(aRoot, 'node-a'),
    initializeNodeIdentity(bRoot, 'node-b'),
    initializeNodeIdentity(unknownRoot, 'node-unknown'),
  ]);
  const [aPublic, bPublic] = await Promise.all([exportPublicIdentity(aRoot), exportPublicIdentity(bRoot)]);
  await addTrustedPeer(aRoot, bPublic);
  await addTrustedPeer(bRoot, aPublic);
  await addGrant(bRoot, {
    grantId: 'grant-1', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });

  const server = await startNetworkServer({ stateRoot: bRoot, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  let tlsConnections = 0;
  server.server.on('secureConnection', () => { tlsConnections += 1; });
  // Node 24 deliberately avoids pooling per-request custom identity checks.
  // This dedicated peer Agent needs its own pin check to exercise revocation
  // over an existing connection rather than only over fresh TLS handshakes.
  const agent = new Agent({
    keepAlive: true, maxSockets: 1,
    checkServerIdentity: (_host, certificate) => certificate.raw
      && certificateDerFingerprint(certificate.raw) === bPublic.fingerprint
      ? undefined : new Error('Peer certificate does not match the pinned identity'),
  });
  t.after(() => agent.destroy());

  const first = await sendNetworkEnvelope({ stateRoot: aRoot, endpoint: server.url, peer: bPublic, envelope: makeEnvelope(), agent });
  const duplicate = await sendNetworkEnvelope({ stateRoot: aRoot, endpoint: server.url, peer: bPublic, envelope: makeEnvelope(), agent });
  assert.deepEqual(duplicate, first);
  assert.equal((await readMailboxState(bRoot)).inbox.length, 1);

  await expectStatus(sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: bPublic,
    envelope: makeEnvelope({ eventId: 'spoof', sender: { nodeId: 'node-unknown', agentId: 'backend' } }), agent,
  }), 403);
  await expectStatus(sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: bPublic,
    envelope: makeEnvelope({ eventId: 'denied', sender: { nodeId: 'node-a', agentId: 'other' } }), agent,
  }), 403);

  await revokeGrant(bRoot, 'grant-1');
  await expectStatus(sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: bPublic,
    envelope: makeEnvelope({ eventId: 'revoked' }), agent,
  }), 403);
  assert.equal(tlsConnections, 1, 'revocation must be enforced on the existing authenticated TLS connection');

  const wrongRecipient = makeEnvelope({ eventId: 'wrong-recipient', recipient: { nodeId: 'node-other', agentId: 'frontend' } });
  assert.equal(await postRaw(server.url, aRoot, bPublic, JSON.stringify(wrongRecipient)), 403);
  assert.equal((await readMailboxState(bRoot)).inbox.length, 1);

  await assert.rejects(postRaw(
    server.url,
    unknownRoot,
    bPublic,
    JSON.stringify(makeEnvelope({ eventId: 'unknown', sender: { nodeId: 'node-unknown', agentId: 'backend' } })),
  ), /certificate|socket|TLS|alert/i);
  assert.equal(await postRaw(server.url, aRoot, bPublic, 'x'.repeat(MAX_WIRE_BYTES + 1)), 413);
});

test('partial bodies and headers time out within connection limits and release capacity', async (t) => {
  const aRoot = await temporaryRoot(t, 'timeout-a');
  const bRoot = await temporaryRoot(t, 'timeout-b');
  await Promise.all([initializeNodeIdentity(aRoot, 'node-a'), initializeNodeIdentity(bRoot, 'node-b')]);
  const [aPublic, bPublic] = await Promise.all([exportPublicIdentity(aRoot), exportPublicIdentity(bRoot)]);
  await addTrustedPeer(aRoot, bPublic);
  await addTrustedPeer(bRoot, aPublic);
  await addGrant(bRoot, {
    grantId: 'grant-timeout', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });
  const server = await startNetworkServer({
    stateRoot: bRoot, host: '127.0.0.1', port: 0, requestTimeoutMs: 50, maxConcurrentRequests: 1,
  });
  t.after(() => server.close());
  assert.equal(await postPartial(server.url, aRoot, bPublic, true), 408);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await Promise.all(Array.from({ length: 3 }, () => holdPartialHeaders(server.url, aRoot, bPublic)));
  const receipt = await sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: bPublic, envelope: makeEnvelope({ eventId: 'after-timeouts' }),
  });
  assert.equal(receipt.status, 'transport-received');
});

test('sender restart resumes a durably queued transmission', async (t) => {
  const aRoot = await temporaryRoot(t, 'resume-a');
  const bRoot = await temporaryRoot(t, 'resume-b');
  await Promise.all([initializeNodeIdentity(aRoot, 'node-a'), initializeNodeIdentity(bRoot, 'node-b')]);
  const [aPublic, bPublic] = await Promise.all([exportPublicIdentity(aRoot), exportPublicIdentity(bRoot)]);
  await addTrustedPeer(aRoot, bPublic);
  await addTrustedPeer(bRoot, aPublic);
  await addGrant(bRoot, {
    grantId: 'grant-resume', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });
  await assert.rejects(sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: 'https://127.0.0.1:1/v1/events', peer: bPublic, envelope: makeEnvelope(), timeoutMs: 100,
  }));
  assert.equal((await readMailboxState(aRoot)).outbox[0]?.status, 'queued');

  const server = await startNetworkServer({ stateRoot: bRoot, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const receipts = await resumePendingNetworkEnvelopes({ stateRoot: aRoot, endpoint: server.url, peer: bPublic });
  assert.equal(receipts.length, 1);
  assert.equal((await readMailboxState(aRoot)).outbox[0]?.status, 'transport-received');
  assert.equal((await readMailboxState(bRoot)).inbox.length, 1);
});

test('completed grant revocation wins while a delivery is waiting for the mailbox lock', async (t) => {
  const aRoot = await temporaryRoot(t, 'race-a');
  const bRoot = await temporaryRoot(t, 'race-b');
  await Promise.all([initializeNodeIdentity(aRoot, 'node-a'), initializeNodeIdentity(bRoot, 'node-b')]);
  const [aPublic, bPublic] = await Promise.all([exportPublicIdentity(aRoot), exportPublicIdentity(bRoot)]);
  await addTrustedPeer(aRoot, bPublic);
  await addTrustedPeer(bRoot, aPublic);
  await addGrant(bRoot, {
    grantId: 'grant-race', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });
  const server = await startNetworkServer({ stateRoot: bRoot, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  let releaseLock!: () => void;
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
  const blocker = withFileLock(join(bRoot, 'locks'), 'network-mailbox', async () => {
    markLocked();
    await gate;
  });
  await locked;
  const delivery = sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: bPublic, envelope: makeEnvelope({ eventId: 'race-event' }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await revokeGrant(bRoot, 'grant-race');
  releaseLock();
  await blocker;
  await expectStatus(delivery, 403);
  assert.equal((await readMailboxState(bRoot)).inbox.some((entry) => entry.envelope.eventId === 'race-event'), false);
});

test('grant expiry is evaluated after waiting for the mailbox lock', async (t) => {
  const aRoot = await temporaryRoot(t, 'expiry-a');
  const bRoot = await temporaryRoot(t, 'expiry-b');
  await Promise.all([initializeNodeIdentity(aRoot, 'node-a'), initializeNodeIdentity(bRoot, 'node-b')]);
  const [aPublic, bPublic] = await Promise.all([exportPublicIdentity(aRoot), exportPublicIdentity(bRoot)]);
  await addTrustedPeer(aRoot, bPublic);
  await addTrustedPeer(bRoot, aPublic);
  const expiresAt = Date.now() + 250;
  await addGrant(bRoot, {
    grantId: 'grant-expiry', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: new Date(expiresAt).toISOString(),
  });
  const server = await startNetworkServer({ stateRoot: bRoot, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  let releaseLock!: () => void;
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
  const blocker = withFileLock(join(bRoot, 'locks'), 'network-mailbox', async () => {
    markLocked();
    await gate;
  });
  await locked;
  const delivery = sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: bPublic, envelope: makeEnvelope({ eventId: 'expired-while-waiting' }),
  });
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 25)));
  releaseLock();
  await blocker;

  await expectStatus(delivery, 403);
  assert.equal((await readMailboxState(bRoot)).inbox.some((entry) => entry.envelope.eventId === 'expired-while-waiting'), false);
});

test('dropped response is retried after restart without duplicating the receiver inbox', async (t) => {
  const aRoot = await temporaryRoot(t, 'drop-a');
  const bRoot = await temporaryRoot(t, 'drop-b');
  await Promise.all([initializeNodeIdentity(aRoot, 'node-a'), initializeNodeIdentity(bRoot, 'node-b')]);
  const [aIdentity, bIdentity] = await Promise.all([loadNodeIdentity(aRoot), loadNodeIdentity(bRoot)]);
  const [aPublic, bPublic] = await Promise.all([exportPublicIdentity(aRoot), exportPublicIdentity(bRoot)]);
  await addTrustedPeer(aRoot, bPublic);
  await addTrustedPeer(bRoot, aPublic);
  await addGrant(bRoot, {
    grantId: 'grant-drop', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });
  const dropServer = createServer({
    key: bIdentity.privateKeyPem, cert: bIdentity.certificatePem, ca: [aIdentity.certificatePem],
    requestCert: true, rejectUnauthorized: true,
  }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const payload = Buffer.concat(chunks).toString('utf8');
      void receiveInboundEvent(bRoot, JSON.parse(payload), payload)
        .then(() => response.socket?.destroy())
        .catch((error) => response.destroy(error as Error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    dropServer.once('error', reject);
    dropServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = dropServer.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `https://127.0.0.1:${address.port}/v1/events`;
  await assert.rejects(sendNetworkEnvelope({
    stateRoot: aRoot, endpoint, peer: bPublic, envelope: makeEnvelope({ eventId: 'drop-event' }),
  }), /socket|reset|hang up/i);
  await new Promise<void>((resolve, reject) => dropServer.close((error) => error ? reject(error) : resolve()));
  assert.equal((await readMailboxState(aRoot)).outbox[0]?.status, 'queued');
  assert.equal((await readMailboxState(bRoot)).inbox.length, 1);

  const server = await startNetworkServer({ stateRoot: bRoot, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const receipts = await resumePendingNetworkEnvelopes({ stateRoot: aRoot, endpoint: server.url, peer: bPublic });
  assert.equal(receipts.length, 1);
  assert.equal((await readMailboxState(bRoot)).inbox.length, 1);
  assert.equal((await readMailboxState(aRoot)).outbox[0]?.status, 'transport-received');
});

test('outbound delivery requires the caller-supplied peer to be durably trusted before queueing', async (t) => {
  const aRoot = await temporaryRoot(t, 'untrusted-outbound-a');
  const bRoot = await temporaryRoot(t, 'untrusted-outbound-b');
  const impostorRoot = await temporaryRoot(t, 'untrusted-outbound-impostor');
  await Promise.all([
    initializeNodeIdentity(aRoot, 'node-a'),
    initializeNodeIdentity(bRoot, 'node-b'),
    initializeNodeIdentity(impostorRoot, 'node-b'),
  ]);
  const [aPublic, bPublic] = await Promise.all([exportPublicIdentity(aRoot), exportPublicIdentity(bRoot)]);
  const impostorPublic = await exportPublicIdentity(impostorRoot);
  await addTrustedPeer(bRoot, aPublic);
  await addGrant(bRoot, {
    grantId: 'grant-untrusted-outbound', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });
  const server = await startNetworkServer({ stateRoot: bRoot, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  await assert.rejects(sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: bPublic, envelope: makeEnvelope({ eventId: 'untrusted-outbound' }),
  }), /not trusted/i);
  assert.equal((await readMailboxState(aRoot)).outbox.length, 0);
  assert.equal((await readMailboxState(bRoot)).inbox.length, 0);

  await addTrustedPeer(aRoot, bPublic);
  await assert.rejects(sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: impostorPublic, envelope: makeEnvelope({ eventId: 'mismatched-outbound' }),
  }), /does not exactly match/i);
  assert.equal((await readMailboxState(aRoot)).outbox.length, 0);
  const receipt = await sendNetworkEnvelope({
    stateRoot: aRoot, endpoint: server.url, peer: bPublic, envelope: makeEnvelope({ eventId: 'trusted-outbound' }),
  });
  assert.equal(receipt.status, 'transport-received');
});
