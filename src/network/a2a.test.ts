import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A2A_V1_SUBSET_FIXTURE } from './a2a-v1-fixture.js';
import {
  A2A_METHODS,
  A2A_PROTOCOL_VERSION,
  A2A_SPECIFICATION_REVISION,
  A2A_TASK_RETENTION_MS,
  MAX_A2A_TASKS,
  createAgentCard,
  discoverA2AAgent,
  handleA2AJsonRpc,
  resumePendingA2AMessages,
  sendA2AMessage,
  validateA2AAgentCard,
} from './a2a.js';
import { exportPublicIdentity, initializeNodeIdentity, loadNodeIdentity } from './identity.js';
import { readMailboxState } from './mailbox.js';
import { addGrant, addTrustedPeer, revokeGrant } from './trust.js';
import { startNetworkServer } from './server.js';

async function receiverFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-a2a-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'agentlink-a2a-remote-'));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(remoteRoot, { recursive: true, force: true })]));
  await initializeNodeIdentity(root, 'node-b');
  await initializeNodeIdentity(remoteRoot, 'node-a');
  const remote = await exportPublicIdentity(remoteRoot);
  await addTrustedPeer(root, remote);
  await addGrant(root, {
    grantId: 'grant-a2a', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return { root };
}

function sendRequest(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0', id: 'request-1', method: 'SendMessage', params: {
      tenant: 'frontend',
      configuration: { returnImmediately: true },
      message: {
        messageId: 'message-1', contextId: 'orders-v2', role: 'ROLE_USER',
        parts: [{ text: 'hello', mediaType: 'text/plain' }],
        metadata: { agentlinkSenderAgentId: 'backend' },
      },
    },
    ...overrides,
  };
}

test('pins the documented A2A 1.0.0 subset and advertises only implemented capabilities', () => {
  assert.equal(A2A_SPECIFICATION_REVISION, A2A_V1_SUBSET_FIXTURE.specificationRevision);
  assert.equal(A2A_PROTOCOL_VERSION, A2A_V1_SUBSET_FIXTURE.protocolVersion);
  assert.deepEqual(A2A_METHODS, A2A_V1_SUBSET_FIXTURE.methods);
  assert.equal(A2A_V1_SUBSET_FIXTURE.schemaSource, 'https://raw.githubusercontent.com/a2aproject/A2A/v1.0.0/specification/a2a.proto');
  const card = createAgentCard('node-b', 'https://127.0.0.1:1234/a2a', ['frontend']);
  assert.equal(card.supportedInterfaces[0]?.protocolVersion, '1.0');
  assert.equal(card.supportedInterfaces[0]?.tenant, 'frontend');
  assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: false, extendedAgentCard: false });
  assert.deepEqual(card.securityRequirements, [{ schemes: { mutualTls: [] } }]);
  assert.equal(validateA2AAgentCard(card), card);
  const obsoleteSecurityShape = structuredClone(card) as unknown as Record<string, unknown>;
  obsoleteSecurityShape.securityRequirements = [{ mutualTls: [] }];
  assert.throws(() => validateA2AAgentCard(obsoleteSecurityShape), /schemes/);
  const extraCapability = structuredClone(card) as unknown as Record<string, any>;
  extraCapability.capabilities.futureCapability = false;
  assert.throws(() => validateA2AAgentCard(extraCapability), /unsupported field/);
});

test('production discovery and send reject unvalidated peer responses before recording receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-a2a-untrusted-response-'));
  const peerRoot = await mkdtemp(join(tmpdir(), 'agentlink-a2a-untrusted-peer-'));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(peerRoot, { recursive: true, force: true })]));
  await initializeNodeIdentity(root, 'node-client');
  await initializeNodeIdentity(peerRoot, 'node-peer');
  const [clientIdentity, peerIdentity, peerPrivate] = await Promise.all([
    exportPublicIdentity(root), exportPublicIdentity(peerRoot), loadNodeIdentity(peerRoot),
  ]);
  await addTrustedPeer(root, peerIdentity);
  const invalidCard = structuredClone(createAgentCard('node-peer', 'https://127.0.0.1:1/a2a', ['frontend'])) as any;
  invalidCard.capabilities.streaming = true;
  const server = createServer({
    key: peerPrivate.privateKeyPem,
    cert: peerPrivate.certificatePem,
    ca: clientIdentity.certificatePem,
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(invalidCard));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as any;
      const wrongId = rpc.params.message.messageId === 'mismatched-id';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: wrongId ? 'different-request-id' : rpc.id,
        result: {
          task: {
            id: 'task-malicious', contextId: 'other-conversation',
            status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
            history: [], metadata: {},
          },
        },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseAddress = `https://127.0.0.1:${address.port}`;

  await assert.rejects(discoverA2AAgent(root, baseAddress, peerIdentity), /unsupported capabilities/);
  await assert.rejects(sendA2AMessage(root, baseAddress, peerIdentity, {
    senderAgentId: 'backend', recipientAgentId: 'frontend', conversationId: 'orders-v2', body: 'first', messageId: 'mismatched-id',
  }), /request ID/);
  await assert.rejects(sendA2AMessage(root, baseAddress, peerIdentity, {
    senderAgentId: 'backend', recipientAgentId: 'frontend', conversationId: 'orders-v2', body: 'second', messageId: 'wrong-scope',
  }), /selected conversation/);
  assert.deepEqual((await readMailboxState(root)).outbox.map((entry) => entry.status), ['queued', 'queued']);
});

