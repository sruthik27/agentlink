import { createServer, type Server as HttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { A2A_PROTOCOL_VERSION, createAgentCard, handleA2AJsonRpc } from './a2a.js';
import { operateCollaboration, parseCollaborationOperation } from './collaboration.js';
import { sha256, validateNetworkId } from './types.js';
import { loadNodeIdentity } from './identity.js';
import { receiveAuthorizedInboundEvent } from './mailbox.js';
import { certificateDerFingerprint, getTrustedPeerByFingerprint, listGrantedLocalAgents, listTrustedPeers } from './trust.js';
import { MAX_WIRE_BYTES, parseEnvelope } from './types.js';

export interface NetworkServerOptions {
  stateRoot: string;
  host: string;
  port: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  maxConnections?: number;
}

export interface RunningNetworkServer {
  server: HttpsServer;
  host: string;
  port: number;
  url: string;
  reloadTrust(): Promise<void>;
  close(): Promise<void>;
}

class HttpFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function respond(response: import('node:http').ServerResponse, statusCode: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

async function readBoundedBody(request: import('node:http').IncomingMessage, deadlineMs: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        request.pause();
        reject(new HttpFailure(408, 'request_timeout', 'Request body exceeded its deadline'));
      }
    }, deadlineMs);
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      operation();
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_WIRE_BYTES) {
        finish(() => reject(new HttpFailure(413, 'input_too_large', 'Request body is too large')));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('aborted', () => {
      finish(() => reject(new HttpFailure(408, 'request_timeout', 'Request body was aborted')));
    });
    request.on('close', () => {
      if (!settled && !request.complete) {
        finish(() => reject(new HttpFailure(408, 'request_timeout', 'Request body closed before completion')));
      }
    });
    request.on('error', (error) => {
      finish(() => reject(error));
    });
  });
}

