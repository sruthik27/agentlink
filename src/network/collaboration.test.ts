import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeNodeIdentity, exportPublicIdentity } from './identity.js';
import { addGrant, revokeGrant } from './trust.js';
import { pairPeer, exposeAgent, updatePeerAddress } from './config.js';
import { createCollaboration, operateCollaboration, agreementAccepted, authorizeLocalExecution, parseCollaborationOperation, parseCollaborationSnapshot, revokeLocalExecution, withLocalExecution, requireLocalExecution, type CollaborationOperation } from './collaboration.js';
import { callCollaboration, readCachedCollaboration } from './collaboration-client.js';
import { startNetworkServer } from './server.js';
import { sha256 } from './types.js';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'agentlink-collaboration-'));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const a = join(base, 'state-a'), b = join(base, 'state-b');
  const repoA = join(base, 'repo-a'), repoB = join(base, 'repo-b');
  await Promise.all([mkdir(repoA), mkdir(repoB)]);
  await initializeNodeIdentity(a, 'a'); await initializeNodeIdentity(b, 'b');
  const [ia, ib] = await Promise.all([exportPublicIdentity(a), exportPublicIdentity(b)]);
  await pairPeer(a, { name: 'b', address: 'https://127.0.0.1:1', identity: ib, expectedFingerprint: ib.fingerprint });
  await pairPeer(b, { name: 'a', address: 'https://127.0.0.1:1', identity: ia, expectedFingerprint: ia.fingerprint });
  await exposeAgent(a, { agentId: 'author', workspaceRoot: repoA, peerName: 'b' });
  await exposeAgent(b, { agentId: 'reviewer', workspaceRoot: repoB, peerName: 'a' });
  await addGrant(a, { grantId: 'collab-grant', remoteNodeId: 'b', remoteAgentId: 'reviewer', localAgentId: 'author', collaborationId: 'orders', actions: ['deliver'], expiresAt: new Date(Date.now() + 600_000).toISOString() });
  await createCollaboration(a, { id: 'orders', localAgentId: 'author', remoteNodeId: 'b', remoteAgentId: 'reviewer', topic: 'Orders API', expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const actorA = { nodeId: 'a', agentId: 'author' }, actorB = { nodeId: 'b', agentId: 'reviewer' };
  let n = 0;
  const op = (actor: typeof actorA, type: CollaborationOperation['type'], extra = {}) => operateCollaboration(a, 'orders', actor, { type, requestId: `request-${++n}`, ...extra });
  const negotiate = async () => {
    await op(actorB, 'accept');
    const c = await op(actorA, 'propose', { expectedRevision: 0, content: 'GET /orders; bearer auth; cursor pagination; 401/404' });
    await op(actorA, 'approve', { expectedRevision: c.revision, digest: c.digest });
    return await op(actorB, 'approve', { expectedRevision: c.revision, digest: c.digest });
  };
  return { a, b, repoA, repoB, actorA, actorB, op, negotiate };
}

test('invitation, principal approvals, stale revisions, edit invalidation and durable audit', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.op(f.actorB, 'propose', { expectedRevision: 0, content: 'unaccepted' }), /Invitation/);
  await assert.rejects(f.op({ nodeId: 'b', agentId: 'impostor' }, 'get'), /principal/);
  const c = await f.negotiate();
  assert.equal(agreementAccepted(c), true);
  assert.equal(c.digest, sha256(c.content));
  await assert.rejects(f.op(f.actorB, 'propose', { expectedRevision: 0, content: 'stale' }), /Stale/);
  const edited = await f.op(f.actorB, 'propose', { expectedRevision: 1, content: 'revised endpoint' });
  assert.deepEqual(edited.approvals, []);
  await assert.rejects(f.op(f.actorA, 'approve', { expectedRevision: 1, digest: c.digest }), /exact current/);
  await f.op(f.actorA, 'approve', { expectedRevision: 2, digest: edited.digest });
  const single = await f.op(f.actorA, 'approve', { expectedRevision: 2, digest: edited.digest });
  assert.equal(agreementAccepted(single), false);
  const persisted = JSON.parse(await readFile(join(f.a, 'collaborations.json'), 'utf8'));
  assert.equal(parseCollaborationSnapshot(persisted.conversations[0]).revision, 2);
  assert.deepEqual(single.audit.map((a) => a.sequence), single.audit.map((_, i) => i + 1));
});

