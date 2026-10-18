import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, readUtf8IfExists, withFileLock } from '../atomic.js';
import { loadNodeIdentity } from './identity.js';
import { queueOutboundEvent, readMailboxState, receiveAuthorizedInboundEvent, recordOutboundReceipt } from './mailbox.js';
import { certificateDerFingerprint, getTrustedPeer, withDeliveryAuthorization } from './trust.js';
import { A2A_V1_SUBSET_FIXTURE } from './a2a-v1-fixture.js';
import {
  MAX_ENVELOPE_BODY_BYTES,
  MAX_WIRE_BYTES,
  NETWORK_SCHEMA_VERSION,
  type NetworkEnvelope,
  type NodePublicIdentity,
  type TransportReceipt,
  parseEnvelope,
  parseReceipt,
  sha256,
  validateNetworkId,
} from './types.js';

export const A2A_PROTOCOL_VERSION = A2A_V1_SUBSET_FIXTURE.protocolVersion;
export const A2A_SPECIFICATION_REVISION = A2A_V1_SUBSET_FIXTURE.specificationRevision;
export const A2A_METHODS = A2A_V1_SUBSET_FIXTURE.methods;

export interface A2AMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: Array<{ text: string; mediaType?: 'text/plain' }>;
  metadata?: { agentlinkSenderAgentId: string; agentlinkEnvelope?: NetworkEnvelope };
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: { state: 'TASK_STATE_SUBMITTED'; timestamp: string };
  history?: A2AMessage[];
  metadata: { transportStatus: 'transport-received'; agentlinkTransportReceipt: TransportReceipt };
}

export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: Array<{ url: string; protocolBinding: 'JSONRPC'; tenant: string; protocolVersion: '1.0' }>;
  version: '0.2.0';
  capabilities: { streaming: false; pushNotifications: false; extendedAgentCard: false };
  securitySchemes: { mutualTls: { mtlsSecurityScheme: { description: string } } };
  securityRequirements: Array<{ schemes: { mutualTls: string[] } }>;
  defaultInputModes: ['text/plain'];
  defaultOutputModes: ['text/plain'];
  skills: Array<{
    id: string; name: string; description: string; tags: string[];
    inputModes: ['text/plain']; outputModes: ['text/plain'];
  }>;
}

interface StoredTask {
  task: A2ATask;
  message: A2AMessage;
  ownerNodeId: string;
  ownerAgentId: string;
  recipientAgentId: string;
  eventId: string;
  messageHash: string;
}

interface TaskState {
  version: 1;
  tasks: StoredTask[];
}

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export type A2AJsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

const taskPath = (root: string): string => join(root, 'a2a-tasks.json');
const locksPath = (root: string): string => join(root, 'locks');
export const A2A_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_A2A_TASKS = 128;
export const MAX_A2A_TASKS_PER_PEER = 64;

class A2AFailure extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new A2AFailure(-32602, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: string[], required: string[], label: string): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw new A2AFailure(-32602, `${label} has unsupported field: ${unknown}`);
  const missing = required.find((key) => !(key in input));
  if (missing) throw new A2AFailure(-32602, `${label} is missing field: ${missing}`);
}

