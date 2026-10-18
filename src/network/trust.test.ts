import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_GRANT_TTL_MS,
  addGrant,
  addTrustedPeer,
  authorizeDelivery,
  listGrantedLocalAgents,
  revokeGrant,
  revokeTrustedPeer,
} from './trust.js';
import { exportPublicIdentity, initializeNodeIdentity } from './identity.js';

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-network-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const futureExpiry = (): string => new Date(Date.now() + 60 * 60 * 1_000).toISOString();

test('trust and grants are separate and grants bind node, agents, collaboration, action and TTL', async (t) => {
  const root = await temporaryRoot(t);
  const peerRoot = await temporaryRoot(t);
  await initializeNodeIdentity(peerRoot, 'node-a');
  const peer = await exportPublicIdentity(peerRoot);
  await addTrustedPeer(root, peer);
  await assert.rejects(
    authorizeDelivery(root, peer.nodeId, 'backend', 'frontend', 'orders-v2'),
    /not granted/,
  );
  const grant = await addGrant(root, {
    grantId: 'grant-1',
    remoteNodeId: 'node-a',
    remoteAgentId: 'backend',
    localAgentId: 'frontend',
    collaborationId: 'orders-v2',
    actions: ['deliver'],
    expiresAt: futureExpiry(),
  });
  assert.equal((await authorizeDelivery(root, 'node-a', 'backend', 'frontend', 'orders-v2')).grantId, grant.grantId);
  await assert.rejects(authorizeDelivery(root, 'node-a', 'other', 'frontend', 'orders-v2'), /not granted/);
  await assert.rejects(authorizeDelivery(root, 'node-a', 'backend', 'other', 'orders-v2'), /not granted/);
  await assert.rejects(authorizeDelivery(root, 'node-a', 'backend', 'frontend', 'other'), /not granted/);
});

test('revocation is checked from durable state for every authorization', async (t) => {
  const root = await temporaryRoot(t);
  const peerRoot = await temporaryRoot(t);
  await initializeNodeIdentity(peerRoot, 'node-a');
  const peer = await exportPublicIdentity(peerRoot);
  await addTrustedPeer(root, peer);
  await addGrant(root, {
    grantId: 'grant-1', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });
  assert.deepEqual(await listGrantedLocalAgents(root, 'node-a'), ['frontend']);
  await authorizeDelivery(root, 'node-a', 'backend', 'frontend', 'orders-v2');
  await revokeGrant(root, 'grant-1');
  assert.deepEqual(await listGrantedLocalAgents(root, 'node-a'), []);
  await assert.rejects(authorizeDelivery(root, 'node-a', 'backend', 'frontend', 'orders-v2'), /revoked/);
});

test('revoking peer trust also refuses grants that were issued to that certificate identity', async (t) => {
  const root = await temporaryRoot(t);
  const peerRoot = await temporaryRoot(t);
  await initializeNodeIdentity(peerRoot, 'node-a');
  const peer = await exportPublicIdentity(peerRoot);
  await addTrustedPeer(root, peer);
  await addGrant(root, {
    grantId: 'grant-1', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });
  await revokeTrustedPeer(root, 'node-a');
  await assert.rejects(authorizeDelivery(root, 'node-a', 'backend', 'frontend', 'orders-v2'), /not trusted/);
});

test('replacing a revoked node ID with a new certificate does not reactivate old grants', async (t) => {
  const root = await temporaryRoot(t);
  const firstPeerRoot = await temporaryRoot(t);
  const replacementPeerRoot = await temporaryRoot(t);
  await Promise.all([
    initializeNodeIdentity(firstPeerRoot, 'node-a'),
    initializeNodeIdentity(replacementPeerRoot, 'node-a'),
  ]);
  const [firstPeer, replacementPeer] = await Promise.all([
    exportPublicIdentity(firstPeerRoot),
    exportPublicIdentity(replacementPeerRoot),
  ]);
  assert.notEqual(firstPeer.fingerprint, replacementPeer.fingerprint);
  await addTrustedPeer(root, firstPeer);
  await addGrant(root, {
    grantId: 'grant-old-certificate', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'], expiresAt: futureExpiry(),
  });
  await revokeTrustedPeer(root, 'node-a');
  await addTrustedPeer(root, replacementPeer);

  await assert.rejects(
    authorizeDelivery(root, 'node-a', 'backend', 'frontend', 'orders-v2'),
    /different peer certificate identity/i,
  );
});

test('grant expiry is strict ISO and bounded to a finite renewal window', async (t) => {
  const root = await temporaryRoot(t);
  const peerRoot = await temporaryRoot(t);
  await initializeNodeIdentity(peerRoot, 'node-a');
  await addTrustedPeer(root, await exportPublicIdentity(peerRoot));
  const now = new Date('2026-10-10T04:00:00.000Z');
  const input = {
    grantId: 'grant-bounded', remoteNodeId: 'node-a', remoteAgentId: 'backend', localAgentId: 'frontend',
    collaborationId: 'orders-v2', actions: ['deliver'] as ['deliver'],
  };

  await assert.rejects(addGrant(root, {
    ...input, expiresAt: new Date(now.getTime() + MAX_GRANT_TTL_MS + 1).toISOString(),
  }, now), /maximum grant lifetime/i);
  await assert.rejects(addGrant(root, { ...input, expiresAt: '2026-10-10 05:00:00Z' }, now), /strict ISO/i);
  const grant = await addGrant(root, {
    ...input, expiresAt: new Date(now.getTime() + MAX_GRANT_TTL_MS).toISOString(),
  }, now);
  assert.equal(grant.expiresAt, new Date(now.getTime() + MAX_GRANT_TTL_MS).toISOString());
});

test('trusted peer input is exact, bounded, and copied before persistence', async (t) => {
  const root = await temporaryRoot(t);
  const peerRoot = await temporaryRoot(t);
  await initializeNodeIdentity(peerRoot, 'node-a');
  const peer = await exportPublicIdentity(peerRoot);
  await assert.rejects(addTrustedPeer(root, { ...peer, secret: 'must-not-persist' } as typeof peer), /unknown field/);
  assert.equal(await readFile(join(root, 'trust.json'), 'utf8').catch(() => undefined), undefined);

  await addTrustedPeer(root, peer);
  peer.nodeId = 'mutated-after-call';
  const stored = await readFile(join(root, 'trust.json'), 'utf8');
  assert.doesNotMatch(stored, /mutated-after-call|must-not-persist/);
});