test('idempotent operation retry and conflicting replay survive reload', async (t) => {
  const f = await fixture(t); await f.negotiate();
  const request = { type: 'discuss', requestId: 'stable-retry', content: 'Please use opaque cursors' };
  const first = await operateCollaboration(f.a, 'orders', f.actorB, request);
  const retry = await operateCollaboration(f.a, 'orders', f.actorB, request);
  assert.deepEqual(retry, first);
  await assert.rejects(operateCollaboration(f.a, 'orders', f.actorB, { ...request, content: 'conflict' }), /Conflicting/);
});

test('recipient-only processing evidence, task states, cancellation and second task', async (t) => {
  const f = await fixture(t); const c = await f.negotiate();
  const task = (id: string) => f.op(f.actorA, 'task', { taskId: id, expectedRevision: c.revision, digest: c.digest, content: 'Implement locally and test' });
  await task('one');
  const evidence = { summary: 'Ran contract tests', artifactDigest: sha256('source'), testDigest: sha256('test output') };
  await assert.rejects(f.op(f.actorA, 'processed', { taskId: 'one', evidence }), /recipient/);
  await assert.rejects(f.op(f.actorB, 'processed', { taskId: 'one', evidence }), /agent-read/);
  await f.op(f.actorB, 'read', { taskId: 'one' });
  await assert.rejects(f.op(f.actorA, 'propose', { expectedRevision: 1, content: 'changed while running' }), /active tasks/);
  const done = await f.op(f.actorB, 'processed', { taskId: 'one', evidence });
  assert.equal(done.tasks[0]!.phase, 'processed');
  await task('two'); await f.op(f.actorB, 'read', { taskId: 'two' });
  await f.op(f.actorA, 'cancel-task', { taskId: 'two' });
  await assert.rejects(f.op(f.actorB, 'processed', { taskId: 'two', evidence }), /agent-read/);
  const cancelled = await f.op(f.actorB, 'cancelled-task', { taskId: 'two' });
  assert.equal(cancelled.tasks[1]!.phase, 'cancelled');
});

test('revocation prevents remote reads, retries and mutations', async (t) => {
  const f = await fixture(t); await f.negotiate();
  await revokeGrant(f.a, 'collab-grant');
  await assert.rejects(f.op(f.actorB, 'get'), /revoked/);
  await assert.rejects(f.op(f.actorB, 'discuss', { content: 'after revocation' }), /revoked/);
  assert.equal((await f.op(f.actorA, 'get')).revision, 1);
});

test('strict operation validation rejects paths, actor rebinding, invalid evidence and oversize exports', () => {
  assert.throws(() => parseCollaborationOperation({ type: 'get', requestId: '../x' }), /invalid/);
  assert.throws(() => parseCollaborationOperation({ type: 'accept', requestId: 'x', agentId: 'spoof' }), /Unsupported/);
  assert.throws(() => parseCollaborationOperation({ type: 'propose', requestId: 'x', expectedRevision: 1, content: 'x'.repeat(12001) }), /oversized/);
  assert.throws(() => parseCollaborationOperation({ type: 'processed', requestId: 'x', taskId: 'task', evidence: { summary: 'yes', artifactDigest: 'bad', testDigest: sha256('') } }), /digest/);
});

