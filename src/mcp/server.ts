#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENTLINK_MCP_TOOLS, callAgentLinkTool } from './tools.js';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

function send(message: unknown): void {
  stdout.write(encodeMessage(message));
}

function sendResult(id: JsonRpcId | undefined, result: unknown): void {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  try {
    if (request.method === 'initialize') {
      sendResult(request.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentlink-mcp', version: '0.1.0' },
      });
      return;
    }

    if (request.method === 'tools/list') {
      sendResult(request.id, { tools: AGENTLINK_MCP_TOOLS });
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
      sendResult(request.id, await callAgentLinkTool(toolName, args as Record<string, unknown> | undefined));
      return;
    }

    if (request.method === 'notifications/initialized') return;

    sendError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    sendError(request.id, -32000, error instanceof Error ? error.message : String(error));
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

export async function serveStdio(): Promise<void> {
  let buffer = Buffer.alloc(0);

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    void (async () => {
      while (buffer.length > 0) {
        const frame = tryReadContentLengthHeader(buffer);
        if (!frame) return;
        const totalLength = frame.bodyOffset + frame.length;
        if (buffer.length < totalLength) return;
        const body = buffer.subarray(frame.bodyOffset, totalLength).toString('utf8');
        buffer = buffer.subarray(totalLength);
        await handleRequest(JSON.parse(body) as JsonRpcRequest);
      }
    })().catch((error) => sendError(null, -32700, error instanceof Error ? error.message : String(error)));
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
