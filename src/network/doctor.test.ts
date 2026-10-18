import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNetworkDoctor } from './doctor.js';
import { initializeWorkspaceIdentity, resolveActiveParticipant } from '../workspace.js';
import { initializeNodeIdentity, exportPublicIdentity } from './identity.js';
import { pairPeer, exposeAgent } from './config.js';
import { addGrant } from './trust.js';
import { createCollaboration } from './collaboration.js';
import { enrollNetworkWake } from './wake.js';

test('doctor does not initialize or modify an unconfigured project/state root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-doctor-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  assert.equal((await collectNetworkDoctor(join(root, 'missing'), repo)).ok, false);
  assert.deepEqual(await readdir(repo), []);
  const state = join(root, 'state'); await mkdir(state);
  const report = await collectNetworkDoctor(state, repo);
  assert.equal(report.ok, false); assert(report.checks.some(c => c.code === 'actor' && !c.ok));
  assert.deepEqual(await readdir(repo), []); assert.deepEqual(await readdir(state), []);
  const hiddenChild = join(repo, '..private-state'); await mkdir(hiddenChild);
  const nested = await collectNetworkDoctor(hiddenChild, repo);
  assert(nested.checks.some(c => c.code === 'state-root' && !c.ok));
  await assert.rejects(enrollNetworkWake({
    id: 'hidden-state', stateRoot: hiddenChild, workspaceRoot: repo, peer: 'peer', remoteAgentId: 'frontend',
    authority: 'local', conversations: ['orders'], harness: 'claude-monitor',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), policy: 'Observe only',
    mcpEntrypoint: fileURLToPath(new URL('../mcp/server.js', import.meta.url)),
  }), /Wake state must be outside workspace/);
});

