import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planSetup, writeSetup, checkSetup } from './setup-config.js';
import { runCli } from './cli.js';

test('project adapters generate actual client formats and launch MCP from a fixed workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-setup-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const harness of ['claude-code', 'copilot', 'codex', 'gemini', 'opencode'] as const) {
    const repo = join(root, harness + ' with spaces'); await mkdir(repo);
    const plan = await planSetup(repo, harness);
    assert.equal((await writeSetup(plan)).status, 'configured');
    assert.equal((await writeSetup(plan)).status, 'already-configured');
    const raw = await readFile(plan.configPath!, 'utf8');
    if (harness === 'codex') assert.match(raw, /\[mcp_servers.agentlink\]/);
    else {
      const config = JSON.parse(raw);
      const server = harness === 'opencode' ? config.mcp.agentlink : config.mcpServers.agentlink;
      if (harness === 'opencode') assert.deepEqual(server.command, [plan.command, ...plan.args]);
      else assert.deepEqual(server.args, plan.args);
      if (harness === 'copilot') assert.equal(server.type, 'stdio');
    }
    const unrelated = join(root, harness + '-unrelated'); await mkdir(unrelated);
    // A host may launch from its own cwd: the generated argv still binds this repo.
    const result = await checkSetup({ ...plan, workspace: unrelated });
    assert.equal(result.status, 'mcp-handshake-passed'); assert(result.tools > 0); assert.equal(result.nativeAgentVerified, false);
    assert(!(await readdir(unrelated)).includes('.agentlink'));
    assert((await readdir(repo)).includes('.agentlink'));
  }
});

test('setup merges one JSON server, backs up exact original bytes, refuses conflicts and malformed files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-setup-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = await planSetup(root, 'claude-code'), file = plan.configPath!;
  const original = '{"custom":true,"mcpServers":{"other":{"command":"keep"}}}\n'; await writeFile(file, original);
  const result = await writeSetup(plan);
  assert.equal(await readFile(result.backup!, 'utf8'), original);
  const merged = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(merged.custom, true); assert.deepEqual(merged.mcpServers.other, { command: 'keep' });
  for (const content of ['{', '[]', '{"mcpServers":[]}', '{"mcpServers":{"agentlink":{"command":"different"}}}', ' '.repeat(256001)]) {
    await writeFile(file, content); await assert.rejects(writeSetup(plan)); assert.equal(await readFile(file, 'utf8'), content);
  }
  await rm(file); const outside = join(root, 'outside.json'); await writeFile(outside, original); await symlink(outside, file);
  await assert.rejects(writeSetup(plan), /symbolic link/); assert.equal(await readFile(outside, 'utf8'), original);
});

test('existing Codex TOML, OpenCode JSONC and bare Copilot config are preserved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-setup-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codex = await planSetup(root, 'codex'); await mkdir(dirname(codex.configPath!), { recursive: true });
  const original = 'model = "owner-model"\n'; await writeFile(codex.configPath!, original);
  await assert.rejects(writeSetup(codex), /Existing Codex TOML preserved/); assert.equal(await readFile(codex.configPath!, 'utf8'), original);
  const opencode = await planSetup(root, 'opencode'); await writeFile(join(root, 'opencode.jsonc'), '// keep comments\n{}');
  await assert.rejects(writeSetup(opencode), /will not shadow/); assert(!(await readdir(root)).includes('opencode.json'));
  const copilot = await planSetup(root, 'copilot'); await writeFile(copilot.configPath!, '{"other":{"command":"keep"}}');
  await assert.rejects(writeSetup(copilot), /bare Copilot config preserved/);
});

test('setup preview is nonmutating; CLI write/check performs a real MCP handshake without a coding-agent login', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-setup-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const output = { log: (s: string) => { lines.push(s); }, error: (s: string) => { throw new Error(s); } };
  await runCli(['setup', '--harness', 'copilot', '--config'], root, output);
  assert.deepEqual(await readdir(root), []);
  await runCli(['setup', '--harness', 'copilot', '--write', '--check'], root, output);
  const report = JSON.parse(lines[1]); assert.equal(report.installation.status, 'configured'); assert.equal(report.check.status, 'mcp-handshake-passed');
  await assert.rejects(planSetup(root, 'stdio', 'relative'), /absolute/);
  await assert.rejects(planSetup(root, 'stdio', root), /outside/);
  const hiddenChild = join(root, '..private-state'); await mkdir(hiddenChild);
  await assert.rejects(planSetup(root, 'stdio', hiddenChild), /outside/);
  await assert.rejects(planSetup(root, 'stdio', undefined, '/tmp/wake'), /requires/);
});

test('user-wide setup writes outside projects and starts without assuming a workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-setup-user-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const paths = { 'claude-code': '.claude.json', codex: '.codex/config.toml', copilot: '.copilot/mcp-config.json', gemini: '.gemini/settings.json', opencode: '.config/opencode/opencode.json' };
  for (const harness of ['claude-code', 'codex', 'copilot', 'gemini', 'opencode'] as const) {
    const home = join(root, harness); await mkdir(home);
    const plan = await planSetup(repo, harness, undefined, undefined, 'user', home, {});
    assert.equal(plan.configPath, join(home, paths[harness]));
    assert.deepEqual(plan.args.slice(1), ['--session']);
    await writeSetup(plan);
    assert.equal((await writeSetup(plan)).status, 'already-configured');
    assert.equal((await checkSetup({ ...plan, workspace: home })).status, 'mcp-handshake-passed');
    assert(!(await readdir(home)).includes('.agentlink'));
    assert.deepEqual(await readdir(repo), []);
  }
  const codex = await planSetup(repo, 'codex', undefined, undefined, 'user', root, { CODEX_HOME: join(root, 'custom-codex') });
  assert.equal(codex.configPath, join(root, 'custom-codex/config.toml'));
  await assert.rejects(planSetup(repo, 'codex', root, undefined, 'user'), /cannot pin/);
  await assert.rejects(planSetup(repo, 'stdio', undefined, undefined, 'invalid' as 'user'), /scope/);
  await assert.rejects(planSetup(repo, 'claude-code', undefined, undefined, 'user', root, { CLAUDE_CONFIG_DIR: root }), /will not guess/);
  const lines: string[] = [];
  await runCli(['setup', '--harness', 'stdio', '--scope', 'user', '--config'], repo, { log: s => lines.push(s), error: s => { throw new Error(s); } });
  assert.equal(JSON.parse(lines[0]).scope, 'user');
  await assert.rejects(runCli(['setup', '--harness', 'stdio', '--scope', 'invalid'], repo), /scope/);
});
