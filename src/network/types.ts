import { createHash } from 'node:crypto';

export const NETWORK_SCHEMA_VERSION = 1 as const;
export const MAX_ENVELOPE_BODY_BYTES = 64 * 1024;
export const MAX_WIRE_BYTES = 72 * 1024;
export const MAX_CERTIFICATE_PEM_BYTES = 32 * 1024;
export const NETWORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface NodePublicIdentity {
  version: 1;
  nodeId: string;
  fingerprint: string;
  certificatePem: string;
}

export interface NodeIdentity extends NodePublicIdentity {
  privateKeyPem: string;
}

export interface NetworkActor {
  nodeId: string;
  agentId: string;
}

export interface NetworkEnvelope {
  version: 1;
  eventId: string;
  sender: NetworkActor;
  recipient: NetworkActor;
  collaborationId: string;
  kind: 'message';
  body: string;
  createdAt: string;
}

export interface TransportReceipt {
  version: 1;
  receiptId: string;
  eventId: string;
  status: 'transport-received';
  payloadHash: string;
  receivedAt: string;
}

export interface ScopedGrant {
  version: 1;
  grantId: string;
  remoteNodeId: string;
  remoteFingerprint: string;
  remoteAgentId: string;
  localAgentId: string;
  collaborationId: string;
  actions: ['deliver'];
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown field: ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new Error(`${label} is missing field: ${key}`);
  }
}

export function validateNetworkId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !NETWORK_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function parseActor(value: unknown, label: string): NetworkActor {
  const input = record(value, label);
  exactKeys(input, ['nodeId', 'agentId'], label);
  return { nodeId: validateNetworkId(input.nodeId, `${label}.nodeId`), agentId: validateNetworkId(input.agentId, `${label}.agentId`) };
}

export function parseNodePublicIdentity(value: unknown): NodePublicIdentity {
  const input = record(value, 'peer identity');
  exactKeys(input, ['version', 'nodeId', 'fingerprint', 'certificatePem'], 'peer identity');
  if (input.version !== NETWORK_SCHEMA_VERSION) throw new Error('Unsupported peer identity version');
  if (typeof input.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.fingerprint)) {
    throw new Error('Invalid peer identity fingerprint');
  }
  if (typeof input.certificatePem !== 'string'
    || Buffer.byteLength(input.certificatePem, 'utf8') > MAX_CERTIFICATE_PEM_BYTES
    || !input.certificatePem.includes('BEGIN CERTIFICATE')) {
    throw new Error('Invalid or oversized peer identity certificate');
  }
  return {
    version: NETWORK_SCHEMA_VERSION,
    nodeId: validateNetworkId(input.nodeId, 'peer identity.nodeId'),
    fingerprint: input.fingerprint,
    certificatePem: input.certificatePem,
  };
}

export function parseEnvelope(value: unknown): NetworkEnvelope {
  const input = record(value, 'envelope');
  exactKeys(input, ['version', 'eventId', 'sender', 'recipient', 'collaborationId', 'kind', 'body', 'createdAt'], 'envelope');
  if (input.version !== NETWORK_SCHEMA_VERSION) throw new Error('Unsupported envelope version');
  if (input.kind !== 'message') throw new Error('Unsupported envelope kind');
  if (typeof input.body !== 'string') throw new Error('envelope.body must be a string');
  if (Buffer.byteLength(input.body, 'utf8') > MAX_ENVELOPE_BODY_BYTES) throw new Error(`envelope.body exceeds ${MAX_ENVELOPE_BODY_BYTES} bytes`);
  return {
    version: NETWORK_SCHEMA_VERSION,
    eventId: validateNetworkId(input.eventId, 'envelope.eventId'),
    sender: parseActor(input.sender, 'envelope.sender'),
    recipient: parseActor(input.recipient, 'envelope.recipient'),
    collaborationId: validateNetworkId(input.collaborationId, 'envelope.collaborationId'),
    kind: 'message',
    body: input.body,
    createdAt: isoDate(input.createdAt, 'envelope.createdAt'),
  };
}

export function parseReceipt(value: unknown): TransportReceipt {
  const input = record(value, 'receipt');
  exactKeys(input, ['version', 'receiptId', 'eventId', 'status', 'payloadHash', 'receivedAt'], 'receipt');
  if (input.version !== NETWORK_SCHEMA_VERSION) throw new Error('Unsupported receipt version');
  if (input.status !== 'transport-received') throw new Error('Invalid transport receipt status');
  if (typeof input.payloadHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.payloadHash)) throw new Error('Invalid receipt payloadHash');
  return {
    version: NETWORK_SCHEMA_VERSION,
    receiptId: validateNetworkId(input.receiptId, 'receipt.receiptId'),
    eventId: validateNetworkId(input.eventId, 'receipt.eventId'),
    status: 'transport-received',
    payloadHash: input.payloadHash,
    receivedAt: isoDate(input.receivedAt, 'receipt.receivedAt'),
  };
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
