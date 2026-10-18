import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { atomicWriteFile, readUtf8IfExists, withFileLock } from '../atomic.js';
import { exportPublicIdentity } from './identity.js';
import { getTrustedPeer, withDeliveryAuthorization } from './trust.js';
import { sha256, validateNetworkId, type NetworkActor } from './types.js';

export type TaskPhase = 'transport-received' | 'agent-read' | 'processed' | 'failed' | 'cancel-requested' | 'cancelled';
export interface CollaborationTask {
  id: string; sender: NetworkActor; recipient: NetworkActor; revision: number; digest: string;
  body: string; phase: TaskPhase; evidence?: { summary: string; artifactDigest: string; testDigest: string };
}
export interface Collaboration {
  version: 1; id: string; authority: NetworkActor; remote: NetworkActor; remoteFingerprint: string;
  topic: string; expiresAt: string; accepted: string[]; revision: number; content: string; digest: string;
  approvals: string[]; tasks: CollaborationTask[]; cancelled: boolean;
  audit: Array<{ sequence: number; requestId: string; actor: NetworkActor; hash: string; at: string; operation: CollaborationOperation }>;
}
export interface CollaborationOperation {
  type: 'get' | 'accept' | 'discuss' | 'propose' | 'approve' | 'task' | 'read' | 'processed' | 'fail' | 'cancel-task' | 'cancelled-task' | 'cancel';
  requestId: string;
  expectedRevision?: number; digest?: string; content?: string; taskId?: string;
  evidence?: { summary: string; artifactDigest: string; testDigest: string };
}
interface State { version: 1; conversations: Collaboration[]; }
const actorKey = (actor: NetworkActor): string => `${actor.nodeId}/${actor.agentId}`;
export const agreementAccepted = (c: Collaboration): boolean => c.accepted.length === 2 && c.approvals.length === 2;
const path = (root: string): string => join(root, 'collaborations.json');
const hashPattern = /^sha256:[0-9a-f]{64}$/;

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`Invalid or oversized ${label}`);
  return value;
}
function terminalText(value: unknown, label: string): string {
  const result = text(value, label, 256);
  if (Buffer.byteLength(JSON.stringify(result)) > 258) throw new Error(`Invalid or oversized encoded ${label}`);
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unsupported collaboration field');
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) throw new Error('Invalid digest');
  return value;
}
export function parseCollaborationOperation(value: unknown): CollaborationOperation {
  const v = object(value);
  const type = v.type as CollaborationOperation['type'];
  const fields: Record<CollaborationOperation['type'], string[]> = {
    get: [], accept: [], discuss: ['content'], propose: ['expectedRevision', 'content'],
    approve: ['expectedRevision', 'digest'], task: ['expectedRevision', 'digest', 'taskId', 'content'],
    read: ['taskId'], processed: ['taskId', 'evidence'], fail: ['taskId', 'content'],
    'cancel-task': ['taskId'], 'cancelled-task': ['taskId'], cancel: [],
  };
  if (!Object.hasOwn(fields, type)) throw new Error('Unsupported collaboration operation');
  keys(v, ['type', 'requestId', ...fields[type]]);
  for (const field of fields[type]) if (!(field in v)) throw new Error(`Missing ${field}`);
  const result: CollaborationOperation = { type, requestId: validateNetworkId(v.requestId, 'requestId') };
  if ('expectedRevision' in v) {
    if (!Number.isSafeInteger(v.expectedRevision) || (v.expectedRevision as number) < 0) throw new Error('Invalid expected revision');
    result.expectedRevision = v.expectedRevision as number;
  }
  if ('content' in v) result.content = type === 'fail' ? terminalText(v.content, 'content') : text(v.content, 'content', type === 'propose' ? 12_000 : 2_000);
  if ('digest' in v) result.digest = hash(v.digest);
  if ('taskId' in v) result.taskId = validateNetworkId(v.taskId, 'taskId');
  if ('evidence' in v) {
    const e = object(v.evidence);
    keys(e, ['summary', 'artifactDigest', 'testDigest']);
    result.evidence = { summary: terminalText(e.summary, 'evidence summary'), artifactDigest: hash(e.artifactDigest), testDigest: hash(e.testDigest) };
  }
  return result;
}
async function readState(root: string): Promise<State> {
  const raw = await readUtf8IfExists(path(root));
  if (raw === undefined) return { version: 1, conversations: [] };
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Collaboration state quota exceeded');
  const state = JSON.parse(raw) as State;
  if (state.version !== 1 || !Array.isArray(state.conversations) || state.conversations.length > 32) throw new Error('Invalid collaboration state');
  return state;
}
async function save(root: string, state: State): Promise<void> {
  for (const c of state.conversations) if (Buffer.byteLength(JSON.stringify(c)) > 60_000) throw new Error('Conversation byte quota exceeded; start a new collaboration');
  await atomicWriteFile(path(root), `${JSON.stringify(state)}\n`);
}
export async function listLocalCollaborationSummaries(root: string, nodeId: string, agentId: string) {
  return (await readState(root)).conversations.filter(c =>
    (c.authority.nodeId === nodeId && c.authority.agentId === agentId) || (c.remote.nodeId === nodeId && c.remote.agentId === agentId)
  ).map(c => ({ id: c.id, expiresAt: c.expiresAt, revision: c.revision, cancelled: c.cancelled,
    accepted: c.accepted.length, approvals: c.approvals.length,
    tasks: c.tasks.map(t => ({ id: t.id, phase: t.phase })),
  }));
}
export async function createCollaboration(root: string, input: {
  id: string; localAgentId: string; remoteNodeId: string; remoteAgentId: string; topic: string; expiresAt: string;
}): Promise<Collaboration> {
  const local = await exportPublicIdentity(root);
  const remote = await getTrustedPeer(root, validateNetworkId(input.remoteNodeId, 'remoteNodeId'));
  if (!remote || remote.nodeId === local.nodeId) throw new Error('Collaboration requires a distinct trusted remote node');
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== input.expiresAt || expires <= Date.now() || expires - Date.now() > 30 * 86400_000) throw new Error('Invalid collaboration expiry (maximum 30 days)');
  const conversation: Collaboration = {
    version: 1, id: validateNetworkId(input.id, 'id'),
    authority: { nodeId: local.nodeId, agentId: validateNetworkId(input.localAgentId, 'localAgentId') },
    remote: { nodeId: remote.nodeId, agentId: validateNetworkId(input.remoteAgentId, 'remoteAgentId') },
    remoteFingerprint: remote.fingerprint, topic: text(input.topic, 'topic', 500), expiresAt: input.expiresAt,
    accepted: [`${local.nodeId}/${input.localAgentId}`], revision: 0, content: '', digest: sha256(''),
    approvals: [], tasks: [], cancelled: false, audit: [],
  };
  return await withFileLock(join(root, 'locks'), 'collaborations', async () => {
    const state = await readState(root);
    if (state.conversations.some((c) => c.id === conversation.id)) throw new Error('Collaboration already exists');
    if (state.conversations.length >= 32) throw new Error('Collaboration quota exceeded');
    state.conversations.push(conversation);
    await save(root, state);
    return conversation;
  });
}

