import { enrollNetworkWake, networkWakeStatus, controlNetworkWake, runNetworkWakeOnce, runNetworkWakeSupervisor, peekNetworkWake, monitorNetworkWake, connectOpenCodeWake } from './wake.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { callCollaboration } from './collaboration-client.js';
import { createCollaboration, authorizeLocalExecution, revokeLocalExecution } from './collaboration.js';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { callRemoteAgentLinkTool } from '../mcp/remote-tools.js';
import { collectRepoContext } from '../context.js';
import { resolveActiveParticipant } from '../workspace.js';
import { exposeAgent, listAgentExposures, listPairedPeers, pairPeer, revokeAgentExposure, resolvePairedPeer, updatePeerAddress } from './config.js';
import { exportPublicIdentity, initializeNodeIdentity } from './identity.js';
import { startNetworkServer } from './server.js';
import { addGrant, revokeGrant } from './trust.js';
import { validateNetworkId as validateId, parseNodePublicIdentity } from './types.js';
import { expiryFromOptions } from './expiry.js';
import { collectNetworkDoctor } from './doctor.js';

interface Output { log(message: string): void; }

function parse(args: string[]): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const name = value.slice(2);
    const optionValue = args[index + 1];
    if (!name || optionValue === undefined || optionValue.startsWith('--')) throw new Error(`Option --${name || '?'} requires a value`);
    if (options[name] !== undefined) throw new Error(`Option --${name} may be specified only once`);
    options[name] = optionValue;
    index += 1;
  }
  return { positionals, options };
}

function required(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`Missing required option: --${name}`);
  return value;
}

function only(options: Record<string, string>, names: string[]): void {
  const unknown = Object.keys(options).find((name) => !names.includes(name));
  if (unknown) throw new Error(`Unknown network option: --${unknown}`);
}

