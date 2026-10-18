import { X509Certificate } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, readUtf8IfExists, withFileLock } from '../atomic.js';
import {
  NETWORK_SCHEMA_VERSION,
  type NodePublicIdentity,
  type ScopedGrant,
  parseNodePublicIdentity,
  sha256,
  validateNetworkId,
} from './types.js';

interface TrustState {
  version: 1;
  peers: NodePublicIdentity[];
  grants: ScopedGrant[];
}

export const MAX_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface AddGrantInput extends Omit<ScopedGrant, 'version' | 'remoteFingerprint' | 'createdAt' | 'revokedAt'> {}

export async function listLocalGrantSummaries(root: string, agentId: string) {
  const state = await readState(root);
  return state.grants.filter(g => g.localAgentId === agentId).map(g => ({
    grantId: g.grantId, remoteNodeId: g.remoteNodeId, remoteAgentId: g.remoteAgentId,
    conversationId: g.collaborationId, expiresAt: g.expiresAt, revoked: !!g.revokedAt,
    peerIdentityMatches: state.peers.some(p => p.nodeId === g.remoteNodeId && p.fingerprint === g.remoteFingerprint),
  }));
}

const emptyState = (): TrustState => ({ version: NETWORK_SCHEMA_VERSION, peers: [], grants: [] });
const trustPath = (root: string): string => join(root, 'trust.json');
const locksPath = (root: string): string => join(root, 'locks');