function apply(c: Collaboration, actor: NetworkActor, op: CollaborationOperation): void {
  const who = actorKey(actor);
  if (op.type === 'accept') {
    if (!c.accepted.includes(who)) c.accepted.push(who);
    return;
  }
  if (op.type === 'cancel') {
    c.cancelled = true;
    for (const task of c.tasks) if (['transport-received', 'agent-read'].includes(task.phase)) task.phase = 'cancel-requested';
    return;
  }
  if (c.accepted.length !== 2) throw new Error('Invitation has not been accepted by both principals; get the authoritative snapshot and retry this unchanged request after both accepts are recorded');
  if (op.type === 'discuss') return;
  if (op.type === 'propose') {
    if (c.tasks.some((t) => t.phase === 'agent-read' || t.phase === 'cancel-requested')) throw new Error('Resolve active tasks before editing the agreement');
    if (op.expectedRevision !== c.revision) throw new Error('Stale expected revision');
    c.content = op.content!; c.digest = sha256(c.content); c.revision += 1; c.approvals = [];
    return;
  }
  if (op.type === 'approve' || op.type === 'task') {
    if (op.expectedRevision !== c.revision || op.digest !== c.digest || c.revision === 0) throw new Error('Approval/task must bind the exact current revision and digest');
    if (op.type === 'approve') { if (!c.approvals.includes(who)) c.approvals.push(who); return; }
    if (!agreementAccepted(c)) throw new Error('Two distinct principal approvals are required');
    if (c.tasks.length >= 16 || c.tasks.some((t) => t.id === op.taskId)) throw new Error('Task quota exceeded or duplicate task ID');
    c.tasks.push({ id: op.taskId!, sender: actor, recipient: who === actorKey(c.authority) ? c.remote : c.authority,
      revision: c.revision, digest: c.digest, body: op.content!, phase: 'transport-received' });
    return;
  }
  const task = c.tasks.find((t) => t.id === op.taskId);
  if (!task) throw new Error('Unknown task');
  if (op.type === 'cancel-task') {
    if (who !== actorKey(task.sender)) throw new Error('Only task sender may request cancellation');
    if (task.phase === 'processed' || task.phase === 'failed' || task.phase === 'cancelled' || task.phase === 'cancel-requested') throw new Error('Task is terminal');
    task.phase = 'cancel-requested'; return;
  }
  if (who !== actorKey(task.recipient)) throw new Error('Only the bound recipient can acknowledge this task');
  if (op.type === 'cancelled-task') {
    if (task.phase !== 'cancel-requested') throw new Error('Cancellation was not requested');
    task.phase = 'cancelled'; return;
  }
  if (op.type === 'read') {
    if (task.phase !== 'transport-received') throw new Error('Task is not awaiting agent read');
    if (task.revision !== c.revision || task.digest !== c.digest || !agreementAccepted(c)) throw new Error('Task agreement is stale');
    task.phase = 'agent-read'; return;
  }
  if (task.phase !== 'agent-read') throw new Error('Task must be agent-read before terminal processing acknowledgement');
  if (task.revision !== c.revision || task.digest !== c.digest || !agreementAccepted(c)) throw new Error('Task agreement is stale');
  if (op.type === 'processed') { task.phase = 'processed'; task.evidence = op.evidence!; }
  else if (op.type === 'fail') { task.phase = 'failed'; }
  else throw new Error('Invalid task transition');
}