function parseMessage(value: unknown): A2AMessage {
  const input = object(value, 'message');
  exactKeys(input, ['messageId', 'contextId', 'taskId', 'role', 'parts', 'metadata'], ['messageId', 'role', 'parts', 'metadata'], 'message');
  const messageId = validateNetworkId(input.messageId, 'message.messageId');
  if (input.role !== 'ROLE_USER') throw new A2AFailure(-32602, 'Only ROLE_USER input messages are supported');
  if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 16) throw new A2AFailure(-32602, 'message.parts must contain 1-16 text parts');
  const parts = input.parts.map((part, index) => {
    const parsed = object(part, `message.parts[${index}]`);
    exactKeys(parsed, ['text', 'mediaType'], ['text'], `message.parts[${index}]`);
    if (typeof parsed.text !== 'string') throw new A2AFailure(-32602, `message.parts[${index}].text must be a string`);
    if (parsed.mediaType !== undefined && parsed.mediaType !== 'text/plain') throw new A2AFailure(-32005, 'Only text/plain message parts are supported');
    return { text: parsed.text, ...(parsed.mediaType === undefined ? {} : { mediaType: 'text/plain' as const }) };
  });
  if (Buffer.byteLength(parts.map((part) => part.text).join(''), 'utf8') > MAX_ENVELOPE_BODY_BYTES) {
    throw new A2AFailure(-32602, 'Message text exceeds the supported size');
  }
  const metadata = object(input.metadata, 'message.metadata');
  exactKeys(metadata, ['agentlinkSenderAgentId', 'agentlinkEnvelope'], ['agentlinkSenderAgentId'], 'message.metadata');
  const senderAgentId = validateNetworkId(metadata.agentlinkSenderAgentId, 'message.metadata.agentlinkSenderAgentId');
  let agentlinkEnvelope: NetworkEnvelope | undefined;
  if (metadata.agentlinkEnvelope !== undefined) {
    try {
      agentlinkEnvelope = parseEnvelope(metadata.agentlinkEnvelope);
    } catch (error) {
      throw new A2AFailure(-32602, `message.metadata.agentlinkEnvelope is invalid: ${(error as Error).message}`);
    }
  }
  const contextId = input.contextId === undefined ? undefined : validateNetworkId(input.contextId, 'message.contextId');
  const taskId = input.taskId === undefined ? undefined : validateNetworkId(input.taskId, 'message.taskId');
  return { messageId, role: 'ROLE_USER', parts, metadata: { agentlinkSenderAgentId: senderAgentId, ...(agentlinkEnvelope ? { agentlinkEnvelope } : {}) }, ...(contextId ? { contextId } : {}), ...(taskId ? { taskId } : {}) };
}

function parseStoredState(value: unknown): TaskState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid A2A task state');
  const input = value as Partial<TaskState>;
  if (input.version !== NETWORK_SCHEMA_VERSION || !Array.isArray(input.tasks)) throw new Error('Invalid A2A task state');
  return input as TaskState;
}

async function readTaskState(root: string): Promise<TaskState> {
  const content = await readUtf8IfExists(taskPath(root));
  return content === undefined ? { version: NETWORK_SCHEMA_VERSION, tasks: [] } : parseStoredState(JSON.parse(content));
}

function taskForHistory(stored: StoredTask, historyLength?: number): A2ATask {
  const include = historyLength === undefined ? true : historyLength > 0;
  return { ...stored.task, ...(include ? { history: [stored.message] } : {}) };
}

function compactTasks(state: TaskState, now: Date): void {
  const cutoff = now.getTime() - A2A_TASK_RETENTION_MS;
  state.tasks = state.tasks.filter((entry) => Date.parse(entry.task.status.timestamp) >= cutoff);
}

