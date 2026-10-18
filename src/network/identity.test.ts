import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPublicIdentity, initializeNodeIdentity, loadNodeIdentity } from './identity.js';

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-network-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('node identity persists a private key with owner-only permissions and exports public material only', async (t) => {
  const root = await temporaryRoot(t);
  const identity = await initializeNodeIdentity(root, 'node-a');
  assert.equal(identity.nodeId, 'node-a');
  assert.match(identity.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await stat(join(root, 'identity', 'private-key.pem'))).mode & 0o777, 0o600);

  const loaded = await loadNodeIdentity(root);
  assert.equal(loaded.fingerprint, identity.fingerprint);
  const exported = await exportPublicIdentity(root);
  assert.deepEqual(Object.keys(exported).sort(), ['certificatePem', 'fingerprint', 'nodeId', 'version']);
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE KEY/);
  assert.match(await readFile(join(root, 'identity', 'private-key.pem'), 'utf8'), /PRIVATE KEY/);
});

test('node identity rejects unsafe node IDs and refuses replacement', async (t) => {
  const root = await temporaryRoot(t);
  await assert.rejects(initializeNodeIdentity(root, '../node-a'), /nodeId/);
  await initializeNodeIdentity(root, 'node-a');
  await assert.rejects(initializeNodeIdentity(root, 'node-b'), /already exists/);
});

test('node identity refuses symlink-swapped roots and insecure private key permissions', async (t) => {
  const root = await temporaryRoot(t);
  await initializeNodeIdentity(root, 'node-a');
  await chmod(join(root, 'identity', 'private-key.pem'), 0o644);
  await assert.rejects(loadNodeIdentity(root), /private key.*permissions/i);

  const linkRoot = join(await temporaryRoot(t), 'linked-state');
  await symlink(root, linkRoot);
  await assert.rejects(loadNodeIdentity(linkRoot), /state root.*symbolic link/i);

  const replacementRoot = await temporaryRoot(t);
  await initializeNodeIdentity(replacementRoot, 'node-replacement');
  const keyPath = join(root, 'identity', 'private-key.pem');
  await chmod(keyPath, 0o600);
  await rename(keyPath, `${keyPath}.original`);
  await symlink(join(replacementRoot, 'identity', 'private-key.pem'), keyPath);
  await assert.rejects(loadNodeIdentity(root), /private key.*symbolic link/i);
});