// Reserve the exact worst remaining lifecycle size for each task, using its actual
// principal/task IDs and maximum valid request IDs/evidence. Ordinary discussion
// cannot consume this space; read and terminal transitions share the reserve.
function lifecycleReserve(c: Collaboration): { bytes: number; rounds: number } {
  const requestId = 'r'.repeat(128), at = '2099-01-01T00:00:00.000Z';
  const evidence = { summary: 's'.repeat(256), artifactDigest: sha256('artifact'), testDigest: sha256('test') };
  const entryBytes = (actor: NetworkActor, operation: CollaborationOperation): number =>
    Buffer.byteLength(JSON.stringify({ sequence: 256, actor, requestId, hash: sha256('operation'), at, operation })) + 1;
  let bytes = 0, rounds = 0;
  for (const task of c.tasks) {
    if (['processed', 'failed', 'cancelled'].includes(task.phase)) continue;
    const original = Buffer.byteLength(JSON.stringify(task));
    const operation = (type: CollaborationOperation['type'], extra = {}): CollaborationOperation => ({ type, requestId, taskId: task.id, ...extra });
    const cancelled = entryBytes(task.recipient, operation('cancelled-task'))
      + Buffer.byteLength(JSON.stringify({ ...task, phase: 'cancelled' })) - original;
    if (task.phase === 'cancel-requested') { bytes += cancelled; rounds++; continue; }
    const cancel = entryBytes(task.sender, operation('cancel-task')) + cancelled;
    const processed = entryBytes(task.recipient, operation('processed', { evidence }))
      + Buffer.byteLength(JSON.stringify({ ...task, phase: 'processed', evidence })) - original;
    const failed = entryBytes(task.recipient, operation('fail', { content: 'f'.repeat(256) }))
      + Buffer.byteLength(JSON.stringify({ ...task, phase: 'failed' })) - original;
    const read = task.phase === 'transport-received' ? entryBytes(task.recipient, operation('read')) : 0;
    bytes += read + Math.max(cancel, processed, failed);
    rounds += (read ? 1 : 0) + 2;
  }
  if (!c.cancelled) {
    bytes += Math.max(...[c.authority, c.remote].map(actor => entryBytes(actor, { type: 'cancel', requestId })));
    rounds++;
  }
  return { bytes, rounds };
}

