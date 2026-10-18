import { join } from 'node:path';
import { atomicWriteFile, readUtf8IfExists, withFileLock } from '../atomic.js';
import { authenticatedRequest, AuthenticatedRequestError } from './a2a.js';
import { requireAgentExposure, resolvePairedPeer } from './config.js';
import { exportPublicIdentity } from './identity.js';
import { newCollaborationRequestId, operateCollaboration, parseCollaborationOperation, parseCollaborationSnapshot, withLocalExecution, type Collaboration, type CollaborationOperation } from './collaboration.js';
import { sha256, validateNetworkId } from './types.js';

export interface CollaborationBinding { stateRoot: string; agentId: string; workspaceRoot: string; }
export interface CollaborationTarget { peer: string; agent: string; conversationId: string; authority: 'local' | 'peer'; }
interface ClientState {
  version: 1;
  requests: Array<{ key: string; hash: string; status: 'queued' | 'transport-received' | 'failed'; operation: CollaborationOperation }>;
  cache: Array<{ key: string; snapshot: Collaboration }>;
}
const file = (root: string): string => join(root, 'collaboration-client.json');
async function state(root: string): Promise<ClientState> {
  const raw = await readUtf8IfExists(file(root));
  return raw ? JSON.parse(raw) as ClientState : { version: 1, requests: [], cache: [] };
}
async function mutate(root: string, fn: (s: ClientState) => void): Promise<void> {
  await withFileLock(join(root, 'locks'), 'collaboration-client', async () => {
    const s = await state(root); fn(s);
    const raw = JSON.stringify(s);
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('Client collaboration quota exceeded');
    await atomicWriteFile(file(root), raw);
  });
}
export async function callCollaboration(binding: CollaborationBinding, target: CollaborationTarget, value: unknown): Promise<{ snapshot: Collaboration; cached: false }> {
  const { stateRoot: root, agentId, workspaceRoot } = binding;
  validateNetworkId(agentId, 'locally bound agent'); validateNetworkId(target.agent, 'target agent');
  validateNetworkId(target.conversationId, 'conversationId');
  if (target.authority !== 'local' && target.authority !== 'peer') throw new Error('Explicit authority local or peer is required');
  const peer = await resolvePairedPeer(root, target.peer);
  await requireAgentExposure(root, { agentId, workspaceRoot, peerNodeId: peer.nodeId });
  const identity = await exportPublicIdentity(root);
  const op = parseCollaborationOperation(value);
  const scope = `${identity.nodeId}/${agentId}/${peer.nodeId}/${target.agent}/${target.authority}/${target.conversationId}`;
  const key = `${scope}/${op.requestId}`;
  const operationHash = sha256(JSON.stringify(op));
  const validateScope = (snapshot: Collaboration): void => {
    const local = target.authority === 'local' ? snapshot.authority : snapshot.remote;
    const remote = target.authority === 'local' ? snapshot.remote : snapshot.authority;
    if (snapshot.id !== target.conversationId || local.nodeId !== identity.nodeId || local.agentId !== agentId
      || remote.nodeId !== peer.nodeId || remote.agentId !== target.agent) throw new Error('Collaboration response scope mismatch');
    if (op.type !== 'get' && !snapshot.audit.some((a) => a.requestId === op.requestId && a.actor.nodeId === identity.nodeId && a.actor.agentId === agentId && a.hash === operationHash)) throw new Error('Missing correlated authoritative acknowledgement');
  };
  const perform = async (): Promise<{ snapshot: Collaboration; cached: false }> => {
  if (target.authority === 'local' && op.type !== 'get') {
    const current = await operateCollaboration(root, target.conversationId, { nodeId: identity.nodeId, agentId }, { type: 'get', requestId: newCollaborationRequestId() });
    if (current.remote.nodeId !== peer.nodeId || current.remote.agentId !== target.agent || current.authority.agentId !== agentId) throw new Error('Collaboration target scope mismatch');
  }
  if (op.type !== 'get') await mutate(root, (s) => {
    const prior = s.requests.find((r) => r.key === key);
    if (prior && prior.hash !== operationHash) throw new Error('Conflicting queued operation replay');
    if (!prior) {
      const terminal = ['read', 'processed', 'fail', 'cancel', 'cancel-task', 'cancelled-task'].includes(op.type);
      const scopeRequests = s.requests.filter((r) => r.key.startsWith(scope + '/'));
      const scopes = new Set(s.requests.map((r) => r.key.slice(0, r.key.lastIndexOf('/'))));
      if (!scopes.has(scope) && scopes.size >= 32) throw new Error('Client scope quota exceeded');
      if (s.requests.length >= 8192 || scopeRequests.length >= (terminal ? 256 : 192)) throw new Error('Client operation quota exceeded; terminal capacity is reserved');
      s.requests.push({ key, hash: operationHash, status: 'queued', operation: op });
      if (!terminal && Buffer.byteLength(JSON.stringify(s)) > 2 * 1024 * 1024) throw new Error('Client ordinary byte quota exceeded; terminal capacity is reserved');
    }
  });
  let snapshot: Collaboration;
  try {
  if (target.authority === 'local') {
    snapshot = await operateCollaboration(root, target.conversationId, { nodeId: identity.nodeId, agentId }, op);
  } else {
    const response = await authenticatedRequest(root, `${peer.address}/v1/collaboration`, peer.identity, 'POST', {
      agentId, authorityAgentId: target.agent, conversationId: target.conversationId, operation: op,
    }) as { requestHash: string; snapshot: unknown };
    if (response?.requestHash !== operationHash) throw new Error('Collaboration response request mismatch');
    snapshot = parseCollaborationSnapshot(response.snapshot);
  }
  } catch (error) {
    if (op.type !== 'get' && (target.authority === 'local' || error instanceof AuthenticatedRequestError && error.statusCode >= 400 && error.statusCode < 500)) {
      await mutate(root, (s) => { const request = s.requests.find((r) => r.key === key); if (request) request.status = 'failed'; });
    }
    throw error;
  }
  validateScope(snapshot);
  await mutate(root, (s) => {
    const request = s.requests.find((r) => r.key === key);
    if (request) request.status = 'transport-received';
    const cached = s.cache.find((c) => c.key === scope);
    if (cached) {
      if (snapshot.audit.length < cached.snapshot.audit.length || cached.snapshot.audit.some((entry, i) => snapshot.audit[i]?.hash !== entry.hash || snapshot.audit[i]?.requestId !== entry.requestId)) throw new Error('Authority snapshot rolled back');
      cached.snapshot = snapshot;
    } else {
      if (s.cache.length >= 32) throw new Error('Client cache quota exceeded');
      s.cache.push({ key: scope, snapshot });
    }
  });
  return { snapshot, cached: false };
  };
  // Hold the owner permit lock through acknowledgement: a completed revoke wins over later calls.
  if (op.type === 'read' || op.type === 'processed') {
    const current = await callCollaboration(binding, target, { type: 'get', requestId: newCollaborationRequestId() });
    return await withLocalExecution(root, current.snapshot, agentId, workspaceRoot, perform);
  }
  return await perform();
}

export async function readCachedCollaboration(binding: CollaborationBinding, target: CollaborationTarget): Promise<{ snapshot: Collaboration; cached: true }> {
  const peer = await resolvePairedPeer(binding.stateRoot, target.peer);
  await requireAgentExposure(binding.stateRoot, { agentId: binding.agentId, workspaceRoot: binding.workspaceRoot, peerNodeId: peer.nodeId });
  const identity = await exportPublicIdentity(binding.stateRoot);
  const key = `${identity.nodeId}/${binding.agentId}/${peer.nodeId}/${target.agent}/${target.authority}/${target.conversationId}`;
  const cached = (await state(binding.stateRoot)).cache.find((c) => c.key === key);
  if (!cached) throw new Error('No known authoritative cache for this scope');
  return { snapshot: parseCollaborationSnapshot(cached.snapshot), cached: true };
}
