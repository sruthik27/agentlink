#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'agentlink-installed-'));
try {
  const packed = await run('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const [manifest] = JSON.parse(packed.stdout);
  for (const entry of manifest.files) {
    assert.equal(/(^|\/)(\.hermes|\.agentlink|node_modules|identity|trust\.json|mailbox\.json)(\/|$)|\.pem$|\.test\.(js|d\.ts)$|\.js\.map$/.test(entry.path), false, `Unexpected packaged file: ${entry.path}`);
  }
  for (const required of ['dist/network/collaboration.js', 'dist/network/collaboration-client.js', 'dist/mcp/remote-tools.js', 'scripts/verify-network-collaboration.mjs', 'scripts/network-fixture.mjs']) assert.ok(manifest.files.some((f) => f.path === required), `Missing ${required}`);
  const archive = join(temporary, manifest.filename);
  const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const prefix = join(temporary, 'prefix');
  await run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', archive], { timeout: 60000 });
  const installed = join(prefix, 'node_modules/@sruthik/agentlink');
  const version = await run(process.execPath, [join(installed, 'dist/cli.js'), 'version'], { cwd: temporary, timeout: 15000 });
  assert.equal(version.stdout.trim(), manifest.version);
  const checks = {};
  for (const gate of ['foundation', 'bridge', 'collaboration']) {
    const result = await run(process.execPath, [join(installed, `scripts/verify-network-${gate}.mjs`)], { cwd: temporary, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.status, 'PASS'); checks[gate] = evidence;
  }
  if (process.env.AGENTLINK_VERIFY_INSTALLED_NATIVE === '1') {
    const result = await run(process.execPath, [join(installed, 'scripts/verify-network-native.mjs')], { cwd: root, timeout: 3600000, maxBuffer: 8 * 1024 * 1024 });
    checks.native = JSON.parse(result.stdout.trim());
    assert.equal(checks.native.status, 'PASS');
  }
  if (process.env.AGENTLINK_ARCHIVE_OUTPUT) await copyFile(archive, process.env.AGENTLINK_ARCHIVE_OUTPUT);
  console.log(JSON.stringify({ status: 'PASS', version: manifest.version, archiveSha256, fileCount: manifest.files.length, checks, nativeVerified: !!checks.native, physicalHostsVerified: false }));
} finally { await rm(temporary, { recursive: true, force: true }); }