test('SendMessage creates a durable scoped task and GetTask survives restart-style reload', async (t) => {
  const { root } = await receiverFixture(t);
  const sent = await handleA2AJsonRpc(root, 'node-a', '1.0', sendRequest());
  assert.equal(sent.error, undefined);
  const task = (sent.result as { task: { id: string; contextId: string; status: { state: string } } }).task;
  assert.equal(task.contextId, 'orders-v2');
  assert.equal(task.status.state, 'TASK_STATE_SUBMITTED');
  const polled = await handleA2AJsonRpc(root, 'node-a', '1.0', {
    jsonrpc: '2.0', id: 'request-2', method: 'GetTask', params: { tenant: 'frontend', id: task.id, historyLength: 1 },
  });
  assert.equal((polled.result as { id: string }).id, task.id);
  const omittedTenant = await handleA2AJsonRpc(root, 'node-a', '1.0', {
    jsonrpc: '2.0', id: 'request-3', method: 'GetTask', params: { id: task.id },
  });
  assert.equal(omittedTenant.error?.code, -32602);
  const wrongTenant = await handleA2AJsonRpc(root, 'node-a', '1.0', {
    jsonrpc: '2.0', id: 'request-4', method: 'GetTask', params: { tenant: 'other-agent', id: task.id },
  });
  assert.equal(wrongTenant.error?.code, A2A_V1_SUBSET_FIXTURE.errors.taskNotFound);
  const inbox = (await readMailboxState(root)).inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.envelope.recipient.agentId, 'frontend');
  assert.equal(inbox[0]?.envelope.collaborationId, 'orders-v2');
});

test('SendMessage requires explicit non-blocking mode before returning a submitted task', async (t) => {
  const { root } = await receiverFixture(t);
  const blockingByDefault = sendRequest();
  delete (blockingByDefault.params as { configuration?: unknown }).configuration;
  const absent = await handleA2AJsonRpc(root, 'node-a', '1.0', blockingByDefault);
  assert.equal(absent.error?.code, A2A_V1_SUBSET_FIXTURE.errors.unsupportedOperation);

  const blocking = sendRequest();
  (blocking.params as { configuration: { returnImmediately: boolean } }).configuration.returnImmediately = false;
  const disabled = await handleA2AJsonRpc(root, 'node-a', '1.0', blocking);
  assert.equal(disabled.error?.code, A2A_V1_SUBSET_FIXTURE.errors.unsupportedOperation);

  const malformed = sendRequest();
  (malformed.params as { configuration: { returnImmediately: unknown } }).configuration.returnImmediately = 'true';
  const invalid = await handleA2AJsonRpc(root, 'node-a', '1.0', malformed);
  assert.equal(invalid.error?.code, -32602);
  assert.equal((await readMailboxState(root)).inbox.length, 0);
});

test('rejects incompatible versions, unsupported methods, spoofed actors, and denied grants', async (t) => {
  const { root } = await receiverFixture(t);
  const version = await handleA2AJsonRpc(root, 'node-a', '0.3', sendRequest());
  assert.equal(version.error?.code, A2A_V1_SUBSET_FIXTURE.errors.versionNotSupported);
  const unsupported = await handleA2AJsonRpc(root, 'node-a', '1.0', sendRequest({ method: 'SendStreamingMessage' }));
  assert.equal(unsupported.error?.code, A2A_V1_SUBSET_FIXTURE.errors.unsupportedOperation);
  for (const method of A2A_V1_SUBSET_FIXTURE.pushNotificationMethods) {
    const push = await handleA2AJsonRpc(root, 'node-a', '1.0', sendRequest({ method }));
    assert.equal(push.error?.code, A2A_V1_SUBSET_FIXTURE.errors.pushNotificationNotSupported);
  }
  const spoofed = structuredClone(sendRequest());
  ((spoofed.params as { message: { metadata: { agentlinkSenderAgentId: string } } }).message.metadata).agentlinkSenderAgentId = 'attacker';
  const spoofedResult = await handleA2AJsonRpc(root, 'node-a', '1.0', spoofed);
  assert.equal(spoofedResult.error?.code, A2A_V1_SUBSET_FIXTURE.errors.taskNotFound);
  const isolated = structuredClone(sendRequest());
  ((isolated.params as { message: { contextId: string } }).message).contextId = 'other-conversation';
  const isolatedResult = await handleA2AJsonRpc(root, 'node-a', '1.0', isolated);
  assert.equal(isolatedResult.error?.code, A2A_V1_SUBSET_FIXTURE.errors.taskNotFound);
  assert.equal((await readMailboxState(root)).inbox.length, 0);
});

