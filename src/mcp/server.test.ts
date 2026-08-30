import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));

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