// The authority assigns every sequence and revision. Remote callers never choose a local actor.
export async function operateCollaboration(root: string, idValue: string, actor: NetworkActor, value: unknown, expectedAuthorityAgentId?: string): Promise<Collaboration> {
  const id = validateNetworkId(idValue, 'conversationId');
  validateNetworkId(actor.nodeId, 'actor.nodeId'); validateNetworkId(actor.agentId, 'actor.agentId');
  const op = parseCollaborationOperation(value);
  return await withFileLock(join(root, 'locks'), 'collaborations', async () => {
    const state = await readState(root);
    const c = state.conversations.find((candidate) => candidate.id === id);
    if (!c || ![actorKey(c.authority), actorKey(c.remote)].includes(actorKey(actor))) throw new Error('Collaboration is not available to this principal');
    if (expectedAuthorityAgentId !== undefined && c.authority.agentId !== expectedAuthorityAgentId) throw new Error('Collaboration authority scope mismatch');
    const execute = async (): Promise<Collaboration> => {
      if (Date.parse(c.expiresAt) <= Date.now()) throw new Error('Collaboration expired');
      const operationHash = sha256(JSON.stringify(op));
      const prior = c.audit.find((e) => actorKey(e.actor) === actorKey(actor) && e.requestId === op.requestId);
      if (prior && prior.hash !== operationHash) throw new Error('Conflicting operation replay');
      if (op.type === 'get' || prior) return structuredClone(c);
      if (c.cancelled && op.type !== 'cancelled-task') throw new Error('Collaboration is cancelled');
      const terminal = ['read', 'processed', 'fail', 'cancel', 'cancel-task', 'cancelled-task'].includes(op.type);
      if (c.audit.length >= (terminal ? 256 : 192)) throw new Error('Conversation round quota exceeded');
      apply(c, actor, op);
      c.audit.push({ sequence: c.audit.length + 1, actor, requestId: op.requestId, hash: operationHash, at: new Date().toISOString(), operation: op });
      const reserved = lifecycleReserve(c);
      if (c.audit.length + reserved.rounds > 256 || Buffer.byteLength(JSON.stringify(c)) + reserved.bytes > 60_000) throw new Error('Conversation lifecycle quota exceeded; task completion capacity is reserved');
      await save(root, state);
      return structuredClone(c);
    };
    if (actor.nodeId === c.authority.nodeId) {
      if ((await exportPublicIdentity(root)).nodeId !== c.authority.nodeId) throw new Error('Incorrect authority node');
      return await execute();
    }
    // Trust/grant stays locked through read or mutation: completed revocation wins.
    return await withDeliveryAuthorization(root, actor.nodeId, actor.agentId, c.authority.agentId, c.id, async () => {
      if ((await getTrustedPeer(root, actor.nodeId))?.fingerprint !== c.remoteFingerprint) throw new Error('Invitation peer certificate changed');
      return await execute();
    });
  });
}

export function parseCollaborationSnapshot(value: unknown): Collaboration {
  const c = object(value) as unknown as Collaboration;
  if (c.version !== 1 || Buffer.byteLength(JSON.stringify(c)) > 60_000) throw new Error('Invalid collaboration snapshot');
  validateNetworkId(c.id, 'id');
  for (const actor of [c.authority, c.remote]) { validateNetworkId(actor?.nodeId, 'nodeId'); validateNetworkId(actor?.agentId, 'agentId'); }
  if (c.authority.nodeId === c.remote.nodeId || typeof c.content !== 'string' || c.digest !== sha256(c.content)
    || !Number.isSafeInteger(c.revision) || c.revision < 0 || !Array.isArray(c.audit) || c.audit.length > 256
    || !Array.isArray(c.tasks) || c.tasks.length > 16 || !Array.isArray(c.accepted) || !Array.isArray(c.approvals)
    || typeof c.cancelled !== 'boolean' || !Number.isFinite(Date.parse(c.expiresAt))) throw new Error('Invalid collaboration snapshot');
  const members = [actorKey(c.authority), actorKey(c.remote)];
  for (const list of [c.accepted, c.approvals]) if (new Set(list).size !== list.length || list.some((p) => !members.includes(p))) throw new Error('Invalid principal approvals');
  c.audit.forEach((entry, i) => {
    if (entry.sequence !== i + 1 || !members.includes(actorKey(entry.actor)) || entry.hash !== sha256(JSON.stringify(parseCollaborationOperation(entry.operation)))) throw new Error('Invalid collaboration audit');
  });
  for (const task of c.tasks) {
    validateNetworkId(task.id, 'taskId');
    if (!members.includes(actorKey(task.sender)) || !members.includes(actorKey(task.recipient)) || actorKey(task.sender) === actorKey(task.recipient)
      || !['transport-received', 'agent-read', 'processed', 'failed', 'cancel-requested', 'cancelled'].includes(task.phase)
      || !Number.isSafeInteger(task.revision) || task.revision < 1 || task.revision > c.revision || !hashPattern.test(task.digest)) throw new Error('Invalid task scope');
    if (task.phase === 'processed') {
      if (!task.evidence || !hashPattern.test(task.evidence.artifactDigest) || !hashPattern.test(task.evidence.testDigest)) throw new Error('Missing processing evidence');
    }
  }
  return c;
}