test('real mTLS client binds scope, queues offline retries, and enforces local owner permits', async (t) => {
  const f = await fixture(t); const c = await f.negotiate();
  const server = await startNetworkServer({ stateRoot: f.a, host: '127.0.0.1', port: 0 });
  t.after(async () => { if (server.server.listening) await server.close(); });
  await updatePeerAddress(f.b, { name: 'a', address: `https://127.0.0.1:${server.port}` });
  const binding = { stateRoot: f.b, agentId: 'reviewer', workspaceRoot: f.repoB };
  const target = { peer: 'a', agent: 'author', conversationId: 'orders', authority: 'peer' as const };
  await f.op(f.actorA, 'task', { taskId: 'work', expectedRevision: c.revision, digest: c.digest, content: 'Review local code' });
  await assert.rejects(callCollaboration(binding, target, { type: 'read', requestId: 'read-one', taskId: 'work' }), /Owner execution/);
  await authorizeLocalExecution(f.b, { agentId: 'reviewer', workspaceRoot: f.repoB, collaboration: c, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const read = await callCollaboration(binding, target, { type: 'read', requestId: 'read-one', taskId: 'work' });
  assert.equal(read.snapshot.tasks[0]!.phase, 'agent-read');
  await assert.rejects(callCollaboration({ ...binding, workspaceRoot: f.repoA }, target, { type: 'get', requestId: 'other-repo' }), /owner-exposed/);
  await server.close();
  await assert.rejects(callCollaboration(binding, target, { type: 'discuss', requestId: 'offline', content: 'Queued during disconnect' }));
  const cache = await readCachedCollaboration(binding, target);
  assert.equal(cache.cached, true);
  const queued = JSON.parse(await readFile(join(f.b, 'collaboration-client.json'), 'utf8')).requests.find((r: { key: string }) => r.key.endsWith('/offline'));
  assert.equal(queued.status, 'queued');
  const restarted = await startNetworkServer({ stateRoot: f.a, host: '127.0.0.1', port: server.port });
  t.after(async () => { await restarted.close(); });
  const resumed = await callCollaboration(binding, target, { type: 'discuss', requestId: 'offline', content: 'Queued during disconnect' });
  assert.equal(resumed.snapshot.audit.filter((a) => a.requestId === 'offline').length, 1);
});

test('conversation cancellation requires recipient confirmation and never claims work stopped', async (t) => {
  const f = await fixture(t); const c = await f.negotiate();
  await f.op(f.actorA, 'task', { taskId: 'running', expectedRevision: c.revision, digest: c.digest, content: 'Local work' });
  await f.op(f.actorB, 'read', { taskId: 'running' });
  const cancelled = await f.op(f.actorA, 'cancel');
  assert.equal(cancelled.tasks[0]!.phase, 'cancel-requested');
  await assert.rejects(f.op(f.actorB, 'processed', { taskId: 'running', evidence: { summary: 'late', artifactDigest: sha256(''), testDigest: sha256('') } }), /cancelled/);
  const confirmed = await f.op(f.actorB, 'cancelled-task', { taskId: 'running' });
  assert.equal(confirmed.tasks[0]!.phase, 'cancelled');
});

test('persisted limits preserve audit and replay evidence when new work is rejected', async (t) => {
  const f = await fixture(t); const c = await f.negotiate();
  for (let i = 0; i < 16; i++) await f.op(f.actorA, 'task', { taskId: `bounded-${i}`, expectedRevision: c.revision, digest: c.digest, content: 'bounded task' });
  await assert.rejects(f.op(f.actorA, 'task', { taskId: 'overflow', expectedRevision: c.revision, digest: c.digest, content: 'seventeenth' }), /quota/);
  const durable = await f.op(f.actorA, 'get');
  assert.equal(durable.tasks.length, 16);
  assert.equal(durable.audit.filter((a) => a.operation.type === 'task').length, 16);
  let rejected = false;
  for (let i = 0; i < 256; i++) {
    try { await f.op(f.actorB, 'discuss', { content: 'x'.repeat(2000) }); }
    catch (e) { assert.match((e as Error).message, /quota/); rejected = true; break; }
  }
  assert.equal(rejected, true);
  assert.equal((await f.op(f.actorA, 'get')).tasks.length, 16);
});

test('wrong target local call fails before any authority mutation', async (t) => {
  const f = await fixture(t); await f.negotiate();
  const binding = { stateRoot: f.a, agentId: 'author', workspaceRoot: f.repoA };
  const before = await f.op(f.actorA, 'get');
  await assert.rejects(callCollaboration(binding, { peer: 'b', agent: 'wrong-recipient', conversationId: 'orders', authority: 'local' }, { type: 'cancel', requestId: 'wrong-target' }), /scope mismatch/);
  const after = await f.op(f.actorA, 'get');
  assert.deepEqual(after, before);
});


test('owner permit revocation serializes with processing acknowledgements', async (t) => {
  const f = await fixture(t); const c = await f.negotiate();
  await authorizeLocalExecution(f.b, { agentId: 'reviewer', workspaceRoot: f.repoB, collaboration: c, expiresAt: new Date(Date.now() + 60000).toISOString() });
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const pending = withLocalExecution(f.b, c, 'reviewer', f.repoB, async () => { started(); await barrier; });
  await ready;
  let completed = false;
  const revoking = revokeLocalExecution(f.b, 'orders', 'reviewer').then(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completed, false, 'Revoke must not claim completion while an earlier acknowledgement is authorized');
  release(); await pending; await revoking;
  await assert.rejects(requireLocalExecution(f.b, c, 'reviewer', f.repoB), /Owner execution/);
});

test('remote wrong-authority target is rejected before invitation mutation', async (t) => {
  const f = await fixture(t);
  const server = await startNetworkServer({ stateRoot: f.a, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  await updatePeerAddress(f.b, { name: 'a', address: `https://127.0.0.1:${server.port}` });
  const before = await f.op(f.actorA, 'get');
  await assert.rejects(callCollaboration({ stateRoot: f.b, agentId: 'reviewer', workspaceRoot: f.repoB },
    { peer: 'a', agent: 'wrong-authority', conversationId: 'orders', authority: 'peer' }, { type: 'accept', requestId: 'wrong-target-accept' }), /scope mismatch/);
  assert.deepEqual(await f.op(f.actorA, 'get'), before);
});

test('owner permits cannot cross workspace or authority actor boundaries', async (t) => {
  const f = await fixture(t); const c = await f.negotiate();
  await authorizeLocalExecution(f.b, { agentId: 'reviewer', workspaceRoot: f.repoB, collaboration: c, expiresAt: new Date(Date.now() + 60000).toISOString() });
  await requireLocalExecution(f.b, c, 'reviewer', f.repoB);
  await assert.rejects(requireLocalExecution(f.b, c, 'reviewer', f.repoA), /Owner execution/);
  const otherAuthority = { ...c, authority: { ...c.authority, agentId: 'another-authority' } };
  await assert.rejects(requireLocalExecution(f.b, otherAuthority, 'reviewer', f.repoB), /Owner execution/);
});

test('ordinary byte exhaustion reserves completion capacity for every active task', async (t) => {
  const f = await fixture(t); const c = await f.negotiate();
  for (let i = 0; i < 16; i++) {
    await f.op(f.actorA, 'task', { taskId: `work-${i}`.padEnd(128, 'x'), expectedRevision: c.revision, digest: c.digest, content: 'bounded work' });
  }
  let full = false;
  for (let i = 0; i < 192; i++) {
    try { await f.op(f.actorB, 'discuss', { content: 'x'.repeat(2000) }); }
    catch (e) { assert.match((e as Error).message, /quota/); full = true; break; }
  }
  assert.equal(full, true);
  for (let i = 0; i < 16; i++) {
    const taskId = `work-${i}`.padEnd(128, 'x');
    await f.op(f.actorB, 'read', { taskId, requestId: `read-${i}`.padEnd(128, 'r') });
    await f.op(f.actorB, 'processed', { taskId, requestId: `done-${i}`.padEnd(128, 'r'), evidence: { summary: '\x01'.repeat(42), artifactDigest: sha256('a'), testDigest: sha256('t') } });
  }
  const done = await f.op(f.actorA, 'get');
  assert.equal(done.tasks.filter((task) => task.phase === 'processed').length, 16);
  assert.equal((await f.op(f.actorA, 'cancel')).cancelled, true);
});

test('client ledger reserves terminal entries after ordinary request quota exhaustion', async (t) => {
  const f = await fixture(t); const c = await f.negotiate();
  const server = await startNetworkServer({ stateRoot: f.a, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  await updatePeerAddress(f.b, { name: 'a', address: `https://127.0.0.1:${server.port}` });
  await f.op(f.actorA, 'task', { taskId: 'pending', expectedRevision: c.revision, digest: c.digest, content: 'cancellable work' });
  const binding = { stateRoot: f.b, agentId: 'reviewer', workspaceRoot: f.repoB };
  const target = { peer: 'a', agent: 'author', conversationId: 'orders', authority: 'peer' as const };
  await callCollaboration(binding, target, { type: 'discuss', requestId: 'first', content: 'hello' });
  const file = join(f.b, 'collaboration-client.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  const first = ledger.requests[0];
  const scope = first.key.slice(0, first.key.lastIndexOf('/'));
  // Simulate a full persisted ledger without exhausting the authority's separate quota.
  ledger.requests = Array.from({ length: 192 }, (_, i) => ({ ...first, key: `${scope}/prior-${i}` }));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(ledger)));
  await assert.rejects(callCollaboration(binding, target, { type: 'discuss', requestId: 'overflow', content: 'blocked' }), /Client operation quota/);
  await f.op(f.actorA, 'cancel-task', { taskId: 'pending' });
  const ack = await callCollaboration(binding, target, { type: 'cancelled-task', requestId: 'cancel-confirmed', taskId: 'pending' });
  assert.equal(ack.snapshot.tasks[0]!.phase, 'cancelled');
});

test('terminal text bounds include JSON escaping', () => {
  assert.throws(() => parseCollaborationOperation({ type: 'processed', requestId: 'escaped', taskId: 'task', evidence: { summary: '\x01'.repeat(256), artifactDigest: sha256('a'), testDigest: sha256('t') } }), /encoded/);
  assert.throws(() => parseCollaborationOperation({ type: 'fail', requestId: 'escaped', taskId: 'task', content: '\x01'.repeat(256) }), /encoded/);
});
