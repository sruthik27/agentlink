import { request, type Agent } from 'node:https';
import type { PeerCertificate } from 'node:tls';
import { loadNodeIdentity } from './identity.js';
import { queueOutboundEvent, readMailboxState, recordOutboundReceipt } from './mailbox.js';
import { certificateDerFingerprint, getTrustedPeer } from './trust.js';
import {
  MAX_WIRE_BYTES,
  type NetworkEnvelope,
  type NodePublicIdentity,
  type TransportReceipt,
  parseEnvelope,
  parseNodePublicIdentity,
  parseReceipt,
} from './types.js';

export class NetworkResponseError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(`Network peer rejected the request (${statusCode} ${code})`);
  }
}

export interface SendNetworkEnvelopeOptions {
  stateRoot: string;
  endpoint: string;
  peer: NodePublicIdentity;
  envelope: NetworkEnvelope;
  timeoutMs?: number;
  agent?: Agent;
}

function pinnedServerCheck(peer: NodePublicIdentity): (_host: string, certificate: PeerCertificate) => Error | undefined {
  return (_host, certificate) => {
    if (!certificate.raw) return new Error('Remote TLS certificate is missing');
    const actual = certificateDerFingerprint(certificate.raw);
    return actual === peer.fingerprint ? undefined : new Error('Remote TLS certificate does not match the pinned peer identity');
  };
}

async function requireTrustedPeer(stateRoot: string, input: NodePublicIdentity): Promise<NodePublicIdentity> {
  const supplied = parseNodePublicIdentity(input);
  const trusted = await getTrustedPeer(stateRoot, supplied.nodeId);
  if (!trusted) throw new Error(`Peer ${supplied.nodeId} is not trusted by this node`);
  if (trusted.version !== supplied.version || trusted.fingerprint !== supplied.fingerprint
    || trusted.certificatePem !== supplied.certificatePem) {
    throw new Error(`Peer ${supplied.nodeId} does not exactly match the trusted peer identity`);
  }
  return trusted;
}

export async function sendNetworkEnvelope(options: SendNetworkEnvelopeOptions): Promise<TransportReceipt> {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:') throw new Error('Network endpoint must use HTTPS');
  const peer = await requireTrustedPeer(options.stateRoot, options.peer);
  const envelope = parseEnvelope(options.envelope);
  if (envelope.recipient.nodeId !== peer.nodeId) throw new Error('Envelope recipient does not match the pinned remote peer');
  const queued = await queueOutboundEvent(options.stateRoot, envelope);
  if (Buffer.byteLength(queued.payload) > MAX_WIRE_BYTES) throw new Error('Serialized envelope exceeds the wire limit');
  const identity = await loadNodeIdentity(options.stateRoot);
  await requireTrustedPeer(options.stateRoot, peer);

  const receipt = await new Promise<TransportReceipt>((resolve, reject) => {
    const requestOptions = {
      method: 'POST',
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      ca: peer.certificatePem,
      checkServerIdentity: pinnedServerCheck(peer),
      agent: options.agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(queued.payload) },
    };
    const req = request(endpoint, requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Network response was aborted')));
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_WIRE_BYTES) {
          const error = new Error('Network response exceeds the wire limit');
          reject(error);
          response.destroy(error);
          req.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (size > MAX_WIRE_BYTES) {
          reject(new Error('Network response exceeds the wire limit'));
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          reject(new Error('Network peer returned invalid JSON'));
          return;
        }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          const code = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
            ? value.error : 'request_failed';
          reject(new NetworkResponseError(response.statusCode ?? 500, code));
          return;
        }
        try {
          resolve(parseReceipt(value));
        } catch (error) {
          reject(error);
        }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Network request timed out')), options.timeoutMs ?? 5_000);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(queued.payload);
  });
  await recordOutboundReceipt(options.stateRoot, envelope.eventId, receipt);
  return receipt;
}

export interface ResumePendingNetworkEnvelopesOptions {
  stateRoot: string;
  endpoint: string;
  peer: NodePublicIdentity;
  timeoutMs?: number;
  agent?: Agent;
}

export async function resumePendingNetworkEnvelopes(
  options: ResumePendingNetworkEnvelopesOptions,
): Promise<TransportReceipt[]> {
  const peer = await requireTrustedPeer(options.stateRoot, options.peer);
  const state = await readMailboxState(options.stateRoot);
  const pending = state.outbox.filter((entry) => entry.status === 'queued'
    && entry.envelope.recipient.nodeId === peer.nodeId);
  const receipts: TransportReceipt[] = [];
  for (const entry of pending) {
    receipts.push(await sendNetworkEnvelope({ ...options, envelope: entry.envelope }));
  }
  return receipts;
}
