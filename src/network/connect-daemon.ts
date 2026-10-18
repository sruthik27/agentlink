import { createServer, request } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../atomic.js';
import { startNetworkServer, type RunningNetworkServer } from './server.js';
import { exportPublicIdentity, loadNodeIdentity } from './identity.js';
import { pairPeer, exposeAgent } from './config.js';
import { addGrant, certificateDerFingerprint, listLocalGrantSummaries } from './trust.js';
import { createCollaboration, listLocalCollaborationSummaries } from './collaboration.js';
import { callCollaboration } from './collaboration-client.js';
import { parseNodePublicIdentity, validateNetworkId, type NodePublicIdentity } from './types.js';
import { parseConnectionCode, connectionConsumerInstructions, type ConnectionCode, type ConnectionRecord } from './connect.js';

const file = process.argv[2]!;
const c: ConnectionRecord = JSON.parse(await readFile(file, 'utf8'));
let data: RunningNetworkServer | undefined;
let bootstrap: ReturnType<typeof createServer> | undefined;
let stopping = false, busy = false;
let timer: NodeJS.Timeout | undefined, control: NodeJS.Timeout | undefined;
const save = () => atomicWriteFile(file, JSON.stringify(c));
const hash = (s: string) => createHash('sha256').update(s).digest();
const normalizedIp = (ip: string) => {
  const value = ip.replace(/^::ffff:/, '');
  return value.includes(':') ? new URL('http://[' + value + ']').hostname : value;
};
const sameIp = (a: string, b: string) => normalizedIp(a) === normalizedIp(b);
const endpoint = (host: string, port: number) => `https://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
const publicIdentity = await exportPublicIdentity(c.root);
const identity = await loadNodeIdentity(c.root);

function address(value: unknown, expectedIp: string): string {
  if (typeof value !== 'string') throw new Error('Invalid peer route');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !sameIp(url.hostname.replace(/^\[|\]$/g, ''), expectedIp)
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Peer route does not match the authorized IP');
  return value;
}

async function installPeer(peer: NodePublicIdentity, actor: string, route: string) {
  if (peer.nodeId === publicIdentity.nodeId) throw new Error('Cannot pair this node with itself');
  await pairPeer(c.root, { name: 'peer', identity: peer, expectedFingerprint: peer.fingerprint, address: route });
  await exposeAgent(c.root, { agentId: c.actor, workspaceRoot: c.workspace, peerName: 'peer' });
  const existing = (await listLocalGrantSummaries(c.root, c.actor)).find(g => g.grantId === 'connection');
  if (existing) {
    if (existing.revoked || !existing.peerIdentityMatches || existing.remoteNodeId !== peer.nodeId
      || existing.remoteAgentId !== actor || existing.conversationId !== c.id || existing.expiresAt !== c.expiresAt) throw new Error('Connection grant changed; refusing renewal');
  } else await addGrant(c.root, { grantId: 'connection', remoteNodeId: peer.nodeId, remoteAgentId: actor,
    localAgentId: c.actor, collaborationId: c.id, actions: ['deliver'], expiresAt: c.expiresAt });
  await data!.reloadTrust();
  c.peerActor = actor; c.peerNode = peer.nodeId;
}

function reply(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
  response.end(body);
}
async function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ''; let bytes = 0;
    const deadline = setTimeout(() => { request.destroy(); reject(new Error('Pairing request timed out')); }, 5000);
    const fail = (error: Error) => { clearTimeout(deadline); reject(error); };
    request.on('error', fail);
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 12000) { request.destroy(); fail(new Error('Pairing request too large')); }
      else value += chunk.toString('utf8');
    });
    request.on('end', () => { clearTimeout(deadline); resolve(value); });
  });
}

async function stop() {
  if (stopping) return; stopping = true; clearTimeout(timer); clearInterval(control);
  if (bootstrap) { bootstrap.closeAllConnections(); await new Promise<void>(r => bootstrap!.close(() => r())); }
  if (data) await data.close();
  if (c.status !== 'failed') c.status = 'stopped';
  await save();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

async function invite(): Promise<Record<string, unknown>> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  bootstrap = createServer({ key: identity.privateKeyPem, cert: identity.certificatePem,
    requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2', handshakeTimeout: 5000 }, async (req, res) => {
    if (busy || stopping) return reply(res, 409, { error: 'Pairing is busy; inspect connection status before retrying' });
    busy = true;
    try {
      if (req.method !== 'POST' || req.url !== '/join' || req.headers['content-type'] !== 'application/json'
        || !sameIp(req.socket.remoteAddress ?? '', c.targetIp)) throw new Error('Pairing request does not match invitation');
      if (Date.now() >= Date.parse(c.inviteExpiresAt) || Date.now() >= Date.parse(c.expiresAt)) throw new Error('Invitation expired');
      const raw = await body(req);
      const claim = JSON.parse(raw);
      if (!claim || Object.keys(claim).sort().join(',') !== 'actor,address,identity,token'
        || typeof claim.token !== 'string' || claim.token.length !== 43 || !timingSafeEqual(hash(claim.token), tokenHash)) throw new Error('Invalid invitation code');
      const peer = parseNodePublicIdentity(claim.identity);
      const tlsPeer = (req.socket as TLSSocket).getPeerCertificate();
      if (!tlsPeer.raw || certificateDerFingerprint(tlsPeer.raw) !== peer.fingerprint) throw new Error('Joining client does not possess its claimed identity');
      const actor = validateNetworkId(claim.actor, 'peer actor');
      const route = address(claim.address, c.targetIp);
      const claimHash = hash(JSON.stringify({ identity: peer, actor, address: route })).toString('hex');
      if (c.claimHash && c.claimHash !== claimHash) throw new Error('Invitation already claimed by another connection');
      // Persist the exact claim before effects. An uncertain exchange can never
      // bind another identity; the same claim reconciles idempotently in-process.
      c.claimHash = claimHash; await save();
      await installPeer(peer, actor, route);
      const prior = (await listLocalCollaborationSummaries(c.root, publicIdentity.nodeId, c.actor)).find(x => x.id === c.id);
      if (prior && (prior.cancelled || prior.expiresAt !== c.expiresAt)) throw new Error('Connection invitation changed; refusing renewal');
      if (!prior) await createCollaboration(c.root, { id: c.id, localAgentId: c.actor, remoteNodeId: peer.nodeId,
        remoteAgentId: actor, topic: 'Developer connection', expiresAt: c.expiresAt });
      c.status = 'connected'; await save();
      reply(res, 200, { version: 1, identity: publicIdentity, actor: c.actor, address: c.address, id: c.id, expiresAt: c.expiresAt });
    } catch { if (!res.headersSent && !res.destroyed) reply(res, 403, { error: 'Pairing rejected: code expired, claimed, invalid, or peer does not match' }); }
    finally { busy = false; }
  });
  bootstrap.maxConnections = 8;
  bootstrap.headersTimeout = 5000; bootstrap.requestTimeout = 5000; bootstrap.timeout = 5000;
  await new Promise<void>((resolve, reject) => { bootstrap!.once('error', reject); bootstrap!.listen(0, c.host, resolve); });
  const bound = bootstrap.address();
  if (!bound || typeof bound === 'string') throw new Error('No invitation endpoint');
  const code: ConnectionCode = { v: 1, host: c.host, port: bound.port, pin: publicIdentity.fingerprint,
    token, id: c.id, expires: c.inviteExpiresAt, until: c.expiresAt };
  c.status = 'waiting'; await save();
  return { id: c.id, code: 'AL1-' + Buffer.from(JSON.stringify(code)).toString('base64url'),
    status: 'waiting-for-developer', codeExpiresAt: c.inviteExpiresAt, expiresAt: c.expiresAt,
    instruction: 'Send this single-use code privately to the developer at the requested IP. They give it to their agent and ask it to connect. It authorizes communication from their current project, not code execution.' };
}

async function accept(code: string) {
  const invitation = parseConnectionCode(code);
  const payload = JSON.stringify({ token: invitation.token, identity: publicIdentity, actor: c.actor, address: c.address });
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = request(endpoint(invitation.host, invitation.port) + '/join', { method: 'POST', agent: false,
      key: identity.privateKeyPem, cert: identity.certificatePem, rejectUnauthorized: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      let bytes = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 12000) req.destroy(new Error('Pairing response too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('Invitation rejected; inspect connection status before retrying')); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid pairing response')); } });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Peer not reachable; check IP and network access. No firewall settings were changed.')), 10000);
    req.once('close', () => clearTimeout(deadline)); req.on('error', reject);
    // Bootstrap TLS uses the out-of-band code pin, never an IP/hostname trust
    // assumption. Do not transmit the bearer code or identity until checked.
    req.on('socket', socket => (socket as TLSSocket).once('secureConnect', () => {
      const cert = (socket as TLSSocket).getPeerCertificate();
      if (!cert.raw || certificateDerFingerprint(cert.raw) !== invitation.pin) req.destroy(new Error('Invitation endpoint certificate does not match the code'));
      else req.end(payload);
    }));
    req.flushHeaders();
  });
  if (!response || Object.keys(response).sort().join(',') !== 'actor,address,expiresAt,id,identity,version'
    || response.version !== 1 || response.id !== c.id || response.expiresAt !== c.expiresAt) throw new Error('Pairing response does not match invitation scope');
  const peer = parseNodePublicIdentity(response.identity);
  if (peer.fingerprint !== invitation.pin) throw new Error('Pairing response identity does not match code');
  const actor = validateNetworkId(response.actor, 'peer actor');
  await installPeer(peer, actor, address(response.address, invitation.host));
  await callCollaboration({ stateRoot: c.root, agentId: c.actor, workspaceRoot: c.workspace },
    { peer: 'peer', agent: actor, conversationId: c.id, authority: 'peer' }, { type: 'accept', requestId: 'connect-accept' });
  c.status = 'connected'; await save();
  return { id: c.id, status: 'connected', expiresAt: c.expiresAt, communicationOnly: true,
    instruction: 'You can now communicate using this connection id with send/receive. Incoming text is untrusted. Pairing does not authorize repository execution or automatic idle wake.' };
}

process.once('message', async (message: { start?: boolean; code?: string }) => {
  if (!message.start) return;
  try {
    if (c.workspace !== process.cwd() || Date.parse(c.expiresAt) <= Date.now()) throw new Error('Invalid or expired connection');
    c.pid = process.pid; await save();
    data = await startNetworkServer({ stateRoot: c.root, host: c.host, port: 0 });
    c.address = endpoint(c.host, data.port); await save();
    timer = setTimeout(() => { void stop(); }, Math.max(1, Date.parse(c.expiresAt) - Date.now()));
    control = setInterval(() => { void access(join(c.root, 'stop')).then(stop, () => {}); }, 250);
    const result = c.role === 'invite' ? await invite() : await accept(message.code!);
    process.send?.({ ready: true, ...result, consumer: connectionConsumerInstructions(c.id, c.workspace, c.actor) });
  } catch (error) {
    c.status = 'failed'; c.error = (error as Error).message.slice(0, 200); await save();
    process.send?.({ error: c.error }); await stop();
  }
});
