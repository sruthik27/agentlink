import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, readUtf8IfExists, withFileLock } from '../atomic.js';
import { addTrustedPeer, getTrustedPeer, listTrustedPeers } from './trust.js';
import { NETWORK_SCHEMA_VERSION, type NodePublicIdentity, parseNodePublicIdentity, validateNetworkId } from './types.js';

export interface PairedPeer {
  name: string;
  nodeId: string;
  address: string;
}

export interface ExposedAgent {
  agentId: string;
  workspaceRoot: string;
  peerNodeId: string;
}

interface NetworkConfigState {
  version: 1;
  peers: PairedPeer[];
  agents: ExposedAgent[];
}

const configPath = (root: string): string => join(root, 'network-config.json');
const locksPath = (root: string): string => join(root, 'locks');
const emptyState = (): NetworkConfigState => ({ version: NETWORK_SCHEMA_VERSION, peers: [], agents: [] });

function parseAddress(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Peer address must be a string');
  const address = new URL(value);
  if (address.protocol !== 'https:') throw new Error('Peer address must use HTTPS');
  if (address.username || address.password || address.search || address.hash) throw new Error('Peer address must not include credentials, query, or fragment');
  address.pathname = address.pathname.replace(/\/+$/, '') || '/';
  return address.toString().replace(/\/$/, '');
}

function parseState(value: unknown): NetworkConfigState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid network configuration');
  const input = value as Partial<NetworkConfigState>;
  if (input.version !== NETWORK_SCHEMA_VERSION || !Array.isArray(input.peers) || !Array.isArray(input.agents)) {
    throw new Error('Invalid network configuration');
  }
  const peers = input.peers.map((peer) => ({
    name: validateNetworkId(peer.name, 'peer.name'),
    nodeId: validateNetworkId(peer.nodeId, 'peer.nodeId'),
    address: parseAddress(peer.address),
  }));
  const agents = input.agents.map((agent) => {
    if (typeof agent.workspaceRoot !== 'string' || !agent.workspaceRoot.startsWith('/')) throw new Error('Invalid exposed-agent workspace root');
    return {
      agentId: validateNetworkId(agent.agentId, 'agent.agentId'),
      workspaceRoot: agent.workspaceRoot,
      peerNodeId: validateNetworkId(agent.peerNodeId, 'agent.peerNodeId'),
    };
  });
  return { version: NETWORK_SCHEMA_VERSION, peers, agents };
}

async function readState(root: string): Promise<NetworkConfigState> {
  const content = await readUtf8IfExists(configPath(root));
  return content === undefined ? emptyState() : parseState(JSON.parse(content));
}

async function mutate(root: string, operation: (state: NetworkConfigState) => void): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await withFileLock(locksPath(root), 'network-config', async () => {
    const state = await readState(root);
    operation(state);
    await atomicWriteFile(configPath(root), `${JSON.stringify(state)}\n`);
  });
}

export async function pairPeer(
  root: string,
  input: { name: string; address: string; identity: NodePublicIdentity; expectedFingerprint: string },
): Promise<PairedPeer> {
  const name = validateNetworkId(input.name, 'peer.name');
  const address = parseAddress(input.address);
  const identity = parseNodePublicIdentity(input.identity);
  if (identity.fingerprint !== input.expectedFingerprint) throw new Error('Peer identity does not match the explicitly verified fingerprint');
  await addTrustedPeer(root, identity);
  const route = { name, nodeId: identity.nodeId, address };
  await mutate(root, (state) => {
    const byName = state.peers.find((peer) => peer.name === name);
    if (byName && (byName.nodeId !== identity.nodeId || byName.address !== address)) {
      throw new Error(`Peer name ${name} is already paired differently`);
    }
    const byNode = state.peers.find((peer) => peer.nodeId === identity.nodeId);
    if (byNode && byNode.name !== name) throw new Error(`Peer node ${identity.nodeId} is already named ${byNode.name}`);
    if (!byName) state.peers.push(route);
  });
  return route;
}

