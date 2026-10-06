import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendMessage, createConversation, joinConversation, readConversation } from '../store.js';
import { initializeWorkspaceIdentity, registerParticipant, selectParticipant } from '../workspace.js';

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));

interface JsonLineClient {
  call(id: number, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
}

function jsonLineClient(child: ReturnType<typeof spawn>): JsonLineClient {
  let buffer = '';
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timeout: NodeJS.Timeout }>();
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line) as Record<string, unknown>;
      const id = response.id;
      if (typeof id !== 'number') continue;
      const waiter = pending.get(id);
      if (!waiter) continue;
      clearTimeout(waiter.timeout);
      pending.delete(id);
      if (response.error) waiter.reject(new Error(String((response.error as { message?: unknown }).message)));
      else waiter.resolve(response);
    }
  });
  return {
    call(id, name, args = {}) {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for MCP response ${id}`));
        }, 5000);
        pending.set(id, { resolve, reject, timeout });
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
      return response;
    },
    notify(method, params = {}) {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

function readJsonLine(stdout: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('timed out waiting for JSON line response')), 5000);
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timeout);
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    stdout.on('error', reject);
  });
}

test('stdio server accepts Codex newline-delimited JSON-RPC initialize and tools/list', async () => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codex-mcp-client', version: '0.145.0' },
      },
    })}\n`);
    const init = await readJsonLine(child.stdout);
    assert.equal(init.id, 0);
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'agentlink-mcp');

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
    const tools = await readJsonLine(child.stdout);
    assert.equal(tools.id, 1);
    const names = ((tools.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    assert.ok(names.includes('agentlink_start_conversation'));
    assert.ok(names.includes('agentlink_update_contract'));
  } finally {
    child.kill();
  }
});

test('two MCP processes with distinct cwd values route through one authoritative conversation log', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'agentlink-server-source-'));
  const peer = await mkdtemp(join(tmpdir(), 'agentlink-server-peer-'));
  const sourceServer = spawn(process.execPath, [serverPath], { cwd: source, stdio: ['pipe', 'pipe', 'pipe'] });
  const peerServer = spawn(process.execPath, [serverPath], { cwd: peer, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    sourceServer.kill();
    peerServer.kill();
    await rm(source, { recursive: true, force: true });
    await rm(peer, { recursive: true, force: true });
  });
  const sourceClient = jsonLineClient(sourceServer);
  const peerClient = jsonLineClient(peerServer);

  const started = await sourceClient.call(1, 'agentlink_start_conversation', { topic: 'Process-routed thread' });
  const startText = ((((started.result as { content: Array<{ text: string }> }).content)[0])?.text);
  const conversationId = startText?.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(conversationId);
  await sourceClient.call(2, 'agentlink_update_contract', { conversationId, status: 'Proposed', syncTo: peer });
  await peerClient.call(1, 'agentlink_join_conversation', { conversationId });
  await peerClient.call(2, 'agentlink_send_message', { conversationId, body: 'message from peer process', kind: 'status' });

  const read = await sourceClient.call(3, 'agentlink_read_inbox', { conversationId, limit: 10 });
  const structured = (read.result as { structuredContent: { messages: Array<{ body: string; workspaceId: string }> } }).structuredContent;
  assert.equal(structured.messages.length, 1);
  assert.equal(structured.messages[0]?.body, 'message from peer process');
  assert.equal(typeof structured.messages[0]?.workspaceId, 'string');
});

test('one MCP stdio connection handles send while bounded wait is pending and supports cancellation', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-server-wait-'));
  const child = spawn(process.execPath, [serverPath], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  });
  const client = jsonLineClient(child);
  const started = await client.call(1, 'agentlink_start_conversation', { topic: 'Concurrent MCP wait' });
  const startText = ((((started.result as { content: Array<{ text: string }> }).content)[0])?.text);
  const conversationId = startText?.match(/Started conversation ([a-zA-Z0-9_-]+):/)?.[1];
  assert.ok(conversationId);
  const initial = await client.call(2, 'agentlink_read_inbox', { conversationId, limit: 20 });
  const cursor = (initial.result as { structuredContent: { nextCursor: string } }).structuredContent.nextCursor;

  const waiting = client.call(3, 'agentlink_wait_for_messages', { conversationId, after: cursor, timeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  const sent = await client.call(4, 'agentlink_send_message', { conversationId, body: 'concurrent request' });
  assert.match(((sent.result as { content: Array<{ text: string }> }).content)[0]!.text, /Persisted message/);
  const waitResult = await waiting;
  const waitStructured = (waitResult.result as { structuredContent: { outcome: string; messages: Array<{ body: string }> } }).structuredContent;
  assert.equal(waitStructured.outcome, 'message');
  assert.equal(waitStructured.messages[0]?.body, 'concurrent request');

  const after = await client.call(5, 'agentlink_read_inbox', { conversationId, limit: 20 });
  const afterCursor = (after.result as { structuredContent: { nextCursor: string } }).structuredContent.nextCursor;
  const cancelled = client.call(6, 'agentlink_wait_for_messages', { conversationId, after: afterCursor, timeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.notify('notifications/cancelled', { requestId: 6, reason: 'test cancellation' });
  await assert.rejects(cancelled, /Message wait cancelled/);
});

test('MCP process pins its startup actor when the checkout default changes', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-server-actor-'));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await initializeWorkspaceIdentity(cwd);
  const firstActorConversation = await createConversation(cwd, { id: 'actor-pin', topic: 'Pinned actor' });
  const firstActorId = firstActorConversation.ownerParticipantId!;
  const secondActor = await registerParticipant(cwd, { displayName: 'second actor', select: false });
  await selectParticipant(cwd, secondActor.participantId);
  await joinConversation(cwd, firstActorConversation.id);
  await selectParticipant(cwd, firstActorId);

  const child = spawn(process.execPath, [serverPath], { cwd, env: { ...process.env, AGENTLINK_PARTICIPANT_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const client = jsonLineClient(child);
  await client.call(1, 'agentlink_send_message', { conversationId: firstActorConversation.id, body: 'before actor switch' });
  await selectParticipant(cwd, secondActor.participantId);
  await client.call(2, 'agentlink_send_message', { conversationId: firstActorConversation.id, body: 'after actor switch' });

  const messages = (await readConversation(cwd, firstActorConversation.id)).messages;
  assert.deepEqual(messages.map((message) => message.participantId), [firstActorId, firstActorId]);
});