async function waitAtPollAuthorizationTestBarrier(root: string): Promise<void> {
  if (process.env.AGENTLINK_TEST_A2A_POLL_BARRIER_ROOT !== root) return;
  const barrier = join(root, 'a2a-poll-test-barrier');
  await mkdir(barrier, { recursive: true, mode: 0o700 });
  await atomicWriteFile(join(barrier, 'ready'), `${process.pid}\n`);
  const deadline = Date.now() + 5_000;
  while (await readUtf8IfExists(join(barrier, 'continue')) === undefined) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting at the A2A poll authorization test barrier');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function sendMessage(root: string, authenticatedNodeId: string, paramsValue: unknown): Promise<{ task: A2ATask }> {
  const params = object(paramsValue, 'params');
  exactKeys(params, ['tenant', 'message', 'configuration', 'metadata'], ['tenant', 'message'], 'params');
  if (params.metadata !== undefined) throw new A2AFailure(-32004, 'Request metadata is not supported');
  if (params.configuration === undefined) {
    throw new A2AFailure(-32004, 'Blocking SendMessage is not supported; set configuration.returnImmediately to true');
  }
  const configuration = object(params.configuration, 'params.configuration');
  exactKeys(configuration, ['returnImmediately'], ['returnImmediately'], 'params.configuration');
  if (typeof configuration.returnImmediately !== 'boolean') {
    throw new A2AFailure(-32602, 'params.configuration.returnImmediately must be a boolean');
  }
  if (!configuration.returnImmediately) {
    throw new A2AFailure(-32004, 'Blocking SendMessage is not supported; set configuration.returnImmediately to true');
  }
  const recipientAgentId = validateNetworkId(params.tenant, 'params.tenant');
  const message = parseMessage(params.message);
  const contextId = message.contextId;
  if (!contextId) throw new A2AFailure(-32602, 'message.contextId is required as the selected AgentLink conversation');
  if (message.taskId) throw new A2AFailure(-32004, 'Continuing an existing task is not supported');
  const senderAgentId = message.metadata!.agentlinkSenderAgentId;
  const messageHash = sha256(JSON.stringify(message));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return await withFileLock(locksPath(root), 'a2a-tasks', async () => {
    const state = await readTaskState(root);
    const now = new Date();
    compactTasks(state, now);
    const existing = state.tasks.find((entry) => entry.ownerNodeId === authenticatedNodeId && entry.message.messageId === message.messageId);
    if (existing) {
      if (existing.messageHash !== messageHash || existing.recipientAgentId !== recipientAgentId) throw new A2AFailure(-32602, 'messageId was already used with different content');
      try {
        return await withDeliveryAuthorization(
          root,
          authenticatedNodeId,
          existing.ownerAgentId,
          existing.recipientAgentId,
          existing.task.contextId,
          async () => ({ task: taskForHistory(existing) }),
          now,
        );
      } catch {
        throw new A2AFailure(A2A_V1_SUBSET_FIXTURE.errors.taskNotFound, 'Requested target is not available');
      }
    }
    if (state.tasks.length >= MAX_A2A_TASKS
      || state.tasks.filter((entry) => entry.ownerNodeId === authenticatedNodeId).length >= MAX_A2A_TASKS_PER_PEER) {
      throw new A2AFailure(-32603, 'A2A task quota exceeded');
    }
    const localNodeId = (await loadNodeIdentity(root)).nodeId;
    const body = message.parts.map((part) => part.text).join('');
    const suppliedEnvelope = message.metadata?.agentlinkEnvelope;
    const envelope: NetworkEnvelope = suppliedEnvelope ?? {
      version: NETWORK_SCHEMA_VERSION,
      eventId: `a2a-${sha256(`${authenticatedNodeId}\0${message.messageId}`).slice(7, 47)}`,
      sender: { nodeId: authenticatedNodeId, agentId: senderAgentId },
      recipient: { nodeId: localNodeId, agentId: recipientAgentId },
      collaborationId: contextId,
      kind: 'message',
      body,
      createdAt: now.toISOString(),
    };
    if (envelope.sender.nodeId !== authenticatedNodeId || envelope.sender.agentId !== senderAgentId
      || envelope.recipient.nodeId !== localNodeId || envelope.recipient.agentId !== recipientAgentId
      || envelope.collaborationId !== contextId || envelope.body !== body) {
      throw new A2AFailure(-32602, 'AgentLink envelope does not match the authenticated A2A request scope');
    }
    const payload = JSON.stringify(envelope);
    let receipt: TransportReceipt;
    try {
      receipt = await receiveAuthorizedInboundEvent(root, envelope, payload, authenticatedNodeId, now);
    } catch (error) {
      if (/grant|trusted/i.test(error instanceof Error ? error.message : String(error))) {
        throw new A2AFailure(A2A_V1_SUBSET_FIXTURE.errors.taskNotFound, 'Requested target is not available');
      }
      throw error;
    }
    const task: A2ATask = {
      id: `task-${randomUUID()}`,
      contextId,
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: now.toISOString() },
      metadata: { transportStatus: 'transport-received', agentlinkTransportReceipt: receipt },
    };
    const stored: StoredTask = {
      task, message, ownerNodeId: authenticatedNodeId, ownerAgentId: senderAgentId,
      recipientAgentId, eventId: envelope.eventId, messageHash,
    };
    state.tasks.push(stored);
    await atomicWriteFile(taskPath(root), `${JSON.stringify(state)}\n`);
    return { task: taskForHistory(stored) };
  });
}

