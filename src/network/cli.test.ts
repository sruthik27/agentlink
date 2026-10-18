import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { exportPublicIdentity, initializeNodeIdentity } from './identity.js';
import { initializeWorkspaceIdentity, resolveActiveParticipant } from '../workspace.js';

test('top-level network CLI supports explicit node, peer, exposure, grant, and status configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-network-cli-'));
  const repo = join(root, 'repo');
  const localState = join(root, 'local-state');
  const remoteState = join(root, 'remote-state');
  const identityPath = join(root, 'remote-public.json');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(repo));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await initializeWorkspaceIdentity(repo);
  const actor = await resolveActiveParticipant(repo);
  const lines: string[] = [];
  const output = { log: (line: string) => lines.push(line), error: (_line: string) => undefined };

  await runCli(['network', 'node', 'init', '--state-root', localState, '--id', 'node-a'], repo, output);
  assert.deepEqual(Object.keys(JSON.parse(lines.pop()!)).sort(), ['fingerprint', 'nodeId']);
  await initializeNodeIdentity(remoteState, 'node-b');
  const remote = await exportPublicIdentity(remoteState);
  await writeFile(identityPath, JSON.stringify(remote));
  await runCli([
    'network', 'peer', 'pair', '--state-root', localState, '--name', 'remote',
    '--address', 'https://127.0.0.1:7443', '--identity', identityPath, '--fingerprint', remote.fingerprint,
  ], repo, output);
  await runCli([
    'network', 'peer', 'update-address', '--state-root', localState, '--name', 'remote',
    '--address', 'https://127.0.0.1:8443',
  ], repo, output);
  const updatedPeer = JSON.parse(lines.pop()!) as { nodeId: string; address: string };
  assert.equal(updatedPeer.nodeId, remote.nodeId);
  assert.equal(updatedPeer.address, 'https://127.0.0.1:8443');
  await runCli(['network', 'peer', 'list', '--state-root', localState], repo, output);
  const listedPeer = (JSON.parse(lines.pop()!) as Array<{ nodeId: string; address: string; fingerprint: string }>)[0]!;
  assert.equal(listedPeer.nodeId, remote.nodeId);
  assert.equal(listedPeer.fingerprint, remote.fingerprint);
  assert.equal(listedPeer.address, 'https://127.0.0.1:8443');
  await runCli(['network', 'agent', 'expose', '--state-root', localState, '--agent', actor.participantId, '--peer', 'remote'], repo, output);
  await runCli([
    'network', 'grant', 'add', '--state-root', localState, '--id', 'cli-grant', '--peer', 'remote',
    '--remote-agent', 'remote-agent', '--local-agent', actor.participantId, '--conversation', 'cli-thread',
    '--expires-at', new Date(Date.now() + 60_000).toISOString(),
  ], repo, output);
  assert.equal((JSON.parse(lines.pop()!) as { grantId: string }).grantId, 'cli-grant');
  const beforeTtl = Date.now();
  await runCli(['network', 'grant', 'add', '--state-root', localState, '--id', 'ttl-grant', '--peer', 'remote',
    '--remote-agent', 'remote-agent', '--local-agent', actor.participantId, '--conversation', 'ttl-thread', '--ttl', '2m'], repo, output);
  const ttlGrant = JSON.parse(lines.pop()!) as { expiresAt: string };
  assert(Date.parse(ttlGrant.expiresAt) >= beforeTtl + 120_000 && Date.parse(ttlGrant.expiresAt) <= Date.now() + 120_000);
  const seconds = new Date(Date.now() + 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await runCli(['network', 'collaboration', 'create', '--state-root', localState, '--id', 'cli-collaboration', '--peer', 'remote',
    '--agent', 'remote-agent', '--topic', 'CLI expiry normalization', '--expires-at', seconds], repo, output);
  assert.equal(JSON.parse(lines.pop()!).expiresAt, seconds.replace('Z', '.000Z'));
  await assert.rejects(runCli(['network', 'grant', 'add', '--state-root', localState, '--id', 'bad', '--peer', 'remote',
    '--remote-agent', 'remote-agent', '--local-agent', actor.participantId, '--conversation', 'orders', '--ttl', '2h', '--expires-at', seconds], repo, output), /exactly one/);
  await runCli(['network', 'doctor', '--state-root', localState], repo, output);
  assert.equal(JSON.parse(lines.pop()!).actorId, actor.participantId);
  await runCli(['network', 'grant', 'revoke', '--state-root', localState, '--id', 'cli-grant'], repo, output);
  assert.equal((JSON.parse(lines.pop()!) as { revoked: boolean }).revoked, true);
  await runCli(['network', 'status', '--state-root', localState], repo, output);
  const status = JSON.parse(lines.pop()!) as { actorId: string; peers: Array<{ name: string }>; exposures: unknown[] };
  assert.equal(status.actorId, actor.participantId);
  assert.deepEqual(status.peers.map((peer) => peer.name), ['remote']);
  assert.equal(status.exposures.length, 1);
  assert.equal(JSON.stringify(lines).includes('PRIVATE KEY'), false);
});

test('network help works without node state or a workspace', async () => {
  const lines: string[] = [];
  const output = { log: (s: string) => lines.push(s), error: (_s: string) => {} };
  await runCli(['network', '--help'], '/unused', output);
  assert.match(lines[0]!, /--ttl 12h/); assert.match(lines[0]!, /doctor/);
});

test('node init rejects a persistent private-key state root inside the active workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-network-cli-state-root-'));
  const repo = join(root, 'repo');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(repo));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const output = { log: (_line: string) => undefined, error: (_line: string) => undefined };
  await assert.rejects(
    runCli(['network', 'node', 'init', '--state-root', join(repo, 'private-network-state'), '--id', 'node-a'], repo, output),
    /outside the active workspace and repository/,
  );
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(join(repo, 'private-network-state', 'identity', 'private-key.pem'))));
  await assert.rejects(
    runCli(['network', 'node', 'init', '--state-root', join(repo, '..private-state'), '--id', 'node-a'], repo, output),
    /outside the active workspace and repository/,
  );
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(join(repo, '..private-state', 'identity', 'private-key.pem'))));
});
