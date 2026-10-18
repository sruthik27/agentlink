#!/usr/bin/env node
// Exact packed-runtime setup smoke test, not native model/harness acceptance.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'agentlink-installed-setup-'));
const run = (command, args, cwd = process.cwd()) => {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
try {
  const packageDir = join(root, 'pack'); await mkdir(packageDir);
  // Run prepack so this gate checks current sources, even on a clean checkout.
  const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packageDir]));
  const archive = join(packageDir, pack[0].filename), prefix = join(root, 'install');
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, archive]);
  const pkg = await realpath(join(prefix, 'node_modules/@sruthik/agentlink'));
  const { planSetup, writeSetup, checkSetup } = await import(pathToFileURL(join(pkg, 'dist/setup-config.js')).href);
  for (const harness of ['claude-code', 'codex', 'copilot', 'gemini', 'opencode']) {
    const repo = join(root, harness); await mkdir(repo);
    const plan = await planSetup(repo, harness);
    assert(plan.args[0].startsWith(pkg));
    await writeSetup(plan);
    assert.equal((await checkSetup(plan)).status, 'mcp-handshake-passed');
    const home = join(root, `${harness}-home`); await mkdir(home);
    const global = await planSetup(repo, harness, undefined, undefined, 'user', home, {});
    assert.deepEqual(global.args.slice(1), ['--session']);
    await writeSetup(global);
    assert.equal((await checkSetup({ ...global, workspace: home })).status, 'mcp-handshake-passed');
  }
  const version = JSON.parse(run(process.execPath, [join(pkg, 'dist/cli.js'), 'version', '--format', 'json']));
  assert(await readFile(join(pkg, 'docs/setup.md'), 'utf8'));
  console.log(JSON.stringify({ result: 'PASS', archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), runtime: version, adapters: 5, scopes: ['project', 'user'], nativeAgentVerified: false }));
} finally { await rm(root, { recursive: true, force: true }); }