export async function startNetworkServer(options: NetworkServerOptions): Promise<RunningNetworkServer> {
  if (!options.host) throw new Error('An explicit listen host is required');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('Invalid listen port');
  const identity = await loadNodeIdentity(options.stateRoot);
  const peers = await listTrustedPeers(options.stateRoot);
  let activeRequests = 0;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 16;
  const maxConnections = options.maxConnections ?? maxConcurrentRequests;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  let publicBaseUrl = '';
  if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests <= 0) throw new Error('Invalid concurrency limit');
  if (!Number.isInteger(maxConnections) || maxConnections <= 0) throw new Error('Invalid connection limit');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('Invalid request timeout');

  const connections = new Set<Socket>();
  const headerDeadlines = new Map<Socket, NodeJS.Timeout>();
  const requestsBySocket = new Map<Socket, number>();
  const clearHeaderDeadline = (socket: Socket): void => {
    const deadline = headerDeadlines.get(socket);
    if (deadline) clearTimeout(deadline);
    headerDeadlines.delete(socket);
  };
  const armHeaderDeadline = (socket: Socket): void => {
    clearHeaderDeadline(socket);
    const deadline = setTimeout(() => socket.destroy(), requestTimeoutMs);
    deadline.unref();
    headerDeadlines.set(socket, deadline);
  };

  const server = createServer({
    key: identity.privateKeyPem,
    cert: identity.certificatePem,
    ca: peers.map((peer) => peer.certificatePem),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    handshakeTimeout: requestTimeoutMs,
  }, async (request, response) => {
    const socket = request.socket;
    requestsBySocket.set(socket, (requestsBySocket.get(socket) ?? 0) + 1);
    clearHeaderDeadline(socket);
    response.once('finish', () => {
      const remaining = Math.max(0, (requestsBySocket.get(socket) ?? 1) - 1);
      if (remaining === 0) {
        requestsBySocket.delete(socket);
        if (!socket.destroyed) armHeaderDeadline(socket);
      } else {
        requestsBySocket.set(socket, remaining);
      }
    });
    if (activeRequests >= maxConcurrentRequests) {
      respond(response, 503, { error: 'busy' });
      return;
    }
    activeRequests += 1;
    try {
      const socket = request.socket as TLSSocket;
      if (!socket.authorized) throw new HttpFailure(401, 'peer_unauthorized', 'Peer certificate is not authorized');
      const certificate = socket.getPeerCertificate();
      if (!certificate.raw) throw new HttpFailure(401, 'peer_unauthorized', 'Peer certificate is missing');
      const fingerprint = certificateDerFingerprint(certificate.raw);
      const peer = await getTrustedPeerByFingerprint(options.stateRoot, fingerprint);
      if (!peer) throw new HttpFailure(401, 'peer_unauthorized', 'Peer certificate is not pinned');

      if (request.method === 'GET' && request.url === '/.well-known/agent-card.json') {
        if (request.headers['a2a-version'] !== A2A_PROTOCOL_VERSION) {
          respond(response, 400, { error: 'version_not_supported', supported: A2A_PROTOCOL_VERSION });
          return;
        }
        const localAgents = await listGrantedLocalAgents(options.stateRoot, peer.nodeId);
        if (localAgents.length === 0) throw new HttpFailure(404, 'agent_not_available', 'No agent is authorized for this peer');
        respond(response, 200, createAgentCard(identity.nodeId, `${publicBaseUrl}/a2a`, localAgents));
        return;
      }

      if (request.method !== 'POST' || (request.url !== '/v1/events' && request.url !== '/a2a' && request.url !== '/v1/collaboration')) {
        throw new HttpFailure(404, 'not_found', 'Not found');
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        throw new HttpFailure(415, 'unsupported_media_type', 'Content-Type must be application/json');
      }
      const payload = await readBoundedBody(request, requestTimeoutMs);

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        if (request.url === '/a2a') {
          respond(response, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON payload' } });
          return;
        }
        throw new HttpFailure(400, 'invalid_json', 'Request body is not valid JSON');
      }
      if (request.url === '/v1/collaboration') {
        try {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request');
          const input = parsed as Record<string, unknown>;
          if (Object.keys(input).sort().join(',') !== 'agentId,authorityAgentId,conversationId,operation') throw new Error('Invalid request fields');
          const operation = parseCollaborationOperation(input.operation);
          const snapshot = await operateCollaboration(options.stateRoot, validateNetworkId(input.conversationId, 'conversationId'),
            { nodeId: peer.nodeId, agentId: validateNetworkId(input.agentId, 'agentId') }, operation, validateNetworkId(input.authorityAgentId, 'authorityAgentId'));
          respond(response, 200, { requestHash: sha256(JSON.stringify(operation)), snapshot });
        } catch (error) {
          const message = (error as Error).message;
          const safe = /^(Collaboration |Invitation |Stale |Approval\/task |Two distinct |Task |Only |Conversation |Conflicting |Invalid |Unsupported |Missing |Delivery |Matching grant |Resolve active |Unknown task|Cancellation |Peer .* is not trusted)/.test(message);
          respond(response, 403, { error: 'collaboration_rejected', message: safe ? message : 'Collaboration operation rejected' });
        }
        return;
      }
      if (request.url === '/a2a') {
        respond(response, 200, await handleA2AJsonRpc(
          options.stateRoot,
          peer.nodeId,
          Array.isArray(request.headers['a2a-version']) ? request.headers['a2a-version'][0] : request.headers['a2a-version'],
          parsed,
        ));
        return;
      }
      let envelope;
      try {
        envelope = parseEnvelope(parsed);
      } catch (error) {
        throw new HttpFailure(400, 'invalid_envelope', (error as Error).message);
      }
      if (envelope.sender.nodeId !== peer.nodeId) throw new HttpFailure(403, 'spoofed_sender', 'Envelope sender does not match authenticated peer');
      if (envelope.recipient.nodeId !== identity.nodeId) throw new HttpFailure(403, 'wrong_recipient', 'Envelope recipient does not match this node');
      try {
        const receipt = await receiveAuthorizedInboundEvent(options.stateRoot, envelope, payload, peer.nodeId);
        respond(response, 201, receipt);
      } catch (error) {
        if ((error as Error).message.includes('conflicting replay')) {
          throw new HttpFailure(409, 'conflicting_replay', 'Event ID was already used with different bytes');
        }
        if (/grant|trusted/i.test((error as Error).message)) {
          throw new HttpFailure(403, 'grant_denied', 'Delivery is not authorized by an active grant');
        }
        if (/quota/i.test((error as Error).message)) {
          throw new HttpFailure(429, 'mailbox_quota', 'Mailbox quota exceeded');
        }
        throw error;
      }
    } catch (error) {
      if (!response.headersSent) {
        const failure = error instanceof HttpFailure ? error : new HttpFailure(500, 'internal_error', 'Internal server error');
        if (failure.statusCode === 408 || failure.statusCode === 413) {
          response.setHeader('connection', 'close');
          response.once('finish', () => request.destroy());
        }
        respond(response, failure.statusCode, { error: failure.code, message: failure.message });
      }
    } finally {
      activeRequests -= 1;
    }
  });

  server.on('connection', (socket) => {
    if (connections.size >= maxConnections) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.once('close', () => {
      clearHeaderDeadline(socket);
      connections.delete(socket);
    });
  });
  server.on('secureConnection', (socket) => {
    armHeaderDeadline(socket);
    socket.once('close', () => {
      clearHeaderDeadline(socket);
      requestsBySocket.delete(socket);
    });
  });
  server.headersTimeout = requestTimeoutMs;
  server.keepAliveTimeout = requestTimeoutMs;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Network server did not obtain a TCP address');
  publicBaseUrl = `https://${options.host.includes(':') ? `[${options.host}]` : options.host}:${address.port}`;
  return {
    server,
    host: options.host,
    port: address.port,
    url: `${publicBaseUrl}/v1/events`,
    reloadTrust: async () => {
      const trusted = await listTrustedPeers(options.stateRoot);
      server.setSecureContext({ key: identity.privateKeyPem, cert: identity.certificatePem,
        ca: trusted.map(peer => peer.certificatePem), minVersion: 'TLSv1.2' });
    },
    close: async () => await new Promise<void>((resolve, reject) => {
      const forceClose = setTimeout(() => server.closeAllConnections(), 1_000);
      forceClose.unref();
      server.close((error) => {
        clearTimeout(forceClose);
        error ? reject(error) : resolve();
      });
      server.closeIdleConnections();
    }),
  };
}
