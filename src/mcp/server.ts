#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';

stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENTLINK_MCP_TOOLS, callAgentLinkTool } from './tools.js';
import {
  AGENTLINK_REMOTE_MCP_TOOLS,
  callRemoteAgentLinkTool,
  isRemoteTool,
  type RemoteMcpBinding,
} from './remote-tools.js';
import { initializeWorkspaceIdentity, resolveActiveParticipant } from '../workspace.js';
import { CONNECT_TOOL, callConnectTool } from './connect-tools.js';
import { SESSION_INSTRUCTIONS, SESSION_TOOL, SessionWorkspace } from './session-tools.js';

import { NetworkWakeConnection, readNetworkWakeConfig, networkWakeInstructions, withNetworkWakeDispatch } from '../network/wake.js';

let wakeConnection: NetworkWakeConnection | undefined;
let wakeTimer: NodeJS.Timeout | undefined;
let channelPolling = false;
const wakeNextTool = { name: 'agentlink_wake_next', description: 'Bind the next owner-enrolled Monitor event or dispatched OpenCode event before reading it.', inputSchema: { type: 'object', properties: { eventId: { type: 'string' } }, additionalProperties: false } };
const wakeAckTool = { name: 'agentlink_wake_ack', description: 'Acknowledge only the exact wake event observed through this MCP connection; this is not task processing.', inputSchema: { type: 'object', properties: { eventId: { type: 'string' }, outcome: { type: 'string', enum: ['observed', 'blocked'] }, summary: { type: 'string', maxLength: 512 } }, required: ['eventId', 'outcome', 'summary'], additionalProperties: false } };

async function pollWakeChannel(): Promise<void> {
  if (!wakeConnection || channelPolling) return;
  const connection = wakeConnection; channelPolling = true; let attempted = false;
  try {
    const event = await connection.next();
    if (event) await withNetworkWakeDispatch(connection.config, event, () => {
      attempted = true; connection.markDispatched();
      send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: networkWakeInstructions(connection.config, event), meta: { event_id: event.id, conversation_id: event.conversationId, sender_node: connection.config.peerNodeId } } });
    });
  } catch (error) {
    await connection.dispatchFailed((error as Error).message, attempted);
    process.stderr.write(`AgentLink channel paused: ${(error as Error).message.slice(0, 256)}\n`);
  } finally { channelPolling = false; }
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

type StdioOutputMode = 'content-length' | 'jsonl';

let outputMode: StdioOutputMode = 'content-length';
const activeRequests = new Map<string, AbortController>();
let remoteBinding: RemoteMcpBinding | undefined;
let sessionWorkspace: SessionWorkspace | undefined;

function requestKey(id: JsonRpcId | undefined): string | undefined {
  return id === undefined ? undefined : JSON.stringify(id);
}

function encodeContentLengthMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

