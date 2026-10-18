import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeBuildIdentity } from './build-info.js';

test('runtime build identity is deterministic and sensitive to shipped JS, not tests or docs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-build-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b');
  for (const dir of [a, b]) await mkdir(join(dir, 'network'), { recursive: true });
  await writeFile(join(a, 'cli.js'), 'cli'); await writeFile(join(a, 'network', 'wake.js'), 'wake');
  await writeFile(join(b, 'network', 'wake.js'), 'wake'); await writeFile(join(b, 'cli.js'), 'cli');
  const first = await runtimeBuildIdentity(a);
  assert.deepEqual(first, await runtimeBuildIdentity(b));
  assert.match(first.buildId, /^sha256:[a-f0-9]{64}$/); assert.equal(first.runtimeFiles, 2);
  await writeFile(join(b, 'cli.test.js'), 'test'); await writeFile(join(b, 'README.md'), 'docs');
  await symlink(join(a, 'cli.js'), join(b, 'ignored.js'));
  assert.deepEqual(first, await runtimeBuildIdentity(b));
  await writeFile(join(b, 'network', 'wake.js'), 'changed');
  assert.notEqual(first.buildId, (await runtimeBuildIdentity(b)).buildId);
});