async function getTask(root: string, authenticatedNodeId: string, paramsValue: unknown): Promise<A2ATask> {
  const params = object(paramsValue, 'params');
  exactKeys(params, ['tenant', 'id', 'historyLength'], ['tenant', 'id'], 'params');
  const tenant = validateNetworkId(params.tenant, 'params.tenant');
  const id = validateNetworkId(params.id, 'params.id');
  const historyLength = params.historyLength === undefined ? undefined : params.historyLength;
  if (historyLength !== undefined && (!Number.isInteger(historyLength) || (historyLength as number) < 0 || (historyLength as number) > 16)) {
    throw new A2AFailure(-32602, 'historyLength must be an integer from 0 to 16');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await withFileLock(locksPath(root), 'a2a-tasks', async () => {
    const state = await readTaskState(root);
    const priorLength = state.tasks.length;
    compactTasks(state, new Date());
    if (state.tasks.length !== priorLength) await atomicWriteFile(taskPath(root), `${JSON.stringify(state)}\n`);
    const stored = state.tasks.find((entry) => entry.task.id === id && entry.ownerNodeId === authenticatedNodeId);
    if (!stored) throw new A2AFailure(-32001, 'Task not found');
    if (tenant !== stored.recipientAgentId) throw new A2AFailure(-32001, 'Task not found');
    try {
      return await withDeliveryAuthorization(
        root,
        authenticatedNodeId,
        stored.ownerAgentId,
        stored.recipientAgentId,
        stored.task.contextId,
        async () => {
          await waitAtPollAuthorizationTestBarrier(root);
          return taskForHistory(stored, historyLength as number | undefined);
        },
      );
    } catch {
      throw new A2AFailure(-32001, 'Task not found');
    }
  });
}

export function validateA2AAgentCard(value: unknown): A2AAgentCard {
  const card = object(value, 'AgentCard');
  const cardFields = [...A2A_V1_SUBSET_FIXTURE.agentCard.required, 'securitySchemes', 'securityRequirements'];
  exactKeys(card, cardFields, cardFields, 'AgentCard');
  for (const field of A2A_V1_SUBSET_FIXTURE.agentCard.required) {
    if (!(field in card)) throw new Error(`AgentCard is missing required A2A 1.0 field: ${field}`);
  }
  if (typeof card.name !== 'string' || typeof card.description !== 'string' || card.version !== '0.2.0') {
    throw new Error('AgentCard identity fields do not match the pinned A2A 1.0 subset');
  }
  if (!Array.isArray(card.supportedInterfaces) || card.supportedInterfaces.length === 0) {
    throw new Error('AgentCard must advertise at least one agent-specific interface');
  }
  for (const value of card.supportedInterfaces) {
    const agentInterface = object(value, 'AgentInterface');
    const interfaceFields = [...A2A_V1_SUBSET_FIXTURE.agentCard.interfaceRequired, A2A_V1_SUBSET_FIXTURE.agentCard.interfaceTenantField];
    exactKeys(agentInterface, interfaceFields, interfaceFields, 'AgentInterface');
    for (const field of A2A_V1_SUBSET_FIXTURE.agentCard.interfaceRequired) {
      if (!(field in agentInterface)) throw new Error(`AgentInterface is missing required A2A 1.0 field: ${field}`);
    }
    if (typeof agentInterface.url !== 'string' || new URL(agentInterface.url).protocol !== 'https:'
      || agentInterface.protocolBinding !== A2A_V1_SUBSET_FIXTURE.binding
      || agentInterface.protocolVersion !== A2A_PROTOCOL_VERSION) {
      throw new Error('AgentInterface does not match the pinned A2A 1.0 JSON-RPC subset');
    }
    validateNetworkId(agentInterface.tenant, 'AgentInterface.tenant');
  }
  const capabilities = object(card.capabilities, 'AgentCapabilities');
  exactKeys(capabilities, ['streaming', 'pushNotifications', 'extendedAgentCard'], ['streaming', 'pushNotifications', 'extendedAgentCard'], 'AgentCapabilities');
  if (capabilities.streaming !== false || capabilities.pushNotifications !== false || capabilities.extendedAgentCard !== false) {
    throw new Error('AgentCard advertises unsupported capabilities');
  }
  const schemes = object(card.securitySchemes, 'AgentCard.securitySchemes');
  exactKeys(schemes, ['mutualTls'], ['mutualTls'], 'AgentCard.securitySchemes');
  const mutualTls = object(schemes.mutualTls, 'AgentCard.securitySchemes.mutualTls');
  exactKeys(mutualTls, [A2A_V1_SUBSET_FIXTURE.agentCard.securitySchemeUnionField], [A2A_V1_SUBSET_FIXTURE.agentCard.securitySchemeUnionField], 'AgentCard.securitySchemes.mutualTls');
  const mtls = object(mutualTls[A2A_V1_SUBSET_FIXTURE.agentCard.securitySchemeUnionField], 'MutualTlsSecurityScheme');
  exactKeys(mtls, ['description'], ['description'], 'MutualTlsSecurityScheme');
  if (typeof mtls.description !== 'string') throw new Error('AgentCard mutual TLS scheme is invalid');
  if (!Array.isArray(card.securityRequirements) || card.securityRequirements.length !== 1) {
    throw new Error('AgentCard must contain one mutual TLS security requirement');
  }
  const requirement = object(card.securityRequirements[0], 'SecurityRequirement');
  exactKeys(requirement, [A2A_V1_SUBSET_FIXTURE.agentCard.securityRequirementMapField], [A2A_V1_SUBSET_FIXTURE.agentCard.securityRequirementMapField], 'SecurityRequirement schemes map');
  const requirementSchemes = object(requirement[A2A_V1_SUBSET_FIXTURE.agentCard.securityRequirementMapField], 'SecurityRequirement.schemes');
  exactKeys(requirementSchemes, ['mutualTls'], ['mutualTls'], 'SecurityRequirement.schemes');
  if (!Array.isArray(requirementSchemes.mutualTls) || requirementSchemes.mutualTls.some((scope) => typeof scope !== 'string')) {
    throw new Error('AgentCard SecurityRequirement must use the A2A 1.0 schemes map');
  }
  for (const [field, label] of [['defaultInputModes', 'input'], ['defaultOutputModes', 'output']] as const) {
    if (!Array.isArray(card[field]) || card[field].length !== 1 || card[field][0] !== 'text/plain') {
      throw new Error(`AgentCard ${label} modes do not match the supported subset`);
    }
  }
  if (!Array.isArray(card.skills) || card.skills.length !== 1) throw new Error('AgentCard must advertise the implemented skill');
  const skill = object(card.skills[0], 'AgentSkill');
  exactKeys(skill, ['id', 'name', 'description', 'tags', 'inputModes', 'outputModes'], ['id', 'name', 'description', 'tags', 'inputModes', 'outputModes'], 'AgentSkill');
  if (skill.id !== 'agentlink-message' || typeof skill.name !== 'string' || typeof skill.description !== 'string'
    || !Array.isArray(skill.tags) || skill.tags.some((tag) => typeof tag !== 'string')
    || !Array.isArray(skill.inputModes) || skill.inputModes.length !== 1 || skill.inputModes[0] !== 'text/plain'
    || !Array.isArray(skill.outputModes) || skill.outputModes.length !== 1 || skill.outputModes[0] !== 'text/plain') {
    throw new Error('AgentCard skill does not match the supported subset');
  }
  return card as unknown as A2AAgentCard;
}

export function createAgentCard(nodeIdValue: string, interfaceUrl: string, agentIds: string[]): A2AAgentCard {
  const nodeId = validateNetworkId(nodeIdValue, 'nodeId');
  const tenants = [...new Set(agentIds.map((agentId) => validateNetworkId(agentId, 'agentId')))].sort();
  if (tenants.length === 0) throw new Error('No owner-authorized agents are available to this peer');
  return validateA2AAgentCard({
    name: `AgentLink ${nodeId}`,
    description: 'AgentLink authenticated text-message bridge with durable task polling.',
    supportedInterfaces: tenants.map((tenant) => ({ url: interfaceUrl, protocolBinding: 'JSONRPC', tenant, protocolVersion: A2A_PROTOCOL_VERSION })),
    version: '0.2.0',
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { mutualTls: { mtlsSecurityScheme: { description: 'Explicitly paired and pinned AgentLink node certificate.' } } },
    securityRequirements: [{ schemes: { mutualTls: [] } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: 'agentlink-message',
      name: 'AgentLink message delivery',
      description: 'Durably submits bounded untrusted text to one explicitly granted agent and conversation.',
      tags: ['coordination', 'message'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    }],
  });
}

export async function handleA2AJsonRpc(
  root: string,
  authenticatedNodeId: string,
  version: string | undefined,
  value: unknown,
): Promise<A2AJsonRpcResponse> {
  let id: string | number | null = null;
  try {
    if (version !== A2A_PROTOCOL_VERSION) throw new A2AFailure(-32009, 'A2A version not supported');
    const input = object(value, 'request');
    exactKeys(input, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'id', 'method'], 'request');
    if (input.jsonrpc !== '2.0' || (typeof input.id !== 'string' && typeof input.id !== 'number' && input.id !== null)) {
      throw new A2AFailure(-32600, 'Request payload validation error');
    }
    id = input.id;
    if (input.method === 'SendMessage') return { jsonrpc: '2.0', id, result: await sendMessage(root, authenticatedNodeId, input.params) };
    if (input.method === 'GetTask') return { jsonrpc: '2.0', id, result: await getTask(root, authenticatedNodeId, input.params) };
    const method = String(input.method);
    const pushMethods: readonly string[] = A2A_V1_SUBSET_FIXTURE.pushNotificationMethods;
    if (pushMethods.includes(method)) {
      throw new A2AFailure(A2A_V1_SUBSET_FIXTURE.errors.pushNotificationNotSupported, 'Push Notification is not supported');
    }
    const knownUnsupported: readonly string[] = A2A_V1_SUBSET_FIXTURE.unsupportedMethods;
    throw new A2AFailure(knownUnsupported.includes(method) ? -32004 : -32601, knownUnsupported.includes(method) ? 'Operation is not supported' : 'Method not found');
  } catch (error) {
    const failure = error instanceof A2AFailure ? error : new A2AFailure(-32603, 'Internal error');
    return { jsonrpc: '2.0', id, error: { code: failure.code, message: failure.message } };
  }
}

export class AuthenticatedRequestError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export interface AuthenticatedRequestOptions { timeoutMs?: number; signal?: AbortSignal; }

export async function authenticatedRequest(
  stateRoot: string,
  endpoint: string,
  peer: NodePublicIdentity,
  method: 'GET' | 'POST',
  body?: unknown,
  options: AuthenticatedRequestOptions = {},
): Promise<unknown> {
  options.signal?.throwIfAborted();
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 5000)) throw new Error('Request timeout must be from 1 to 5000 milliseconds');
  if (new URL(endpoint).protocol !== 'https:') throw new Error('Authenticated endpoint must use HTTPS');
  const trusted = await getTrustedPeer(stateRoot, peer.nodeId);
  if (!trusted || trusted.version !== peer.version || trusted.fingerprint !== peer.fingerprint
    || trusted.certificatePem !== peer.certificatePem) {
    throw new Error(`Peer ${peer.nodeId} does not exactly match the durable paired identity`);
  }
  const identity = await loadNodeIdentity(stateRoot);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = request(endpoint, {
      method,
      signal: options.signal,
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      ca: peer.certificatePem,
      checkServerIdentity: (_host, certificate) => !certificate.raw || certificateDerFingerprint(certificate.raw) !== peer.fingerprint
        ? new Error('Remote TLS certificate does not match the pinned peer identity') : undefined,
      headers: {
        'a2a-version': A2A_PROTOCOL_VERSION,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('error', reject);
      response.on('aborted', () => reject(Object.assign(new Error('A2A response was aborted'), { code: 'ECONNRESET' })));
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_WIRE_BYTES) req.destroy(new Error('A2A response exceeds the wire limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if ((response.statusCode ?? 500) >= 400) reject(new AuthenticatedRequestError(response.statusCode!, `Authenticated peer rejected request (${response.statusCode})${typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string' ? ': ' + parsed.message.slice(0, 500) : ''}`));
          else resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('A2A request timed out'), { code: 'ETIMEDOUT' })), options.timeoutMs ?? 5_000);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(payload);
  });
}

async function requireTrustedA2APeer(stateRoot: string, peer: NodePublicIdentity): Promise<void> {
  const trusted = await getTrustedPeer(stateRoot, peer.nodeId);
  if (!trusted || trusted.version !== peer.version || trusted.fingerprint !== peer.fingerprint
    || trusted.certificatePem !== peer.certificatePem) {
    throw new Error(`Peer ${peer.nodeId} does not exactly match the durable paired identity`);
  }
}

export async function discoverA2AAgent(stateRoot: string, baseAddress: string, peer: NodePublicIdentity): Promise<A2AAgentCard> {
  const response = await authenticatedRequest(stateRoot, `${baseAddress.replace(/\/$/, '')}/.well-known/agent-card.json`, peer, 'GET');
  return validateA2AAgentCard(response);
}

function parseOutboundTaskResponse(
  value: unknown,
  requestId: string,
  expected: { envelope: NetworkEnvelope; messageId: string },
): { task: A2ATask; receipt: TransportReceipt } {
  const response = object(value, 'A2A response');
  exactKeys(response, ['jsonrpc', 'id', 'result', 'error'], ['jsonrpc', 'id'], 'A2A response');
  if (response.jsonrpc !== '2.0' || response.id !== requestId) throw new Error('A2A response does not match the JSON-RPC request ID');
  if (response.error !== undefined && response.result !== undefined) throw new Error('A2A response cannot contain both result and error');
  if (response.error !== undefined) {
    const error = object(response.error, 'A2A response.error');
    exactKeys(error, ['code', 'message'], ['code', 'message'], 'A2A response.error');
    if (!Number.isInteger(error.code) || typeof error.message !== 'string') throw new Error('A2A response error is invalid');
    throw new Error(`A2A error ${error.code}: ${error.message}`);
  }
  if (response.result === undefined) throw new Error('A2A response is missing a result');
  const result = object(response.result, 'A2A response.result');
  exactKeys(result, ['task'], ['task'], 'A2A response.result');
  const task = object(result.task, 'A2A task');
  exactKeys(task, ['id', 'contextId', 'status', 'history', 'metadata'], ['id', 'contextId', 'status', 'history', 'metadata'], 'A2A task');
  const taskId = validateNetworkId(task.id, 'A2A task.id');
  if (task.contextId !== expected.envelope.collaborationId) throw new Error('A2A task does not match the selected conversation');
  const status = object(task.status, 'A2A task.status');
  exactKeys(status, ['state', 'timestamp'], ['state', 'timestamp'], 'A2A task.status');
  if (status.state !== 'TASK_STATE_SUBMITTED' || typeof status.timestamp !== 'string'
    || !Number.isFinite(Date.parse(status.timestamp)) || new Date(status.timestamp).toISOString() !== status.timestamp) {
    throw new Error('A2A task status is invalid');
  }
  if (!Array.isArray(task.history) || task.history.length !== 1) throw new Error('A2A task history does not match the submitted message');
  const message = parseMessage(task.history[0]);
  if (message.messageId !== expected.messageId || message.contextId !== expected.envelope.collaborationId
    || message.taskId !== undefined || message.parts.map((part) => part.text).join('') !== expected.envelope.body
    || message.metadata?.agentlinkSenderAgentId !== expected.envelope.sender.agentId
    || JSON.stringify(message.metadata.agentlinkEnvelope) !== JSON.stringify(expected.envelope)) {
    throw new Error('A2A task history does not match the submitted message scope');
  }
  const metadata = object(task.metadata, 'A2A task.metadata');
  exactKeys(metadata, ['transportStatus', 'agentlinkTransportReceipt'], ['transportStatus', 'agentlinkTransportReceipt'], 'A2A task.metadata');
  if (metadata.transportStatus !== 'transport-received') throw new Error('A2A task transport status is invalid');
  const receipt = parseReceipt(metadata.agentlinkTransportReceipt);
  if (receipt.eventId !== expected.envelope.eventId || receipt.payloadHash !== sha256(JSON.stringify(expected.envelope))) {
    throw new Error('A2A task receipt does not match the submitted event scope');
  }
  return {
    task: {
      id: taskId,
      contextId: expected.envelope.collaborationId,
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: status.timestamp },
      history: [message],
      metadata: { transportStatus: 'transport-received', agentlinkTransportReceipt: receipt },
    },
    receipt,
  };
}

export async function sendA2AMessage(
  stateRoot: string,
  baseAddress: string,
  peer: NodePublicIdentity,
  input: { senderAgentId: string; recipientAgentId: string; conversationId: string; body: string; messageId?: string },
): Promise<A2ATask> {
  await requireTrustedA2APeer(stateRoot, peer);
  const senderAgentId = validateNetworkId(input.senderAgentId, 'senderAgentId');
  const recipientAgentId = validateNetworkId(input.recipientAgentId, 'recipientAgentId');
  const conversationId = validateNetworkId(input.conversationId, 'conversationId');
  const messageId = validateNetworkId(input.messageId ?? `message-${randomUUID()}`, 'messageId');
  if (messageId.length > 124) throw new Error('messageId is too long for durable A2A event identity');
  const identity = await loadNodeIdentity(stateRoot);
  const eventId = `a2a-${messageId}`;
  const prior = (await readMailboxState(stateRoot)).outbox.find((entry) => entry.envelope.sender.nodeId === identity.nodeId
    && entry.envelope.eventId === eventId);
  const envelope: NetworkEnvelope = prior?.envelope ?? {
    version: NETWORK_SCHEMA_VERSION,
    eventId,
    sender: { nodeId: identity.nodeId, agentId: senderAgentId },
    recipient: { nodeId: peer.nodeId, agentId: recipientAgentId },
    collaborationId: conversationId,
    kind: 'message',
    body: input.body,
    createdAt: new Date().toISOString(),
  };
  if (envelope.sender.agentId !== senderAgentId || envelope.recipient.nodeId !== peer.nodeId
    || envelope.recipient.agentId !== recipientAgentId || envelope.collaborationId !== conversationId
    || envelope.body !== input.body) {
    throw new Error(`A2A messageId ${messageId} is already queued with different content or scope`);
  }
  await queueOutboundEvent(stateRoot, envelope);
  const requestId = randomUUID();
  const response = await authenticatedRequest(stateRoot, `${baseAddress.replace(/\/$/, '')}/a2a`, peer, 'POST', {
    jsonrpc: '2.0', id: requestId, method: 'SendMessage', params: {
      tenant: input.recipientAgentId,
      configuration: { returnImmediately: true },
      message: {
        messageId,
        contextId: conversationId,
        role: 'ROLE_USER',
        parts: [{ text: input.body, mediaType: 'text/plain' }],
        metadata: { agentlinkSenderAgentId: senderAgentId, agentlinkEnvelope: envelope },
      },
    },
  });
  const { task, receipt } = parseOutboundTaskResponse(response, requestId, { envelope, messageId });
  await recordOutboundReceipt(stateRoot, envelope.eventId, receipt);
  return task;
}

export async function resumePendingA2AMessages(
  stateRoot: string,
  baseAddress: string,
  peer: NodePublicIdentity,
): Promise<A2ATask[]> {
  await requireTrustedA2APeer(stateRoot, peer);
  const pending = (await readMailboxState(stateRoot)).outbox.filter((entry) => entry.status === 'queued'
    && entry.envelope.recipient.nodeId === peer.nodeId && entry.envelope.eventId.startsWith('a2a-'));
  const tasks: A2ATask[] = [];
  for (const entry of pending) {
    tasks.push(await sendA2AMessage(stateRoot, baseAddress, peer, {
      senderAgentId: entry.envelope.sender.agentId,
      recipientAgentId: entry.envelope.recipient.agentId,
      conversationId: entry.envelope.collaborationId,
      body: entry.envelope.body,
      messageId: entry.envelope.eventId.slice(4),
    }));
  }
  return tasks;
}

export function authenticatedPeerNodeId(socket: TLSSocket, peerNodeId: string): string {
  if (!socket.authorized || !socket.getPeerCertificate().raw) throw new Error('Peer certificate is not authorized');
  return peerNodeId;
}
