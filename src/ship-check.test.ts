import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectShipCheckReport, renderShipCheckReport } from './ship-check.js';

test('ship check reports package, docs, bins, and build readiness', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '0.1.0',
    license: 'MIT',
    bin: {
      agentlink: './dist/cli.js',
      'agentlink-mcp': './dist/mcp/server.js',
    },
    files: [
      'README.md',
      'dist/**/*.js',
      'dist/**/*.d.ts',
      '!dist/**/*.test.js',
      '!dist/**/*.test.d.ts',
    ],
    scripts: {
      agentlink: 'node dist/cli.js',
      build: 'tsc -p tsconfig.json',
      test: 'node --test',
    },
    keywords: ['mcp', 'tmux', 'multi-agent'],
  }), 'utf8');
  await writeFile(join(cwd, 'README.md'), [
    '# AgentLink',
    'cross-repo contract negotiation',
    'Structured bus is source of truth',
    'tmux pane messaging is notification/bridge',
    'npm run agentlink -- setup',
    'npm run agentlink -- doctor',
    'npm run agentlink -- demo --peer ../peer-repo',
    'npm run agentlink -- replay',
    'npm run agentlink -- version',
    'npm run agentlink -- launch-brief',
    'node dist/mcp/server.js',
  ].join('\n'), 'utf8');
  await mkdir(join(cwd, 'dist', 'mcp'), { recursive: true });
  await writeFile(join(cwd, 'dist', 'cli.js'), '', 'utf8');
  await writeFile(join(cwd, 'dist', 'mcp', 'server.js'), '', 'utf8');

  const report = await collectShipCheckReport(cwd);
  assert.equal(report.packageName, 'agentlink');
  assert.equal(report.version, '0.1.0');
  assert.equal(report.hasFailures, false);
  assert.match(report.launchBoundary, /without explicit Sruthik approval/);
  assert.deepEqual(report.checks.map((check) => check.status), [
    'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok',
  ]);

  const rendered = renderShipCheckReport(report);
  assert.match(rendered, /AgentLink Ship Check/);
  assert.match(rendered, /\[ok\] package bins: agentlink, agentlink-mcp/);
  assert.match(rendered, /\[ok\] package files allowlist:/);
  assert.match(rendered, /Result: ready for final verified demo and human launch approval/);
});

test('ship check fails missing launch-critical docs and package bins', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-fail-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    scripts: { build: 'tsc' },
    bin: { agentlink: './dist/cli.js' },
  }), 'utf8');
  await writeFile(join(cwd, 'README.md'), '# AgentLink\n', 'utf8');

  const report = await collectShipCheckReport(cwd);
  assert.equal(report.hasFailures, true);
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'required npm scripts'));
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'package bins'));
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'package files allowlist'));
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'README command coverage'));
  assert.match(renderShipCheckReport(report), /Result: not ready; fix failed checks before launch approval/);
});

test('ship check rejects package allowlists that include local source or AgentLink state', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-dirty-files-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '0.1.0',
    license: 'MIT',
    bin: {
      agentlink: './dist/cli.js',
      'agentlink-mcp': './dist/mcp/server.js',
    },
    files: ['README.md', 'dist/**/*.js', 'dist/**/*.d.ts', 'src', '.agentlink/CONTRACT.md'],
    scripts: {
      agentlink: 'node dist/cli.js',
      build: 'tsc -p tsconfig.json',
      test: 'node --test',
    },
    keywords: ['mcp', 'tmux', 'multi-agent'],
  }), 'utf8');

  const report = await collectShipCheckReport(cwd);
  const packageFiles = report.checks.find((check) => check.label === 'package files allowlist');
  assert.equal(packageFiles?.status, 'fail');
  assert.match(packageFiles?.detail ?? '', /must not include src\/, \.agentlink\/, or \.hermes\/ state/);
});
