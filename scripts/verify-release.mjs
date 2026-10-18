#!/usr/bin/env node
// Local release gates only. Never invokes a model, publishes, or renews pilot access.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.hermes', 'release', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const report = { status: 'RUNNING', output, gates: {}, nativeModelVerified: false, physicalHostsVerified: false, published: false };
const archive = join(output, 'agentlink-candidate.tgz');
const gates = [
  ['tests', 'npm', ['test']],
  ['ship', process.execPath, ['dist/cli.js', 'ship-check', '--format', 'json']],
  ['installed', process.execPath, ['scripts/verify-network-installed.mjs']],
  ['setup', process.execPath, ['scripts/verify-setup-installed.mjs']],
  ['connect', process.execPath, ['scripts/verify-connect-installed.mjs']],
  ['wake', process.execPath, ['scripts/verify-network-wake.mjs']],
  ['adapters', process.execPath, ['scripts/verify-network-native-adapters.mjs']],
];
for (const [name, command, args] of gates) {
  console.log(`Checking ${name}…`);
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, AGENTLINK_VERIFY_INSTALLED_NATIVE: '0', AGENTLINK_ARCHIVE_OUTPUT: archive },
  });
  await writeFile(join(output, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  report.gates[name] = { status: result.status === 0 && !result.error ? 'PASS' : 'FAIL', exitCode: result.status, ...(result.error ? { error: result.error.message } : {}) };
  if (report.gates[name].status === 'FAIL') { report.status = 'FAIL'; break; }
}
if (report.status !== 'FAIL') {
  report.archive = archive;
  report.archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const installed = JSON.parse(await readFile(join(output, 'installed.log'), 'utf8'));
  const setup = JSON.parse(await readFile(join(output, 'setup.log'), 'utf8'));
  const connect = JSON.parse(await readFile(join(output, 'connect.log'), 'utf8'));
  report.gates.archiveConsistency = { status: installed.archiveSha256 === setup.archiveSha256 && setup.archiveSha256 === connect.archiveSha256 && connect.archiveSha256 === report.archiveSha256 ? 'PASS' : 'FAIL' };
  report.status = report.gates.archiveConsistency.status;
}
await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.status === 'FAIL') process.exitCode = 1;
