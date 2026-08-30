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

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

type StdioOutputMode = 'content-length' | 'jsonl';

let outputMode: StdioOutputMode = 'content-length';

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
  try {
    if (request.method === 'initialize') {
      sendResult(request.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentlink-mcp', version: await readPackageVersion() },
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

function tryReadJsonLine(buffer: Buffer): { body: string; nextOffset: number } | null {
  const newline = buffer.indexOf('\n');
  if (newline === -1) return null;
  const body = buffer.subarray(0, newline).toString('utf8').trim();
  return { body, nextOffset: newline + 1 };
}

export async function serveStdio(): Promise<void> {
  let buffer = Buffer.alloc(0);

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    void (async () => {
      while (buffer.length > 0) {
        const trimmedStart = buffer.toString('utf8', 0, Math.min(buffer.length, 32)).trimStart();
        if (trimmedStart.startsWith('{')) {
          const line = tryReadJsonLine(buffer);
          if (!line) return;
          outputMode = 'jsonl';
          buffer = buffer.subarray(line.nextOffset);
          if (!line.body) continue;
          await handleRequest(JSON.parse(line.body) as JsonRpcRequest);
          continue;
        }

        const frame = tryReadContentLengthHeader(buffer);
        if (!frame) return;
        outputMode = 'content-length';
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