// Only CLI owner administration creates execution permits. They never travel to the peer.
interface ExecutionScope {
  localNodeId: string; agentId: string; workspaceRoot: string; conversationId: string;
  authority: NetworkActor; authorityFingerprint: string; peer: NetworkActor; peerFingerprint: string;
  revision: number; digest: string;
}
interface ExecutionPermit extends ExecutionScope { expiresAt: string; }
async function executionScope(root: string, c: Collaboration, agentId: string, workspaceRoot: string): Promise<ExecutionScope> {
  const local = await exportPublicIdentity(root);
  const isAuthority = c.authority.nodeId === local.nodeId;
  const actor = isAuthority ? c.authority : c.remote;
  if (actor.nodeId !== local.nodeId || actor.agentId !== validateNetworkId(agentId, 'agentId')) throw new Error('Execution permit actor scope mismatch');
  const peerActor = isAuthority ? c.remote : c.authority;
  const peer = await getTrustedPeer(root, peerActor.nodeId);
  if (!peer) throw new Error('Execution permit requires a currently trusted peer');
  if (c.remoteFingerprint !== (isAuthority ? peer.fingerprint : local.fingerprint)) throw new Error('Execution permit certificate scope mismatch');
  return { localNodeId: local.nodeId, agentId, workspaceRoot: await realpath(workspaceRoot), conversationId: c.id,
    authority: c.authority, authorityFingerprint: isAuthority ? local.fingerprint : peer.fingerprint,
    peer: peerActor, peerFingerprint: peer.fingerprint, revision: c.revision, digest: c.digest };
}
export async function authorizeLocalExecution(root: string, input: { agentId: string; workspaceRoot: string; collaboration: Collaboration; expiresAt: string }): Promise<void> {
  const c = parseCollaborationSnapshot(input.collaboration);
  if (!agreementAccepted(c) || c.cancelled || Date.parse(c.expiresAt) <= Date.now()) throw new Error('Owner execution requires a live jointly approved agreement');
  const scope = await executionScope(root, c, input.agentId, input.workspaceRoot);
  const ttl = Date.parse(input.expiresAt) - Date.now();
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86400_000 || new Date(input.expiresAt).toISOString() !== input.expiresAt) throw new Error('Execution permit must expire within 24 hours');
  await withFileLock(join(root, 'locks'), 'execution-permits', async () => {
    const raw = await readUtf8IfExists(join(root, 'execution-permits.json'));
    const permits = raw ? JSON.parse(raw) as ExecutionPermit[] : [];
    const remaining = permits.filter((p) => Date.parse(p.expiresAt) > Date.now() && !(p.agentId === scope.agentId && p.conversationId === scope.conversationId && p.authority?.nodeId === scope.authority.nodeId && p.authority?.agentId === scope.authority.agentId));
    if (remaining.length >= 32) throw new Error('Execution permit quota exceeded');
    await atomicWriteFile(join(root, 'execution-permits.json'), JSON.stringify([...remaining, { ...scope, expiresAt: input.expiresAt }]));
  }, { timeoutMs: 15000 });
}
export async function requireLocalExecution(root: string, c: Collaboration, agentId: string, workspaceRoot: string): Promise<void> {
  const scope = await executionScope(root, c, agentId, workspaceRoot);
  const raw = await readUtf8IfExists(join(root, 'execution-permits.json'));
  const permits = raw ? JSON.parse(raw) as ExecutionPermit[] : [];
  if (!permits.some(({ expiresAt, ...candidate }) => JSON.stringify(candidate) === JSON.stringify(scope) && Date.parse(expiresAt) > Date.now())) throw new Error('Owner execution permit required for this exact agreement, authority and workspace');
}
export const newCollaborationRequestId = (): string => `op-${randomUUID()}`;
export async function revokeLocalExecution(root: string, conversationId: string, agentId: string): Promise<void> {
  validateNetworkId(conversationId, 'conversationId'); validateNetworkId(agentId, 'agentId');
  await withFileLock(join(root, 'locks'), 'execution-permits', async () => {
    const file = join(root, 'execution-permits.json');
    const raw = await readUtf8IfExists(file);
    const permits = raw ? JSON.parse(raw) as ExecutionPermit[] : [];
    await atomicWriteFile(file, JSON.stringify(permits.filter((p) => p.conversationId !== conversationId || p.agentId !== agentId)));
  }, { timeoutMs: 15000 });
}
export async function withLocalExecution<T>(root: string, c: Collaboration, agentId: string, workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  return await withFileLock(join(root, 'locks'), 'execution-permits', async () => {
    await requireLocalExecution(root, c, agentId, workspaceRoot);
    return await operation();
  }, { timeoutMs: 15000 });
}