function encodeJsonLineMessage(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

function send(message: unknown): void {
  stdout.write(outputMode === 'jsonl' ? encodeJsonLineMessage(message) : encodeContentLengthMessage(message));
}

function sendResult(id: JsonRpcId | undefined, result: unknown): void {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function readPackageVersion(): Promise<string> {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const manifest = JSON.parse(await readFile(join(cursor, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof manifest.version === 'string' && manifest.version.trim()) return manifest.version;
    } catch {
      // Keep walking toward the package root.
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return 'unknown';
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  if (request.method === 'notifications/cancelled') {
    const cancelledId = request.params?.requestId as JsonRpcId | undefined;
    const key = requestKey(cancelledId);
    if (key) activeRequests.get(key)?.abort();
    return;
  }
  const key = requestKey(request.id);
  const controller = key ? new AbortController() : undefined;
  if (key && controller) activeRequests.set(key, controller);
  try {
    if (request.method === 'initialize') {
      sendResult(request.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, ...(wakeConnection?.config.harness === 'claude-channel' ? { experimental: { 'claude/channel': {} } } : {}) },
        ...(sessionWorkspace ? { instructions: SESSION_INSTRUCTIONS } : wakeConnection ? { instructions: networkWakeInstructions(wakeConnection.config) } : {}),
        serverInfo: { name: 'agentlink-mcp', version: await readPackageVersion() },
      });
      return;
    }

    if (request.method === 'tools/list') {
      sendResult(request.id, { tools: [...AGENTLINK_MCP_TOOLS, CONNECT_TOOL, ...AGENTLINK_REMOTE_MCP_TOOLS, ...(sessionWorkspace ? [SESSION_TOOL] : []), ...(wakeConnection ? [wakeAckTool, wakeNextTool] : [])] });
      return;
    }

    if (request.method === 'tools/call') {
      const params = request.params ?? {};
      const toolName = params.name;
      if (typeof toolName !== 'string') throw new Error('tools/call requires params.name');
      const args = params.arguments;
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        throw new Error('tools/call params.arguments must be an object');
      }
      if (toolName === SESSION_TOOL.name) {
        if (!sessionWorkspace) throw new Error('This MCP server has a fixed project binding');
        sendResult(request.id, await sessionWorkspace.call((args ?? {}) as Record<string, unknown>));
        return;
      }
      const workspace = sessionWorkspace ? sessionWorkspace.workspace() : process.cwd();
      if (toolName === 'agentlink_wake_next') {
        if (!wakeConnection) throw new Error('No enrolled wake connection');
        const a = (args ?? {}) as Record<string, unknown>;
        if (Object.keys(a).some(k => k !== 'eventId') || (a.eventId !== undefined && typeof a.eventId !== 'string')) throw new Error('Invalid wake next arguments');
        const e = await wakeConnection.nextTool(a.eventId as string | undefined);
        sendResult(request.id, { content: [{ type: 'text', text: e ? networkWakeInstructions(wakeConnection.config, e) : 'No pending wake events.' }], structuredContent: { event: e ?? null } }); return;
      }
      if (toolName === 'agentlink_wake_ack') {
        if (!wakeConnection) throw new Error('No locally enrolled wake connection');
        await wakeConnection.ack((args ?? {}) as Record<string, unknown>);
        sendResult(request.id, { content: [{ type: 'text', text: 'Wake observation acknowledged; task processing is separate.' }] }); return;
      }
      if (wakeConnection) await wakeConnection.authorizeTool(toolName, (args ?? {}) as Record<string, unknown>);
      const result = toolName === CONNECT_TOOL.name
        ? await callConnectTool((args ?? {}) as Record<string, unknown>, workspace, controller?.signal)
        : isRemoteTool(toolName)
        ? await callRemoteAgentLinkTool(toolName, args as Record<string, unknown> | undefined, wakeConnection && remoteBinding ? { ...remoteBinding, remoteAgentId: wakeConnection.config.remoteAgentId } : remoteBinding)
        : await callAgentLinkTool(toolName, args as Record<string, unknown> | undefined, workspace, { signal: controller?.signal });
      if (wakeConnection) await wakeConnection.observe(toolName, (args ?? {}) as Record<string, unknown>, result);
      sendResult(request.id, result);
      return;
    }

    if (request.method === 'notifications/initialized') {
      if (wakeConnection?.config.harness === 'claude-channel' && !wakeTimer) {
        wakeTimer = setInterval(() => { void pollWakeChannel(); }, wakeConnection.config.pollMs);
        void pollWakeChannel();
      }
      return;
    }

    sendError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    sendError(request.id, error instanceof Error && error.name === 'AbortError' ? -32800 : -32000, error instanceof Error ? error.message : String(error));
  } finally {
    if (key && activeRequests.get(key) === controller) activeRequests.delete(key);
  }
}

function tryReadContentLengthHeader(buffer: Buffer): { length: number; bodyOffset: number } | null {
  const separator = buffer.indexOf('\r\n\r\n');
  if (separator === -1) return null;
  const header = buffer.subarray(0, separator).toString('utf8');
  const match = header.match(/^Content-Length:\s*(\d+)$/im);
  if (!match) throw new Error('MCP frame is missing Content-Length header');
  return { length: Number(match[1]), bodyOffset: separator + 4 };
}

function tryReadJsonLine(buffer: Buffer): { body: string; nextOffset: number } | null {
  const newline = buffer.indexOf('\n');
  if (newline === -1) return null;
  const body = buffer.subarray(0, newline).toString('utf8').trim();
  return { body, nextOffset: newline + 1 };
}

export async function serveStdio(options: { sessionScoped?: boolean } = {}): Promise<void> {
  if (options.sessionScoped) {
    if (process.env.AGENTLINK_NETWORK_STATE_ROOT || process.env.AGENTLINK_WAKE_CONFIG || process.env.AGENTLINK_PARTICIPANT_ID || process.env.AGENTLINK_WAKE_JOB_ID) throw new Error('User-wide sessions cannot inherit project network or actor bindings');
    sessionWorkspace = new SessionWorkspace();
  } else {
    await initializeWorkspaceIdentity(process.cwd());
    const startupActor = await resolveActiveParticipant(process.cwd());
    process.env.AGENTLINK_PARTICIPANT_ID = startupActor.participantId;
    const configuredNetworkRoot = process.env.AGENTLINK_NETWORK_STATE_ROOT;
    remoteBinding = configuredNetworkRoot
      ? { stateRoot: await realpath(configuredNetworkRoot), agentId: startupActor.participantId, workspaceRoot: await realpath(process.cwd()) }
      : undefined;
    const wakePath = process.env.AGENTLINK_WAKE_CONFIG;
    if (wakePath) {
      const config = await readNetworkWakeConfig(wakePath);
      if (!remoteBinding || config.stateRoot !== remoteBinding.stateRoot || config.workspaceRoot !== remoteBinding.workspaceRoot || config.agentId !== remoteBinding.agentId) throw new Error('Wake enrollment does not match this MCP workspace/actor');
      wakeConnection = new NetworkWakeConnection(config);
      if (config.harness === 'codex') {
        if (!process.env.AGENTLINK_WAKE_JOB_ID) throw new Error('Codex wake job binding required');
        await wakeConnection.attach(process.env.AGENTLINK_WAKE_JOB_ID);
      }
    }
  }
  stdin.on('end', () => { if (wakeTimer) clearInterval(wakeTimer); });
  let buffer = Buffer.alloc(0);

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length > 0) {
        const trimmedStart = buffer.toString('utf8', 0, Math.min(buffer.length, 32)).trimStart();
        if (trimmedStart.startsWith('{')) {
          const line = tryReadJsonLine(buffer);
          if (!line) return;
          outputMode = 'jsonl';
          buffer = buffer.subarray(line.nextOffset);
          if (!line.body) continue;
          void handleRequest(JSON.parse(line.body) as JsonRpcRequest);
          continue;
        }

        const frame = tryReadContentLengthHeader(buffer);
        if (!frame) return;
        outputMode = 'content-length';
        const totalLength = frame.bodyOffset + frame.length;
        if (buffer.length < totalLength) return;
        const body = buffer.subarray(frame.bodyOffset, totalLength).toString('utf8');
        buffer = buffer.subarray(totalLength);
        void handleRequest(JSON.parse(body) as JsonRpcRequest);
      }
    } catch (error) {
      sendError(null, -32700, error instanceof Error ? error.message : String(error));
    }
  });
}

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => process.argv[1] ?? '')
  : '';
const realModulePath = await realpath(modulePath).catch(() => modulePath);

if (invokedPath && (modulePath === invokedPath || realModulePath === invokedPath || import.meta.url === pathToFileURL(process.argv[1] ?? '').href)) {
  void serveStdio();
}