export async function updatePeerAddress(
  root: string,
  input: { name: string; address: string },
): Promise<PairedPeer> {
  const name = validateNetworkId(input.name, 'peer.name');
  const address = parseAddress(input.address);
  let updated: PairedPeer | undefined;
  await mutate(root, (state) => {
    const peer = state.peers.find((candidate) => candidate.name === name);
    if (!peer) throw new Error(`Unknown paired peer: ${name}`);
    peer.address = address;
    updated = { ...peer };
  });
  return updated!;
}

export async function listPairedPeers(root: string): Promise<Array<PairedPeer & { fingerprint: string }>> {
  const [state, trusted] = await Promise.all([readState(root), listTrustedPeers(root)]);
  return state.peers.map((route) => {
    const peer = trusted.find((candidate) => candidate.nodeId === route.nodeId);
    if (!peer) throw new Error(`Paired route ${route.name} has no trusted certificate`);
    return { ...route, fingerprint: peer.fingerprint };
  });
}

export async function resolvePairedPeer(root: string, name: string): Promise<PairedPeer & { identity: NodePublicIdentity }> {
  const route = (await readState(root)).peers.find((peer) => peer.name === validateNetworkId(name, 'peer.name'));
  if (!route) throw new Error(`Unknown paired peer: ${name}`);
  const identity = await getTrustedPeer(root, route.nodeId);
  if (!identity) throw new Error(`Peer ${name} is no longer trusted`);
  return { ...route, identity };
}

export async function exposeAgent(
  root: string,
  input: { agentId: string; workspaceRoot: string; peerName: string },
): Promise<{ agentId: string; peerNodeId: string }> {
  const agentId = validateNetworkId(input.agentId, 'agent.agentId');
  const workspaceRoot = await realpath(input.workspaceRoot);
  const peer = await resolvePairedPeer(root, input.peerName);
  await mutate(root, (state) => {
    const existing = state.agents.find((agent) => agent.agentId === agentId && agent.peerNodeId === peer.nodeId);
    if (existing && existing.workspaceRoot !== workspaceRoot) throw new Error(`Agent ${agentId} is already exposed from a different workspace`);
    if (!existing) state.agents.push({ agentId, workspaceRoot, peerNodeId: peer.nodeId });
  });
  return { agentId, peerNodeId: peer.nodeId };
}

export async function revokeAgentExposure(root: string, agentIdValue: string, peerName: string): Promise<void> {
  const agentId = validateNetworkId(agentIdValue, 'agent.agentId');
  const peer = await resolvePairedPeer(root, peerName);
  await mutate(root, (state) => {
    const index = state.agents.findIndex((agent) => agent.agentId === agentId && agent.peerNodeId === peer.nodeId);
    if (index === -1) throw new Error(`Agent ${agentId} is not exposed to ${peerName}`);
    state.agents.splice(index, 1);
  });
}

export async function requireAgentExposure(
  root: string,
  input: { agentId: string; workspaceRoot: string; peerNodeId: string },
): Promise<void> {
  const workspaceRoot = await realpath(input.workspaceRoot);
  const found = (await readState(root)).agents.some((agent) => agent.agentId === input.agentId
    && agent.peerNodeId === input.peerNodeId && agent.workspaceRoot === workspaceRoot);
  if (!found) throw new Error('The locally bound actor is not owner-exposed from this workspace to that peer');
}

export async function listAgentExposures(root: string): Promise<Array<{ agentId: string; peerNodeId: string }>> {
  return (await readState(root)).agents.map(({ agentId, peerNodeId }) => ({ agentId, peerNodeId }));
}

export async function withAgentExposureAuthorization<T>(root: string, input: { agentId: string; workspaceRoot: string; peerNodeId: string }, operation: () => Promise<T>): Promise<T> {
  return withFileLock(locksPath(root), 'network-config', async () => {
    await requireAgentExposure(root, input);
    return operation();
  });
}
