import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:https';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { connectAction, monitorConnection, readConnection } from './connect.js';
import { loadNodeIdentity } from './identity.js';
import { updatePeerAddress } from './config.js';

test('acceptor wait retries a real slow authenticated check; deadlines, abort, trust errors and send semantics remain distinct', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-wait-retry-'));
  const previousHome = process.env.AGENTLINK_CONNECTION_HOME, previousActor = process.env.AGENTLINK_PARTICIPANT_ID;
  process.env.AGENTLINK_CONNECTION_HOME = join(root, 'private'); delete process.env.AGENTLINK_PARTICIPANT_ID;
  const repos = [join(root, 'authority'), join(root, 'acceptor')];
  await Promise.all(repos.map(repo => mkdir(repo)));
  let id: string | undefined;
  const act = (repo: string, action: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => connectAction(repo, { action, connection: id, ...args }, signal);
  t.after(async () => {
    if (id) for (const repo of repos) await act(repo, 'stop').catch(() => {});
    await pause(500);
    if (previousHome === undefined) delete process.env.AGENTLINK_CONNECTION_HOME; else process.env.AGENTLINK_CONNECTION_HOME = previousHome;
    if (previousActor === undefined) delete process.env.AGENTLINK_PARTICIPANT_ID; else process.env.AGENTLINK_PARTICIPANT_ID = previousActor;
    await rm(root, { recursive: true, force: true });
  });
  const invite = await connectAction(repos[0]!, { action: 'invite', to: 'acceptor', ip: '127.0.0.1' }); id = invite.id as string;
  await connectAction(repos[1]!, { action: 'accept', code: invite.code });
  const authority = await readConnection(repos[0]!, id), acceptor = await readConnection(repos[1]!, id);
  const [serverIdentity, clientIdentity] = await Promise.all([loadNodeIdentity(authority.root), loadNodeIdentity(acceptor.root)]);
  let mode: 'slow-once' | 'forward' | 'hang' | 'denied' | 'invalid' | 'unavailable' = 'slow-once';
  let requests = 0;
  const proxy = createServer({ cert: serverIdentity.certificatePem, key: serverIdentity.privateKeyPem, ca: clientIdentity.certificatePem, requestCert: true, rejectUnauthorized: true }, (incoming, outgoing) => {
    requests++;
    if (mode === 'hang' || mode === 'slow-once' && requests === 1) return;
    if (mode === 'denied' || mode === 'unavailable') { outgoing.writeHead(mode === 'denied' ? 403 : 503); outgoing.end('{}'); return; }
    if (mode === 'invalid') { outgoing.end('invalid JSON'); return; }
    const upstream = request(authority.address! + incoming.url, { method: incoming.method, headers: incoming.headers, cert: clientIdentity.certificatePem, key: clientIdentity.privateKeyPem, ca: serverIdentity.certificatePem, checkServerIdentity: () => undefined }, response => {
      outgoing.writeHead(response.statusCode ?? 500, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', error => outgoing.destroy(error)); incoming.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const port = (proxy.address() as { port: number }).port;
  await updatePeerAddress(acceptor.root, { name: 'peer', address: `https://127.0.0.1:${port}` });
  const initial = await act(repos[0]!, 'receive');
  const cursor = (initial.snapshot as { audit: Array<{ sequence: number }> }).audit.at(-1)?.sequence ?? 0;
  await act(repos[0]!, 'send', { body: 'A real response after a slow check', requestId: 'wait-regression' });
  const waited = await act(repos[1]!, 'wait', { after: cursor, timeoutSeconds: 12 });
  assert.equal(waited.changed, true); assert.equal(waited.transientFailures, 1); assert.equal(waited.connectionCheck, 'ok'); assert(requests >= 2);
  const latest = (waited.snapshot as { audit: Array<{ sequence: number }> }).audit.at(-1)!.sequence;
  mode = 'denied'; requests = 0;
  await assert.rejects(act(repos[1]!, 'wait', { after: latest, timeoutSeconds: 12 }), /403/); assert.equal(requests, 1);
  mode = 'invalid'; requests = 0;
  await assert.rejects(act(repos[1]!, 'wait', { after: latest, timeoutSeconds: 12 }), /JSON/); assert.equal(requests, 1);
  mode = 'unavailable'; requests = 0;
  await assert.rejects(act(repos[1]!, 'send', { body: 'do not auto-retry writes', requestId: 'send-not-retried' }), /503/); assert.equal(requests, 1);
  mode = 'hang'; requests = 0;
  const bounded = await act(repos[1]!, 'wait', { after: latest, timeoutSeconds: 1 });
  assert.equal(bounded.changed, false); assert.equal(bounded.connectionCheck, 'unavailable'); assert(!bounded.snapshot); assert.equal(requests, 1);
  const controller = new AbortController();
  const cancelled = act(repos[1]!, 'wait', { after: latest, timeoutSeconds: 25 }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(cancelled, /abort/i);
  mode = 'forward';
  await act(repos[1]!, 'send', { body: 'own messages must not wake the same agent', requestId: 'own-monitor-message' });
  const events: Record<string, unknown>[] = [], watcher = new AbortController();
  const watched = monitorConnection(repos[1]!, id, event => { events.push(event); if (event.status === 'incoming') watcher.abort(); }, latest, watcher.signal);
  await act(repos[0]!, 'send', { body: 'Native monitor should see only an event reference', requestId: 'native-monitor-probe' });
  await watched;
  assert(events.some(e => e.status === 'watching'));
  assert(events.some(e => e.status === 'incoming'));
  assert(!JSON.stringify(events).includes('Native monitor should see'));
  assert.equal((events.find(e => e.status === 'incoming')!.sequences as number[]).length, 1);
  const stopEvents: Record<string, unknown>[] = [];
  await monitorConnection(repos[1]!, id, event => { stopEvents.push(event); if (event.status === 'watching') void act(repos[1]!, 'stop'); }, events.find(e => e.status === 'incoming')!.after as number);
  assert(stopEvents.some(e => e.status === 'stopped'));
});