function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) throw new Error(`${label} must be a strict ISO timestamp`);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a strict ISO timestamp`);
  }
  return value;
}

function parseGrant(value: unknown, requireCreatedAt: boolean): ScopedGrant | AddGrantInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Grant must be an object');
  const input = value as Record<string, unknown>;
  const required = ['grantId', 'remoteNodeId', 'remoteAgentId', 'localAgentId', 'collaborationId', 'actions', 'expiresAt'];
  const persisted = ['version', 'remoteFingerprint', 'createdAt', 'revokedAt'];
  const allowed = [...required, ...(requireCreatedAt ? persisted : [])];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error(`Grant has unknown field: ${key}`);
  }
  for (const key of required) {
    if (!(key in input)) throw new Error(`Grant is missing field: ${key}`);
  }
  const parsed = {
    grantId: validateNetworkId(input.grantId, 'grant.grantId'),
    remoteNodeId: validateNetworkId(input.remoteNodeId, 'grant.remoteNodeId'),
    remoteAgentId: validateNetworkId(input.remoteAgentId, 'grant.remoteAgentId'),
    localAgentId: validateNetworkId(input.localAgentId, 'grant.localAgentId'),
    collaborationId: validateNetworkId(input.collaborationId, 'grant.collaborationId'),
    actions: ['deliver'] as ['deliver'],
    expiresAt: parseIsoTimestamp(input.expiresAt, 'Grant expiry'),
  };
  if (!Array.isArray(input.actions) || input.actions.length !== 1 || input.actions[0] !== 'deliver') {
    throw new Error('Grant actions must be exactly [deliver]');
  }
  if (!requireCreatedAt) return parsed as AddGrantInput;
  if (input.version !== NETWORK_SCHEMA_VERSION) {
    throw new Error('Invalid persisted grant metadata');
  }
  const createdAt = parseIsoTimestamp(input.createdAt, 'Grant creation time');
  if (typeof input.remoteFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.remoteFingerprint)) {
    throw new Error('Invalid persisted grant peer fingerprint');
  }
  const revokedAt = input.revokedAt === undefined ? undefined : parseIsoTimestamp(input.revokedAt, 'Grant revocation time');
  return {
    ...parsed,
    version: NETWORK_SCHEMA_VERSION,
    remoteFingerprint: input.remoteFingerprint,
    createdAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  } as ScopedGrant;
}

function fingerprint(certificatePem: string): string {
  return `sha256:${new X509Certificate(certificatePem).fingerprint256.replaceAll(':', '').toLowerCase()}`;
}

async function readState(root: string): Promise<TrustState> {
  const content = await readUtf8IfExists(trustPath(root));
  if (content === undefined) return emptyState();
  const state = JSON.parse(content) as TrustState;
  if (state.version !== NETWORK_SCHEMA_VERSION || !Array.isArray(state.peers) || !Array.isArray(state.grants)) {
    throw new Error('Invalid trust store');
  }
  state.peers = state.peers.map((peer) => parseNodePublicIdentity(peer));
  state.grants = state.grants.map((grant) => parseGrant(grant, true) as ScopedGrant);
  return state;
}

async function mutate(root: string, operation: (state: TrustState) => void): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await withFileLock(locksPath(root), 'network-trust', async () => {
    const state = await readState(root);
    operation(state);
    await atomicWriteFile(trustPath(root), `${JSON.stringify(state)}\n`);
  });
}

export async function addTrustedPeer(root: string, peer: NodePublicIdentity): Promise<void> {
  const parsed = parseNodePublicIdentity(peer);
  if (fingerprint(parsed.certificatePem) !== parsed.fingerprint) throw new Error('Peer certificate fingerprint mismatch');
  await mutate(root, (state) => {
    const existing = state.peers.find((candidate) => candidate.nodeId === parsed.nodeId);
    if (existing && existing.fingerprint !== parsed.fingerprint) throw new Error(`Peer ${parsed.nodeId} already has a different pinned certificate`);
    if (!existing) state.peers.push({ ...parsed });
  });
}

export async function listTrustedPeers(root: string): Promise<NodePublicIdentity[]> {
  return (await readState(root)).peers.map((peer) => ({ ...peer }));
}

export async function getTrustedPeer(root: string, nodeId: string): Promise<NodePublicIdentity | undefined> {
  validateNetworkId(nodeId, 'peer.nodeId');
  const peer = (await readState(root)).peers.find((candidate) => candidate.nodeId === nodeId);
  return peer ? { ...peer } : undefined;
}

export async function getTrustedPeerByFingerprint(root: string, fingerprintValue: string): Promise<NodePublicIdentity | undefined> {
  if (!/^sha256:[0-9a-f]{64}$/.test(fingerprintValue)) throw new Error('Invalid peer certificate fingerprint');
  const peer = (await readState(root)).peers.find((candidate) => candidate.fingerprint === fingerprintValue);
  return peer ? { ...peer } : undefined;
}

export async function revokeTrustedPeer(root: string, nodeIdValue: string): Promise<void> {
  const nodeId = validateNetworkId(nodeIdValue, 'peer.nodeId');
  await mutate(root, (state) => {
    const index = state.peers.findIndex((peer) => peer.nodeId === nodeId);
    if (index === -1) throw new Error(`Peer ${nodeId} is not trusted`);
    state.peers.splice(index, 1);
  });
}

export async function addGrant(root: string, input: AddGrantInput, now = new Date()): Promise<ScopedGrant> {
  const parsed = parseGrant(input, false) as AddGrantInput;
  const lifetimeMs = Date.parse(parsed.expiresAt) - now.getTime();
  if (lifetimeMs <= 0) throw new Error('Grant expiry must be in the future');
  if (lifetimeMs > MAX_GRANT_TTL_MS) throw new Error('Grant expiry exceeds the maximum grant lifetime');
  let grant: ScopedGrant | undefined;
  await mutate(root, (state) => {
    const peer = state.peers.find((candidate) => candidate.nodeId === parsed.remoteNodeId);
    if (!peer) throw new Error(`Peer ${parsed.remoteNodeId} is not trusted`);
    if (state.grants.some((candidate) => candidate.grantId === parsed.grantId)) throw new Error(`Grant ${parsed.grantId} already exists`);
    grant = {
      ...parsed,
      version: NETWORK_SCHEMA_VERSION,
      remoteFingerprint: peer.fingerprint,
      actions: ['deliver'],
      createdAt: now.toISOString(),
    };
    state.grants.push(grant);
  });
  return { ...grant!, actions: ['deliver'] };
}

export async function revokeGrant(root: string, grantIdValue: string, now = new Date()): Promise<void> {
  const grantId = validateNetworkId(grantIdValue, 'grantId');
  await mutate(root, (state) => {
    const grant = state.grants.find((candidate) => candidate.grantId === grantId);
    if (!grant) throw new Error(`Grant ${grantId} does not exist`);
    if (!grant.revokedAt) grant.revokedAt = now.toISOString();
  });
}

export async function listGrantedLocalAgents(
  root: string,
  remoteNodeIdValue: string,
  now = new Date(),
): Promise<string[]> {
  const remoteNodeId = validateNetworkId(remoteNodeIdValue, 'remoteNodeId');
  const state = await readState(root);
  const peer = state.peers.find((candidate) => candidate.nodeId === remoteNodeId);
  if (!peer) return [];
  return [...new Set(state.grants
    .filter((grant) => grant.remoteNodeId === remoteNodeId
      && grant.remoteFingerprint === peer.fingerprint
      && grant.actions.includes('deliver')
      && !grant.revokedAt
      && Date.parse(grant.expiresAt) > now.getTime())
    .map((grant) => grant.localAgentId))].sort();
}

export async function authorizeDelivery(
  root: string,
  remoteNodeId: string,
  remoteAgentId: string,
  localAgentId: string,
  collaborationId: string,
  now = new Date(),
): Promise<ScopedGrant> {
  return authorizeFromState(await readState(root), remoteNodeId, remoteAgentId, localAgentId, collaborationId, now);
}

function authorizeFromState(
  state: TrustState,
  remoteNodeId: string,
  remoteAgentId: string,
  localAgentId: string,
  collaborationId: string,
  now: Date,
): ScopedGrant {
  for (const [value, label] of [[remoteNodeId, 'remoteNodeId'], [remoteAgentId, 'remoteAgentId'], [localAgentId, 'localAgentId'], [collaborationId, 'collaborationId']] as const) {
    validateNetworkId(value, label);
  }
  const peer = state.peers.find((candidate) => candidate.nodeId === remoteNodeId);
  if (!peer) throw new Error(`Peer ${remoteNodeId} is not trusted`);
  const matching = state.grants.filter((grant) => grant.remoteNodeId === remoteNodeId
    && grant.remoteAgentId === remoteAgentId && grant.localAgentId === localAgentId
    && grant.collaborationId === collaborationId && grant.actions.includes('deliver'));
  const active = matching.find((grant) => grant.remoteFingerprint === peer.fingerprint
    && !grant.revokedAt && Date.parse(grant.expiresAt) > now.getTime());
  if (active) return active;
  if (matching.some((grant) => grant.remoteFingerprint !== peer.fingerprint)) {
    throw new Error('Matching grant belongs to a different peer certificate identity');
  }
  if (matching.some((grant) => grant.revokedAt)) throw new Error('Matching grant is revoked');
  if (matching.some((grant) => Date.parse(grant.expiresAt) <= now.getTime())) throw new Error('Matching grant is expired');
  throw new Error('Delivery is not granted');
}

export async function withDeliveryAuthorization<T>(
  root: string,
  remoteNodeId: string,
  remoteAgentId: string,
  localAgentId: string,
  collaborationId: string,
  operation: (authorizedAt: Date) => Promise<T>,
  now?: Date,
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await withFileLock(locksPath(root), 'network-trust', async () => {
    const state = await readState(root);
    const authorizedAt = now ?? new Date();
    authorizeFromState(state, remoteNodeId, remoteAgentId, localAgentId, collaborationId, authorizedAt);
    return await operation(authorizedAt);
  });
}

export function certificateDerFingerprint(rawCertificate: Buffer): string {
  return sha256(rawCertificate);
}