test('doctor reports expiry, actor exposure and MCP mismatch without leaking payloads, secrets or writing state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), state = join(root, 'state'), remote = join(root, 'remote'); await mkdir(repo);
  const context = await initializeWorkspaceIdentity(repo); const actor = await resolveActiveParticipant(repo);
  await initializeNodeIdentity(state, 'local'); await initializeNodeIdentity(remote, 'remote');
  const identity = await exportPublicIdentity(remote);
  await pairPeer(state, { name: 'peer', address: 'https://127.0.0.1:1', identity, expectedFingerprint: identity.fingerprint });
  await exposeAgent(state, { agentId: actor.participantId, workspaceRoot: repo, peerName: 'peer' });
  const expiry = new Date(Date.now() + 60_000).toISOString();
  await addGrant(state, { grantId: 'grant', remoteNodeId: 'remote', remoteAgentId: 'frontend', localAgentId: actor.participantId, collaborationId: 'orders', actions: ['deliver'], expiresAt: expiry });
  await createCollaboration(state, { id: 'orders', localAgentId: actor.participantId, remoteNodeId: 'remote', remoteAgentId: 'frontend', topic: 'PRIVATE DISCUSSION TOPIC', expiresAt: expiry });
  const wake = await enrollNetworkWake({ id: 'doctor-wake', stateRoot: state, workspaceRoot: repo, peer: 'peer', remoteAgentId: 'frontend',
    authority: 'local', conversations: ['orders'], harness: 'claude-monitor', expiresAt: expiry,
    policy: 'SECRET_OWNER_POLICY', mcpEntrypoint: fileURLToPath(new URL('../mcp/server.js', import.meta.url)) });
  const queuePath = join(wake.stateRoot, 'wake', 'doctor-wake-queue.json');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  queue.jobs.push({ state: 'suspended', summary: 'SECRET_JOB_SUMMARY', attempts: 1 });
  await writeFile(queuePath, JSON.stringify(queue));
  await writeFile(join(wake.stateRoot, 'wake', `active-${actor.participantId}.json`), 'null');
  await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'agentlink-network': { command: 'node', args: ['/install/dist/mcp/server.js'], env: { AGENTLINK_NETWORK_STATE_ROOT: remote, API_TOKEN: 'SECRET_VALUE' } }, unrelated: { command: 'DO_NOT_EXECUTE' } } }));
  const tracked = [join(state, 'trust.json'), join(state, 'network-config.json'), join(state, 'collaborations.json'), join(repo, '.mcp.json')];
  const before = await Promise.all(tracked.map(f => readFile(f, 'utf8')));
  // Existing workspace helpers normally repair these; doctor must never do so.
  await rm(join(context.association.busPath, 'registrations.json'));
  await rm(join(context.association.busPath, 'notifications'), { recursive: true });
  const report = await collectNetworkDoctor(state, repo, Date.parse(expiry) + 1);
  assert.equal(report.actorId, actor.participantId);
  assert.equal(report.exposures?.[0]?.exposedFromThisWorkspace, true);
  assert.equal(report.grants?.[0]?.expired, true); assert.equal(report.grants?.[0]?.remainingSeconds, 0);
  assert.equal(report.grants?.[0]?.peerIdentityMatches, true);
  assert.equal(report.conversations?.[0]?.expired, true);
  assert.equal(report.mcp?.stateRootMatches, false); assert.equal(report.daemon?.status, 'not-probed');
  assert(!JSON.stringify(report).includes('SECRET_VALUE')); assert(!JSON.stringify(report).includes('PRIVATE DISCUSSION TOPIC'));
  assert(!JSON.stringify(report).includes('CERTIFICATE')); assert(!JSON.stringify(report).includes('PRIVATE KEY'));
  assert(!JSON.stringify(report).includes('SECRET_OWNER_POLICY')); assert(!JSON.stringify(report).includes('SECRET_JOB_SUMMARY'));
  assert.equal((report.wake?.[0]?.jobs as Record<string, number>).suspended, 1);
  assert.deepEqual(await Promise.all(tracked.map(f => readFile(f, 'utf8'))), before);
  assert.equal((await readdir(context.association.busPath)).includes('registrations.json'), false);
  assert.equal((await readdir(context.association.busPath)).includes('notifications'), false);
  await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'agentlink-network': { command: 'node', args: ['/install/dist/mcp/server.js'], env: {
    AGENTLINK_NETWORK_STATE_ROOT: state, AGENTLINK_WAKE_CONFIG: wake.configPath,
  } } } }));
  const bound = await collectNetworkDoctor(state, repo);
  assert.equal(bound.mcp?.wakeBindingMatches, true);
  assert(bound.checks.some(c => c.code === 'wake:doctor-wake' && !c.ok && /Uncertain/.test(c.message)));
  const alias = join(root, 'state-alias'); await symlink(state, alias);
  await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'agentlink-network': { command: 'node', args: ['/install/dist/mcp/server.js'], env: {
    AGENTLINK_NETWORK_STATE_ROOT: alias, AGENTLINK_WAKE_CONFIG: join(alias, 'wake', 'doctor-wake.json'),
  } } } }));
  assert.equal((await collectNetworkDoctor(state, repo)).mcp?.wakeBindingMatches, true);
  await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'agentlink-network': { command: process.execPath, args: [
    '/install/dist/mcp/launch.js', '--workspace', repo, '--state-root', state, '--wake-config', wake.configPath,
  ] } } }));
  const launched = await collectNetworkDoctor(state, repo);
  assert.equal(launched.mcp?.stateRootMatches, true); assert.equal(launched.mcp?.wakeBindingMatches, true);
  for (const [text, code] of [['{SECRET_INVALID_JSON', 'project-mcp-json'], [' '.repeat(256001), 'project-mcp-size']] as const) {
    await writeFile(join(repo, '.mcp.json'), text);
    const invalid = await collectNetworkDoctor(state, repo);
    assert(invalid.checks.some(c => c.code === code && !c.ok));
    assert(!invalid.checks.some(c => c.code === 'project-mcp'));
    assert(!JSON.stringify(invalid).includes('SECRET_INVALID_JSON'));
    assert.equal(await readFile(join(repo, '.mcp.json'), 'utf8'), text);
  }
  const elsewhere = join(root, 'elsewhere.json'); await writeFile(elsewhere, '{}');
  await rm(join(repo, '.mcp.json')); await symlink(elsewhere, join(repo, '.mcp.json'));
  assert((await collectNetworkDoctor(state, repo)).checks.some(c => c.code === 'project-mcp-symlink' && !c.ok));
  assert.equal(await readFile(elsewhere, 'utf8'), '{}');
});
