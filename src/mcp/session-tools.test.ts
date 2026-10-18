import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

test('one global definition serves isolated simultaneous sessions without writing in the harness cwd', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-global-session-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'harness-config'), left = join(root, 'left'), right = join(root, 'right');
  for (const path of [home, left, right]) await mkdir(path);
  const launch = fileURLToPath(new URL('./launch.js', import.meta.url));
  function client() {
    const child = spawn(process.execPath, [launch, '--session'], { cwd: home, env: { ...process.env, AGENTLINK_PARTICIPANT_ID: 'stale-owner-actor', AGENTLINK_NETWORK_STATE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { child.stdin.end(); child.kill(); });
    const lines = createInterface({ input: child.stdout });
    let nextId = 0;
    const pending = new Map<number, (message: any) => void>();
    lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
    return async (method: string, params: Record<string, unknown> = {}) => {
      const id = ++nextId;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP session timed out')); }, 10000);
        pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };
  }
  const a = client(), b = client();
  for (const call of [a, b]) {
    assert.match((await call('initialize')).result.instructions, /user-wide/);
    assert((await call('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'agentlink_session'));
    assert.equal((await call('tools/call', { name: 'agentlink_session', arguments: { action: 'status' } })).result.structuredContent.bound, false);
    assert.match((await call('tools/call', { name: 'agentlink_connect', arguments: { action: 'status' } })).error.message, /bind/);
  }
  assert.deepEqual(await readdir(home), []);
  const [ab, bb] = await Promise.all([
    a('tools/call', { name: 'agentlink_session', arguments: { action: 'bind', workspace: left } }),
    b('tools/call', { name: 'agentlink_session', arguments: { action: 'bind', workspace: right } }),
  ]);
  assert.equal(ab.result.structuredContent.workspace, left);
  assert.equal(bb.result.structuredContent.workspace, right);
  assert.notEqual(ab.result.structuredContent.participantId, bb.result.structuredContent.participantId);
  assert.match((await a('tools/call', { name: 'agentlink_session', arguments: { action: 'bind', workspace: right } })).error.message, /already bound/);
  assert.equal((await a('tools/call', { name: 'agentlink_session', arguments: { action: 'bind', workspace: left } })).result.structuredContent.workspace, left);
  assert.match((await b('tools/call', { name: 'agentlink_session', arguments: { action: 'bind', workspace: '.' } })).error.message, /absolute/);
  for (const call of [a, b]) {
    assert.deepEqual((await call('tools/call', { name: 'agentlink_connect', arguments: { action: 'status' } })).result.structuredContent.connections, []);
  }
  assert.deepEqual(await readdir(home), []);
  assert((await readdir(left)).includes('.agentlink'));
  assert((await readdir(right)).includes('.agentlink'));
});
