import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { initializeNodeIdentity, exportPublicIdentity } from '../dist/network/identity.js';
import { pairPeer, exposeAgent, updatePeerAddress } from '../dist/network/config.js';
import { addGrant } from '../dist/network/trust.js';
import { initializeWorkspaceIdentity, registerParticipant } from '../dist/workspace.js';
import { createCollaboration } from '../dist/network/collaboration.js';
export const run = promisify(execFile);
export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const cli = join(packageRoot, 'dist/cli.js');
export const mcp = join(packageRoot, 'dist/mcp/server.js');

export async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
export async function startServer(root, cwd, port = 0) {
  const child = spawn(process.execPath, [cli, 'network', 'serve', '--state-root', root, '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-2000); });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Node startup timed out')), 15000);
      const lines = createInterface({ input: child.stdout });
      const finish = (fn, value) => { clearTimeout(timer); lines.close(); fn(value); };
      child.once('error', (e) => finish(reject, e));
      child.once('exit', () => finish(reject, new Error(`Node exited before ready: ${stderr}`)));
      lines.once('line', (line) => { try { finish(resolve, JSON.parse(line)); } catch (e) { finish(reject, e); } });
    });
    return { child, ...ready };
  } catch (e) { await stop(child); throw e; }
}
export class McpClient {
  constructor(cwd, stateRoot) {
    this.next = 1; this.pending = new Map();
    this.child = spawn(process.execPath, [mcp], { cwd, env: { ...process.env, AGENTLINK_NETWORK_STATE_ROOT: stateRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', (b) => { this.stderr = (this.stderr + b).slice(-2000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      const reply = JSON.parse(line); const p = this.pending.get(reply.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(reply.id); reply.error ? p.reject(new Error(reply.error.message)) : p.resolve(reply.result); }
    });
    this.child.once('exit', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited: ${this.stderr}`)); } this.pending.clear(); });
  }
  request(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP deadline exceeded')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() { await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'network-acceptance', version: '1' } }); return this; }
  async tool(args) {
    const result = await this.request('tools/call', { name: 'agentlink_collaboration', arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent;
  }
  async close() { this.child.stdin.end(); await stop(this.child); this.lines.close(); }
}
export async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'agentlink-workflow-'));
  const sides = ['backend', 'frontend'].map((agent) => ({ agent, repo: join(base, agent), root: join(base, `state-${agent}`), node: `node-${agent}` }));
  const servers = [], clients = [];
  try {
    for (const side of sides) {
      await mkdir(side.repo); await run('git', ['init', '--quiet', side.repo]);
      await initializeWorkspaceIdentity(side.repo);
      await registerParticipant(side.repo, { displayName: side.agent, participantId: side.agent, select: true });
      await initializeNodeIdentity(side.root, side.node); side.identity = await exportPublicIdentity(side.root);
    }
    for (let i = 0; i < 2; i++) {
      const side = sides[i], peer = sides[1 - i];
      await pairPeer(side.root, { name: peer.agent, address: 'https://127.0.0.1:1', identity: peer.identity, expectedFingerprint: peer.identity.fingerprint });
      await exposeAgent(side.root, { agentId: side.agent, workspaceRoot: side.repo, peerName: peer.agent });
      for (const id of ['orders', 'review']) await addGrant(side.root, { grantId: `${id}-grant`, remoteNodeId: peer.node, remoteAgentId: peer.agent,
        localAgentId: side.agent, collaborationId: id, actions: ['deliver'], expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    }
    for (const side of sides) { const server = await startServer(side.root, side.repo); side.server = server; servers.push(server); }
    for (let i = 0; i < 2; i++) {
      const side = sides[i], peer = sides[1 - i];
      await updatePeerAddress(side.root, { name: peer.agent, address: `https://127.0.0.1:${peer.server.port}` });
      side.client = await new McpClient(side.repo, side.root).initialize(); clients.push(side.client);
      side.target = { peer: peer.agent, agent: peer.agent, conversationId: 'orders', authority: i === 0 ? 'local' : 'peer' };
    }
    for (const id of ['orders', 'review']) await createCollaboration(sides[0].root, { id, localAgentId: sides[0].agent, remoteNodeId: sides[1].node,
      remoteAgentId: sides[1].agent, topic: id === 'orders' ? 'Orders API negotiation' : 'Author/reviewer resolution', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    let sequence = 0;
    const call = async (index, type, extra = {}, id = 'orders') => sides[index].client.tool({ ...sides[index].target, conversationId: id, operation: { type, requestId: `verify-${++sequence}`, ...extra } });
    const restart = async () => {
      for (const side of sides) { await side.client.close(); await stop(side.server.child); }
      for (const side of sides) { side.server = await startServer(side.root, side.repo, side.server.port); servers.push(side.server); side.client = await new McpClient(side.repo, side.root).initialize(); clients.push(side.client); }
    };
    return { base, sides, call, restart, async close() { await Promise.allSettled(clients.map((c) => c.close())); await Promise.allSettled(servers.map((s) => stop(s.child))); await rm(base, { recursive: true, force: true }); } };
  } catch (e) { await Promise.allSettled(clients.map((c) => c.close())); await Promise.allSettled(servers.map((s) => stop(s.child))); await rm(base, { recursive: true, force: true }); throw e; }
}