async function binding(stateRoot: string, cwd: string) {
  const actor = await resolveActiveParticipant(cwd);
  return { stateRoot, agentId: actor.participantId, workspaceRoot: cwd };
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function requireStateRootOutsideWorkspace(stateRoot: string, cwd: string): Promise<void> {
  const [candidate, workspace, context] = await Promise.all([
    canonicalProspectivePath(stateRoot),
    realpath(cwd),
    collectRepoContext(cwd),
  ]);
  const protectedRoots = new Set([workspace, ...(context.git.root ? [await realpath(context.git.root)] : [])]);
  if ([...protectedRoots].some((root) => isWithin(root, candidate))) {
    throw new Error('--state-root must be outside the active workspace and repository');
  }
}

export async function runNetworkCli(args: string[], cwd: string, output: Output): Promise<void> {
  if (!args.length || (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!))) {
    output.log('AgentLink network\n  node init|export, peer pair|list|update-address, agent expose|revoke, grant add|revoke\n  collaboration create|call|authorize|revoke-execution\n  wake enroll|connect|run|once|peek|monitor|status|pause|resume|stop|retry\n  serve, discover, send, receive, status, doctor\nAll commands require --state-root <absolute-private-directory>.\nFinite owner permissions: use exactly one of --ttl 12h (units s/m/h/d) or --expires-at <UTC ISO>.\nGrant/invitation maximum: 30d. Wake/execution permit maximum: 24h. No automatic renewal.\nnetwork doctor is local and read-only; it does not prove peer reachability or native model processing.');
    return;
  }
  const { positionals, options } = parse(args);
  const [domain, action] = positionals;
  const stateRoot = required(options, 'state-root');
  if (!isAbsolute(stateRoot)) throw new Error('--state-root must be an absolute owner-controlled path');

  if (domain === 'doctor') {
    only(options, ['state-root']);
    if (action !== undefined || positionals.length !== 1) throw new Error('Usage: agentlink network doctor --state-root <absolute-private-directory>');
    output.log(JSON.stringify(await collectNetworkDoctor(stateRoot, cwd)));
    return;
  }

  if (domain === 'wake') {
    if (action === 'enroll') {
      only(options, ['state-root', 'id', 'peer', 'agent', 'authority', 'conversation', 'harness', 'expires-at', 'ttl', 'policy', 'codex', 'model', 'thread', 'replay-existing', 'max-turns', 'poll-ms', 'opencode-url', 'session', 'password-env', 'exclusive-session']);
      await requireStateRootOutsideWorkspace(stateRoot, cwd);
      const policyPath = required(options, 'policy');
      if (!isAbsolute(policyPath) || isWithin(await realpath(cwd), await realpath(policyPath))) throw new Error('Wake owner policy must be an absolute file outside workspace');
      if (options['replay-existing'] && !['true', 'false'].includes(options['replay-existing'])) throw new Error('replay-existing must be true or false');
      const config = await enrollNetworkWake({ id: required(options, 'id'), stateRoot, workspaceRoot: cwd, peer: required(options, 'peer'), remoteAgentId: required(options, 'agent'),
        authority: required(options, 'authority') as 'local' | 'peer', conversations: required(options, 'conversation').split(','), harness: required(options, 'harness') as 'codex' | 'claude-channel' | 'claude-monitor' | 'opencode',
        expiresAt: expiryFromOptions(options, 86_400_000), policy: await readFile(policyPath, 'utf8'), mcpEntrypoint: fileURLToPath(new URL('../mcp/server.js', import.meta.url)),
        ...(options['opencode-url'] ? { opencodeUrl: options['opencode-url'], opencodeSessionId: required(options, 'session'), opencodeExclusive: options['exclusive-session'] === 'true', ...(options['password-env'] ? { opencodePasswordEnv: options['password-env'] } : {}) } : {}),
        ...(options.codex ? { codexExecutable: options.codex } : {}), ...(options.model ? { model: options.model } : {}), ...(options.thread ? { initialThreadId: options.thread } : {}),
        replayExisting: options['replay-existing'] === 'true', ...(options['max-turns'] ? { maxTurns: Number(options['max-turns']) } : {}), ...(options['poll-ms'] ? { pollMs: Number(options['poll-ms']) } : {}) });
      output.log(JSON.stringify({ enrolled: true, configPath: config.configPath, harness: config.harness, expiresAt: config.expiresAt })); return;
    }
    only(options, ['state-root', 'id', 'event']);
    const config = join(await realpath(stateRoot), 'wake', `${validateId(required(options, 'id'), 'wake.id')}.json`);
    if (action === 'status') output.log(JSON.stringify(await networkWakeStatus(config)));
    else if (action === 'connect') output.log(JSON.stringify(await connectOpenCodeWake(config)));
    else if (action === 'once') output.log(JSON.stringify({ outcome: await runNetworkWakeOnce(config) }));
    else if (action === 'peek') output.log(JSON.stringify({ events: await peekNetworkWake(config) }));
    else if (action === 'run' || action === 'monitor') {
      const controller = new AbortController(); const stop = (): void => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { if (action === 'monitor') await monitorNetworkWake(config, line => output.log(line), controller.signal); else await runNetworkWakeSupervisor(config, controller.signal); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    } else if (action && ['pause', 'resume', 'stop', 'retry'].includes(action)) { await controlNetworkWake(config, action as 'pause' | 'resume' | 'stop' | 'retry', options.event); output.log(JSON.stringify({ action })); }
    else throw new Error('Unknown network wake action');
    return;
  }

  if (domain === 'collaboration' && action === 'create') {
    only(options, ['state-root', 'id', 'peer', 'agent', 'topic', 'expires-at', 'ttl']);
    const local = await binding(stateRoot, cwd);
    const peer = await resolvePairedPeer(stateRoot, required(options, 'peer'));
    output.log(JSON.stringify(await createCollaboration(stateRoot, { id: required(options, 'id'), localAgentId: local.agentId,
      remoteNodeId: peer.nodeId, remoteAgentId: required(options, 'agent'), topic: required(options, 'topic'), expiresAt: expiryFromOptions(options, 30 * 86_400_000) })));
    return;
  }
  if (domain === 'collaboration' && action === 'revoke-execution') {
    only(options, ['state-root', 'conversation']);
    const local = await binding(stateRoot, cwd);
    await revokeLocalExecution(stateRoot, required(options, 'conversation'), local.agentId);
    output.log(JSON.stringify({ revoked: true, conversationId: required(options, 'conversation') }));
    return;
  }
  if (domain === 'collaboration' && action === 'authorize') {
    only(options, ['state-root', 'peer', 'agent', 'authority', 'conversation', 'revision', 'digest', 'expires-at', 'ttl']);
    const local = await binding(stateRoot, cwd);
    const current = await callCollaboration(local, { peer: required(options, 'peer'), agent: required(options, 'agent'),
      authority: required(options, 'authority') as 'local' | 'peer', conversationId: required(options, 'conversation') }, { type: 'get', requestId: 'owner-permit-inspection' });
    if (current.snapshot.revision !== Number(required(options, 'revision')) || current.snapshot.digest !== required(options, 'digest')) throw new Error('Owner permit does not match the current agreement');
    await authorizeLocalExecution(stateRoot, { agentId: local.agentId, workspaceRoot: cwd, collaboration: current.snapshot, expiresAt: expiryFromOptions(options, 86_400_000) });
    output.log(JSON.stringify({ authorized: true, agentId: local.agentId, conversationId: required(options, 'conversation') }));
    return;
  }
  if (domain === 'collaboration' && action === 'call') {
    only(options, ['state-root', 'peer', 'agent', 'conversation', 'authority', 'operation']);
    const result = await callRemoteAgentLinkTool('agentlink_collaboration', { peer: required(options, 'peer'), agent: required(options, 'agent'),
      conversationId: required(options, 'conversation'), authority: required(options, 'authority'), operation: JSON.parse(required(options, 'operation')) }, await binding(stateRoot, cwd));
    output.log(JSON.stringify(result.structuredContent));
    return;
  }
  if (domain === 'node' && action === 'init') {
    only(options, ['state-root', 'id']);
    await requireStateRootOutsideWorkspace(stateRoot, cwd);
    const identity = await initializeNodeIdentity(stateRoot, required(options, 'id'));
    output.log(JSON.stringify({ nodeId: identity.nodeId, fingerprint: identity.fingerprint }));
    return;
  }
  if (domain === 'node' && action === 'export') {
    only(options, ['state-root']);
    output.log(JSON.stringify(await exportPublicIdentity(stateRoot)));
    return;
  }
  if (domain === 'peer' && action === 'pair') {
    only(options, ['state-root', 'name', 'address', 'identity', 'fingerprint']);
    const identityPath = required(options, 'identity');
    if (!isAbsolute(identityPath)) throw new Error('--identity must be an absolute public-identity JSON path');
    const identity = parseNodePublicIdentity(JSON.parse(await readFile(identityPath, 'utf8')) as unknown);
    const paired = await pairPeer(stateRoot, {
      name: required(options, 'name'), address: required(options, 'address'), identity,
      expectedFingerprint: required(options, 'fingerprint'),
    });
    output.log(JSON.stringify(paired));
    return;
  }
  if (domain === 'peer' && action === 'list') {
    only(options, ['state-root']);
    output.log(JSON.stringify(await listPairedPeers(stateRoot)));
    return;
  }
  if (domain === 'peer' && action === 'update-address') {
    only(options, ['state-root', 'name', 'address']);
    output.log(JSON.stringify(await updatePeerAddress(stateRoot, {
      name: required(options, 'name'), address: required(options, 'address'),
    })));
    return;
  }
  if (domain === 'agent' && action === 'expose') {
    only(options, ['state-root', 'agent', 'peer']);
    output.log(JSON.stringify(await exposeAgent(stateRoot, { agentId: required(options, 'agent'), workspaceRoot: cwd, peerName: required(options, 'peer') })));
    return;
  }
  if (domain === 'agent' && action === 'revoke') {
    only(options, ['state-root', 'agent', 'peer']);
    await revokeAgentExposure(stateRoot, required(options, 'agent'), required(options, 'peer'));
    output.log(JSON.stringify({ revoked: true }));
    return;
  }
  if (domain === 'grant' && action === 'add') {
    only(options, ['state-root', 'id', 'peer', 'remote-agent', 'local-agent', 'conversation', 'expires-at', 'ttl']);
    const peer = await resolvePairedPeer(stateRoot, required(options, 'peer'));
    const grant = await addGrant(stateRoot, {
      grantId: required(options, 'id'), remoteNodeId: peer.nodeId,
      remoteAgentId: required(options, 'remote-agent'), localAgentId: required(options, 'local-agent'),
      collaborationId: required(options, 'conversation'), actions: ['deliver'], expiresAt: expiryFromOptions(options, 30 * 86_400_000),
    });
    output.log(JSON.stringify({ grantId: grant.grantId, peerNodeId: grant.remoteNodeId, expiresAt: grant.expiresAt }));
    return;
  }
  if (domain === 'grant' && action === 'revoke') {
    only(options, ['state-root', 'id']);
    await revokeGrant(stateRoot, required(options, 'id'));
    output.log(JSON.stringify({ revoked: true, grantId: required(options, 'id') }));
    return;
  }
  if (domain === 'serve' && action === undefined) {
    only(options, ['state-root', 'host', 'port']);
    const host = options.host ?? '127.0.0.1';
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port)) throw new Error('--port must be an integer');
    const running = await startNetworkServer({ stateRoot, host, port });
    output.log(JSON.stringify({ pid: process.pid, nodeId: (await exportPublicIdentity(stateRoot)).nodeId, host: running.host, port: running.port }));
    await new Promise<void>((resolve) => {
      const stop = (): void => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    });
    await running.close();
    return;
  }
  if (domain === 'discover') {
    only(options, ['state-root', 'peer']);
    const result = await callRemoteAgentLinkTool('agentlink_remote_discover', { peer: required(options, 'peer') }, await binding(stateRoot, cwd));
    output.log(JSON.stringify(result.structuredContent));
    return;
  }
  if (domain === 'send') {
    only(options, ['state-root', 'peer', 'agent', 'conversation', 'body', 'message-id']);
    const result = await callRemoteAgentLinkTool('agentlink_remote_send', {
      peer: required(options, 'peer'), agent: required(options, 'agent'), conversationId: required(options, 'conversation'),
      body: required(options, 'body'), ...(options['message-id'] ? { messageId: options['message-id'] } : {}),
    }, await binding(stateRoot, cwd));
    output.log(JSON.stringify(result.structuredContent));
    return;
  }
  if (domain === 'receive') {
    only(options, ['state-root', 'peer', 'conversation', 'limit']);
    const result = await callRemoteAgentLinkTool('agentlink_remote_receive', {
      peer: required(options, 'peer'), conversationId: required(options, 'conversation'),
      ...(options.limit ? { limit: Number(options.limit) } : {}),
    }, await binding(stateRoot, cwd));
    output.log(JSON.stringify(result.structuredContent));
    return;
  }
  if (domain === 'status') {
    only(options, ['state-root']);
    const result = await callRemoteAgentLinkTool('agentlink_remote_status', {}, await binding(stateRoot, cwd));
    output.log(JSON.stringify({ ...(result.structuredContent ?? {}), exposures: await listAgentExposures(stateRoot) }));
    return;
  }
  throw new Error('Usage: agentlink network <node|peer|agent|grant|collaboration|serve|discover|send|receive|status> ... --state-root <absolute-path>');
}
