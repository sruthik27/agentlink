import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { assertNotSymlink } from '../atomic.js';
import { readActiveParticipant } from '../workspace.js';
import { exportPublicIdentity } from './identity.js';
import { listPairedPeers, requireAgentExposure } from './config.js';
import { listLocalGrantSummaries } from './trust.js';
import { listLocalCollaborationSummaries } from './collaboration.js';
import { networkWakeStatus, readNetworkWakeConfig } from './wake.js';

/** Owner-local, read-only inspection. Never probes peers, executes a harness or exports secrets. */
export async function collectNetworkDoctor(stateRoot: string, cwd: string, now = Date.now()) {
  const checks: Array<{ code: string; ok: boolean; message: string }> = [];
  const check = (code: string, ok: boolean, message: string) => checks.push({ code, ok, message });
  const workspace = await realpath(cwd);
  let root: string;
  try { root = await realpath(stateRoot); }
  catch { return { version: 1, ok: false, checks: [{ code: 'state-root', ok: false, message: 'State root does not exist; initialize an external private node state directory' }] }; }
  const rel = relative(workspace, root);
  check('state-root', rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)), 'Private node state must be outside this workspace');
  let actorId: string | undefined;
  try { actorId = (await readActiveParticipant(workspace)).participantId; check('actor', true, 'Existing workspace actor selected'); }
  catch { check('actor', false, 'No valid actor in this project; start in the intended repo and run agentlink init/actor use'); }
  let identity: { nodeId: string; fingerprint: string } | undefined;
  try { const node = await exportPublicIdentity(root); identity = { nodeId: node.nodeId, fingerprint: node.fingerprint }; check('identity', true, 'Public node identity readable'); }
  catch { check('identity', false, 'Missing or invalid public node identity'); }
  let peers: Awaited<ReturnType<typeof listPairedPeers>> = [];
  try { peers = await listPairedPeers(root); check('peers', peers.length > 0, peers.length ? 'Pinned peer routes configured (reachability not probed)' : 'No pinned peers; exchange and verify public fingerprints first'); }
  catch { check('peers', false, 'Invalid peer route or trust metadata; inspect local pairing'); }
  const exposures: Array<{ peerNodeId: string; exposedFromThisWorkspace: boolean }> = [];
  if (actorId) for (const peer of peers) {
    let exposed = false;
    try { await requireAgentExposure(root, { agentId: actorId, workspaceRoot: workspace, peerNodeId: peer.nodeId }); exposed = true; } catch {}
    exposures.push({ peerNodeId: peer.nodeId, exposedFromThisWorkspace: exposed });
    check(`exposure:${peer.name}`, exposed, exposed ? 'Actor exposed from this workspace' : 'Actor not exposed from this workspace; pairing alone grants no access');
  }
  const ttl = (expiresAt: string) => ({ expiresAt, remainingSeconds: Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000)), expired: Date.parse(expiresAt) <= now });
  let grants: Array<Record<string, unknown>> = [];
  let conversations: Array<Record<string, unknown>> = [];
  if (actorId) {
    try {
      const summaries = await listLocalGrantSummaries(root, actorId);
      grants = summaries.map(g => ({ ...g, ...ttl(g.expiresAt) }));
      check('grants', summaries.some(g => g.peerIdentityMatches && !g.revoked && Date.parse(g.expiresAt) > now), 'Incoming grants are separate from pairing; expired/revoked grants or a changed peer identity need explicit owner action');
    } catch { check('grants', false, 'Invalid local grant metadata'); }
    if (identity) try {
      conversations = (await listLocalCollaborationSummaries(root, identity.nodeId, actorId)).map(c => ({ ...c, ...ttl(c.expiresAt) }));
    } catch { check('collaborations', false, 'Invalid collaboration metadata'); }
  }
  let mcp: { configured: boolean; stateRootMatches?: boolean; wakeConfigured?: boolean; wakeBindingMatches?: boolean } = { configured: false };
  let mcpIssue: string | undefined;
  let mcpPhase = 'project-mcp-symlink';
  try {
    const file = join(workspace, '.mcp.json'); await assertNotSymlink(file, 'Project MCP config');
    mcpPhase = 'project-mcp-size';
    if ((await stat(file)).size > 256_000) throw new Error('Oversized MCP config');
    mcpPhase = 'project-mcp-json';
    const config = JSON.parse(await readFile(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid MCP object');
    mcpPhase = 'project-mcp-binding';
    const server = config.mcpServers?.['agentlink-network'];
    if (server && typeof server.command === 'string' && Array.isArray(server.args) && server.args.some((a: unknown) => typeof a === 'string' && /(?:^|\/)dist\/mcp\/(?:server|launch)\.js$/.test(a))) {
      const launcher = server.args.some((a: unknown) => typeof a === 'string' && /(?:^|\/)dist\/mcp\/launch\.js$/.test(a));
      const arg = (name: string): unknown => { const i = server.args.indexOf(name); return i >= 0 ? server.args[i + 1] : undefined; };
      const statePath = launcher ? arg('--state-root') : server.env?.AGENTLINK_NETWORK_STATE_ROOT;
      const wakePath = launcher ? arg('--wake-config') : server.env?.AGENTLINK_WAKE_CONFIG;
      const projectPath = launcher ? arg('--workspace') : workspace;
      const matches = typeof statePath === 'string' && await realpath(statePath) === root && typeof projectPath === 'string' && await realpath(projectPath) === workspace;
      mcp = { configured: true, stateRootMatches: matches, wakeConfigured: typeof wakePath === 'string' };
      if (mcp.wakeConfigured) {
        mcp.wakeBindingMatches = false;
        const rawPath = wakePath as string;
        const path = isAbsolute(rawPath) ? await realpath(rawPath) : rawPath;
        if (isAbsolute(path) && dirname(path) === await realpath(join(root, 'wake'))) {
          const wake = await readNetworkWakeConfig(path, true);
          mcp.wakeBindingMatches = wake.stateRoot === root && wake.workspaceRoot === workspace && wake.agentId === actorId;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mcpPhase === 'project-mcp-binding') mcpIssue = mcpPhase;
  }
  if (mcpIssue) check(mcpIssue, false, {
    'project-mcp-symlink': 'Project .mcp.json must be a regular file, not a symlink',
    'project-mcp-size': 'Project .mcp.json could not be inspected or exceeds the 256000 byte limit',
    'project-mcp-json': 'Project .mcp.json must contain valid JSON object configuration',
    'project-mcp-binding': 'Project MCP state/wake paths could not be resolved or validated; inspect local path bindings',
  }[mcpIssue] ?? 'Project MCP configuration could not be inspected');
  else check('project-mcp', mcp.configured && mcp.stateRootMatches === true, 'Start Claude in this project with its agentlink-network stdio MCP entry; helper scripts do not prove native MCP loading');
  if (mcp.wakeConfigured) check('mcp-wake-binding', mcp.wakeBindingMatches === true, 'MCP wake config must bind this state root, workspace and actor; this does not prove a native session loaded it');
  const wake: Array<Record<string, unknown>> = [];
  try {
    const files = await readdir(join(root, 'wake'), { withFileTypes: true });
    if (files.length > 1024) throw new Error('Too many wake files');
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = join(root, 'wake', entry.name);
      if ((await stat(file)).size > 32_000) continue;
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
      if (metadata.configPath !== file || metadata.workspaceRoot !== workspace || metadata.agentId !== actorId) continue;
      try {
        const c = await readNetworkWakeConfig(file, true), q = await networkWakeStatus(file);
        const counts: Record<string, number> = {};
        for (const job of q.jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
        wake.push({ id: c.id, harness: c.harness, ...ttl(c.expiresAt), paused: q.paused, stopped: q.stopped, turns: q.turns, maxTurns: c.maxTurns, remainingTurns: Math.max(0, c.maxTurns - q.turns), jobs: counts });
        if (!q.stopped && Date.parse(c.expiresAt) > now) {
          check(`wake:${c.id}`, !(counts.suspended || counts.blocked) && q.turns < c.maxTurns && !q.paused,
            counts.suspended ? 'Uncertain dispatch suspended; inspect effects before explicit retry, never auto-replay' : q.turns >= c.maxTurns ? `Turn budget exhausted: ${q.turns}/${c.maxTurns} used; fresh enrollment requires owner authorization, no automatic renewal` : 'Inspect queue counts and turn budget; observed is not task processing or native-client proof');
        }
      } catch { check(`wake:${entry.name.slice(0, -5)}`, false, 'Invalid wake config/queue or changed workspace binding'); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') check('wake-state', false, 'Wake metadata could not be inspected'); }
  return { version: 1, ok: checks.every(c => c.ok), actorId, identity, peers, exposures, grants, conversations, mcp, wake,
    daemon: { status: 'not-probed', message: 'Use network discover --peer <name> for authenticated reachability; local metadata does not prove a daemon or model is running' }, checks };
}