test('GetTask rechecks the complete delivery grant after revocation and expiry', async (t) => {
  const { root } = await receiverFixture(t);
  const sent = await handleA2AJsonRpc(root, 'node-a', '1.0', sendRequest());
  const taskId = (sent.result as { task: { id: string } }).task.id;
  await revokeGrant(root, 'grant-a2a');
  const revoked = await handleA2AJsonRpc(root, 'node-a', '1.0', {
    jsonrpc: '2.0', id: 'revoked-poll', method: 'GetTask', params: { id: taskId, tenant: 'frontend' },
  });
  assert.equal(revoked.error?.code, A2A_V1_SUBSET_FIXTURE.errors.taskNotFound);

  const expiringRoot = await mkdtemp(join(tmpdir(), 'agentlink-a2a-expiring-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'agentlink-a2a-expiring-remote-'));
  t.after(async () => Promise.all([rm(expiringRoot, { recursive: true, force: true }), rm(remoteRoot, { recursive: true, force: true })]));
  await initializeNodeIdentity(expiringRoot, 'node-expiring-b');
  await initializeNodeIdentity(remoteRoot, 'node-expiring-a');
  await addTrustedPeer(expiringRoot, await exportPublicIdentity(remoteRoot));
  await addGrant(expiringRoot, {
    grantId: 'expiring-grant', remoteNodeId: 'node-expiring-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const expiringSent = await handleA2AJsonRpc(expiringRoot, 'node-expiring-a', '1.0', sendRequest());
  const expiringTaskId = (expiringSent.result as { task: { id: string } }).task.id;
  const trustPath = join(expiringRoot, 'trust.json');
  const trust = JSON.parse(await readFile(trustPath, 'utf8')) as { grants: Array<{ expiresAt: string }> };
  trust.grants[0]!.expiresAt = new Date(Date.now() - 1_000).toISOString();
  await writeFile(trustPath, `${JSON.stringify(trust)}\n`);
  const expired = await handleA2AJsonRpc(expiringRoot, 'node-expiring-a', '1.0', {
    jsonrpc: '2.0', id: 'expired-poll', method: 'GetTask', params: { id: expiringTaskId, tenant: 'frontend' },
  });
  assert.equal(expired.error?.code, A2A_V1_SUBSET_FIXTURE.errors.taskNotFound);
});

test('GetTask serializes an authorized poll result with concurrent grant revocation', async (t) => {
  const { root } = await receiverFixture(t);
  const sent = await handleA2AJsonRpc(root, 'node-a', '1.0', sendRequest());
  const taskId = (sent.result as { task: { id: string } }).task.id;
  const barrier = join(root, 'a2a-poll-test-barrier');
  process.env.AGENTLINK_TEST_A2A_POLL_BARRIER_ROOT = root;
  t.after(() => { delete process.env.AGENTLINK_TEST_A2A_POLL_BARRIER_ROOT; });

  const poll = handleA2AJsonRpc(root, 'node-a', '1.0', {
    jsonrpc: '2.0', id: 'concurrent-poll', method: 'GetTask', params: { id: taskId, tenant: 'frontend' },
  });
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await readFile(join(barrier, 'ready'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) throw new Error('GetTask did not reach the authorization barrier');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  let revocationCompleted = false;
  const revocation = revokeGrant(root, 'grant-a2a').then(() => { revocationCompleted = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(revocationCompleted, false, 'revocation must wait while the authorized poll result is constructed');
  await writeFile(join(barrier, 'continue'), 'continue\n');
  const polled = await poll;
  assert.equal((polled.result as { id: string }).id, taskId);
  await revocation;
  assert.equal(revocationCompleted, true);

  const afterRevocation = await handleA2AJsonRpc(root, 'node-a', '1.0', {
    jsonrpc: '2.0', id: 'after-concurrent-revoke', method: 'GetTask', params: { id: taskId, tenant: 'frontend' },
  });
  assert.equal(afterRevocation.error?.code, A2A_V1_SUBSET_FIXTURE.errors.taskNotFound);
});

test('expired tasks compact before quota checks so the task store recovers', async (t) => {
  const { root } = await receiverFixture(t);
  const first = await handleA2AJsonRpc(root, 'node-a', '1.0', sendRequest());
  assert.equal(first.error, undefined);
  const path = join(root, 'a2a-tasks.json');
  const state = JSON.parse(await readFile(path, 'utf8')) as { version: 1; tasks: Array<Record<string, unknown>> };
  const oldTimestamp = new Date(Date.now() - A2A_TASK_RETENTION_MS - 1_000).toISOString();
  const template = state.tasks[0]!;
  state.tasks = Array.from({ length: MAX_A2A_TASKS }, (_, index) => {
    const task = structuredClone(template) as any;
    task.task.id = `old-task-${index}`;
    task.task.status.timestamp = oldTimestamp;
    task.message.messageId = `old-message-${index}`;
    task.eventId = `old-event-${index}`;
    return task;
  });
  await writeFile(path, `${JSON.stringify(state)}\n`);
  const next = sendRequest();
  ((next.params as { message: { messageId: string } }).message).messageId = 'message-after-compaction';
  const sent = await handleA2AJsonRpc(root, 'node-a', '1.0', next);
  assert.equal(sent.error, undefined);
  const compacted = JSON.parse(await readFile(path, 'utf8')) as { tasks: unknown[] };
  assert.equal(compacted.tasks.length, 1);
});

test('outbound A2A queues before transmission and resumes once after sender restart-style reload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-a2a-sender-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'agentlink-a2a-receiver-'));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(remoteRoot, { recursive: true, force: true })]));
  await initializeNodeIdentity(root, 'node-sender');
  await initializeNodeIdentity(remoteRoot, 'node-receiver');
  const [local, remote] = await Promise.all([exportPublicIdentity(root), exportPublicIdentity(remoteRoot)]);
  await addTrustedPeer(root, remote);
  await addTrustedPeer(remoteRoot, local);
  await addGrant(remoteRoot, {
    grantId: 'resume-grant', remoteNodeId: 'node-sender', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'resume-thread', actions: ['deliver'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const probe = await startNetworkServer({ stateRoot: remoteRoot, host: '127.0.0.1', port: 0 });
  const port = probe.port;
  await probe.close();
  const address = `https://127.0.0.1:${port}`;
  await assert.rejects(sendA2AMessage(root, address, remote, {
    senderAgentId: 'backend', recipientAgentId: 'frontend', conversationId: 'resume-thread', body: 'durable body', messageId: 'resume-message',
  }));
  assert.equal((await readMailboxState(root)).outbox[0]?.status, 'queued');
  const server = await startNetworkServer({ stateRoot: remoteRoot, host: '127.0.0.1', port });
  t.after(() => server.close());
  const resumed = await resumePendingA2AMessages(root, address, remote);
  assert.equal(resumed.length, 1);
  assert.equal((await readMailboxState(root)).outbox[0]?.status, 'transport-received');
  assert.deepEqual((await readMailboxState(remoteRoot)).inbox.map((entry) => entry.envelope.body), ['durable body']);
  assert.equal((await resumePendingA2AMessages(root, address, remote)).length, 0);
});


test('A2A client bounds a dripping response by an absolute deadline', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-a2a-deadline-'));
  const peerRoot = await mkdtemp(join(tmpdir(), 'agentlink-a2a-drip-'));
  await initializeNodeIdentity(root, 'client');
  const peer = await initializeNodeIdentity(peerRoot, 'peer');
  const local = await exportPublicIdentity(root);
  await addTrustedPeer(root, await exportPublicIdentity(peerRoot));
  const server = createServer({ key: peer.privateKeyPem, cert: peer.certificatePem,
    ca: local.certificatePem, requestCert: true, rejectUnauthorized: true }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(' ');
    const interval = setInterval(() => response.write(' '), 100);
    response.once('close', () => clearInterval(interval));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([rm(root, { recursive: true, force: true }), rm(peerRoot, { recursive: true, force: true })]);
  });
  const address = server.address() as { port: number };
  const started = Date.now();
  await assert.rejects(discoverA2AAgent(root, `https://127.0.0.1:${address.port}`, await exportPublicIdentity(peerRoot)), /timed out/);
  assert.ok(Date.now() - started < 7000);
});

test('duplicate A2A message cannot be replayed into a different tenant', async (t) => {
  const { root } = await receiverFixture(t);
  const original = sendRequest();
  assert.ok((await handleA2AJsonRpc(root, 'node-a', '1.0', original)).result);
  original.params.tenant = 'ungranted-agent';
  const reply = await handleA2AJsonRpc(root, 'node-a', '1.0', original);
  assert.ok(reply.error);
  assert.equal((await readMailboxState(root)).inbox.length, 1);
});
