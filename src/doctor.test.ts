import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDoctorReport, renderDoctorReport } from './doctor.js';
import { initializeContract } from './contract.js';
import { ensureWorkspace } from './store.js';

function fakePane() {
  return {
    paneId: '%1',
    sessionName: 'codex-api',
    windowIndex: '0',
    windowName: 'codex',
    paneIndex: '0',
    currentCommand: 'zsh',
    startCommand: 'codex',
    currentPath: '/tmp/api',
    title: 'codex',
    agentKind: 'codex' as const,
  };
}

test('doctor reports a ready workspace and active agent panes without hard failures', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-doctor-ready-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink-fixture',
    scripts: { agentlink: 'node dist/cli.js', build: 'tsc', test: 'node --test' },
  }), 'utf8');
  await ensureWorkspace(cwd);
  await initializeContract(cwd);
  await mkdir(join(cwd, 'dist', 'mcp'), { recursive: true });
  await writeFile(join(cwd, 'dist', 'mcp', 'server.js'), '', 'utf8');

  const report = await collectDoctorReport(cwd, async () => [fakePane()], 'v20.0.0');
  assert.equal(report.hasFailures, false);
  assert.deepEqual(report.checks.map((item) => [item.status, item.label]), [
    ['ok', 'Node.js'],
    ['ok', 'package.json'],
    ['ok', 'npm scripts'],
    ['ok', 'workspace'],
    ['ok', 'contract'],
    ['ok', 'conversation store'],
    ['ok', 'tmux agents'],
    ['ok', 'MCP build artifact'],
  ]);

  const rendered = renderDoctorReport(report);
  assert.match(rendered, /AgentLink Doctor/);
  assert.match(rendered, /\[ok\] Node\.js: v20\.0\.0 \(>=20\)/);
  assert.match(rendered, /\[ok\] tmux agents: 1 active coding-agent pane\(s\)/);
  assert.match(rendered, /Result: ready with no hard failures\./);
});

test('doctor distinguishes hard failures from non-blocking local warnings', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-doctor-warn-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink-fixture',
    scripts: { test: 'node --test' },
  }), 'utf8');

  const report = await collectDoctorReport(cwd, async () => [], 'v18.19.0');
  assert.equal(report.hasFailures, true);
  assert.equal(report.checks.find((item) => item.label === 'Node.js')?.status, 'fail');
  assert.equal(report.checks.find((item) => item.label === 'npm scripts')?.status, 'fail');
  assert.equal(report.checks.find((item) => item.label === 'workspace')?.status, 'warn');
  assert.equal(report.checks.find((item) => item.label === 'tmux agents')?.status, 'warn');
  assert.match(renderDoctorReport(report), /Result: failures found\./);
});
