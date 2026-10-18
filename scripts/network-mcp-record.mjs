#!/usr/bin/env node
// Native acceptance recorder: records only collaboration tool requests and their replies.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/mcp/server.js', import.meta.url))], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const ids = new Set();
const record = (direction, message) => appendFileSync(process.argv[2], JSON.stringify({ at: new Date().toISOString(), direction, message }) + '\n', { mode: 0o600 });
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'tools/call' && message.params?.name === 'agentlink_collaboration') { ids.add(message.id); record('request', message); }
  child.stdin.write(line + '\n');
}).on('close', () => child.stdin.end());
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  if (ids.has(message.id)) { record('response', message); ids.delete(message.id); }
  process.stdout.write(line + '\n');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', (code) => process.exit(code ?? 1));
