import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectShipCheckReport, renderShipCheckReport } from './ship-check.js';

const execFileAsync = promisify(execFile);

function fakeMcpServer(version = '0.1.0'): string {
  return `#!/usr/bin/env node
process.stdin.on('data', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentlink-mcp', version: '${version}' } } });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
});
`;
}

const validGif = Buffer.from('R0lGODlhAQABAAAAACwAAAAAAQABAAA=', 'base64');
const validCast = '{"version":2,"width":100,"height":30,"title":"AgentLink demo"}\n[0,"o","AgentLink demo\n"]\n';

test('ship check reports package, docs, bins, and build readiness', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '0.1.0',
    description: 'Local-first coordination bus for coding agents working across repos through durable contracts.',
    license: 'MIT',
    homepage: 'https://github.com/sruthik27/agentlink#readme',
    repository: { type: 'git', url: 'git+https://github.com/sruthik27/agentlink.git' },
    bugs: { url: 'https://github.com/sruthik27/agentlink/issues' },
    engines: { node: '>=20' },
    publishConfig: { access: 'public' },
    bin: {
      agentlink: './dist/cli.js',
      'agentlink-mcp': './dist/mcp/server.js',
    },
    files: [
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
      'release-notes-v0.1.0.md',
      'demos/agentlink-demo.gif',
      'demos/agentlink-demo.cast',
      'dist/**/*.js',
      'dist/**/*.d.ts',
      '!dist/**/*.test.js',
      '!dist/**/*.test.d.ts',
    ],
    scripts: {
      agentlink: 'node dist/cli.js',
      build: 'tsc -p tsconfig.json',
      prepack: 'node -e "require(\"fs\").writeFileSync(\"prepack-ran\",\"yes\")"',
      test: 'node --test',
    },
    keywords: ['mcp', 'tmux', 'multi-agent'],
  }), 'utf8');
  await writeFile(join(cwd, 'README.md'), [
    '# AgentLink',
    'npx agentlink doctor',
    'npm install -g agentlink',
    'agentlink setup --harness all',
    'cross-repo contract negotiation',
    'Structured bus is source of truth',
    'tmux pane messaging is notification/bridge',
    'npm run agentlink -- setup',
    'npm run agentlink -- doctor',
    'npm run agentlink -- ship-check',
    'npm run agentlink -- demo --peer ../peer-repo',
    'npm run agentlink -- replay',
    'npm run agentlink -- version',
    'npm run agentlink -- launch-brief',
    'node dist/mcp/server.js',
    '![AgentLink terminal demo](demos/agentlink-demo.gif)',
    'asciinema play demos/agentlink-demo.cast',
    'release-notes-v0.1.0.md',
  ].join('\n'), 'utf8');
  await writeFile(join(cwd, 'LICENSE'), 'MIT\n', 'utf8');
  await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
  await writeFile(join(cwd, 'release-notes-v0.1.0.md'), [
    '## AgentLink 0.1.0',
    '### Verification before release',
    'Local tests passed.',
    '### Known limitation',
    'GitHub Actions did not run.',
  ].join('\n'), 'utf8');
  await mkdir(join(cwd, 'dist', 'mcp'), { recursive: true });
  await mkdir(join(cwd, 'demos'), { recursive: true });
  await writeFile(join(cwd, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log(\'0.1.0\');\n', 'utf8');
  await writeFile(join(cwd, 'dist', 'mcp', 'server.js'), fakeMcpServer(), 'utf8');
  await chmod(join(cwd, 'dist', 'cli.js'), 0o755);
  await chmod(join(cwd, 'dist', 'mcp', 'server.js'), 0o755);
  await writeFile(join(cwd, 'demos', 'agentlink-demo.gif'), validGif);
  await writeFile(join(cwd, 'demos', 'agentlink-demo.cast'), validCast, 'utf8');

  const report = await collectShipCheckReport(cwd);
  assert.equal(await readFile(join(cwd, 'prepack-ran'), 'utf8').then(() => 'ran').catch(() => 'not-ran'), 'not-ran');
  assert.equal(report.packageName, 'agentlink');
  assert.equal(report.version, '0.1.0');
  assert.equal(report.hasFailures, false);
  assert.match(report.launchBoundary, /without explicit Sruthik approval/);
  assert.deepEqual(report.checks.map((check) => check.status), [
    'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok',
  ]);

  const rendered = renderShipCheckReport(report);
  assert.match(rendered, /AgentLink Ship Check/);
  assert.match(rendered, /\[ok\] package bins: agentlink, agentlink-mcp/);
  assert.match(rendered, /\[ok\] package files allowlist:/);
  assert.match(rendered, /\[ok\] npm bin executability:/);
  assert.match(rendered, /\[ok\] release notes artifact:/);
  assert.match(rendered, /\[ok\] installed tarball smoke: installed agentlink 0\.1\.0 and initialized agentlink-mcp from packed tarball/);
  assert.match(rendered, /Result: ready for final verified demo and human launch approval/);
});

test('ship check fails npm tarball bins that are not executable', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-bin-mode-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '0.1.0',
    description: 'Local-first coordination bus for coding agents working across repos through durable contracts.',
    license: 'MIT',
    homepage: 'https://github.com/sruthik27/agentlink#readme',
    repository: { type: 'git', url: 'git+https://github.com/sruthik27/agentlink.git' },
    bugs: { url: 'https://github.com/sruthik27/agentlink/issues' },
    engines: { node: '>=20' },
    publishConfig: { access: 'public' },
    bin: { agentlink: './dist/cli.js', 'agentlink-mcp': './dist/mcp/server.js' },
    files: ['README.md', 'LICENSE', 'CHANGELOG.md', 'release-notes-v0.1.0.md', 'demos/agentlink-demo.gif', 'demos/agentlink-demo.cast', 'dist/**/*.js', 'dist/**/*.d.ts'],
    scripts: { agentlink: 'node dist/cli.js', build: 'tsc -p tsconfig.json', test: 'node --test' },
    keywords: ['mcp', 'tmux', 'multi-agent'],
  }), 'utf8');
  await writeFile(join(cwd, 'README.md'), [
    '# AgentLink',
    'npx agentlink doctor',
    'npm install -g agentlink',
    'agentlink setup --harness all',
    'cross-repo contract negotiation',
    'Structured bus is source of truth',
    'tmux pane messaging is notification/bridge',
    'npm run agentlink -- setup',
    'npm run agentlink -- doctor',
    'npm run agentlink -- ship-check',
    'npm run agentlink -- demo --peer ../peer-repo',
    'npm run agentlink -- replay',
    'npm run agentlink -- version',
    'npm run agentlink -- launch-brief',
    'node dist/mcp/server.js',
    '![AgentLink terminal demo](demos/agentlink-demo.gif)',
    'asciinema play demos/agentlink-demo.cast',
    'release-notes-v0.1.0.md',
  ].join('\n'), 'utf8');
  await writeFile(join(cwd, 'LICENSE'), 'MIT\n', 'utf8');
  await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
  await writeFile(join(cwd, 'release-notes-v0.1.0.md'), [
    '## AgentLink 0.1.0',
    '### Verification before release',
    'Local tests passed.',
    '### Known limitation',
    'GitHub Actions did not run.',
  ].join('\n'), 'utf8');
  await mkdir(join(cwd, 'dist', 'mcp'), { recursive: true });
  await mkdir(join(cwd, 'demos'), { recursive: true });
  await writeFile(join(cwd, 'dist', 'cli.js'), '', 'utf8');
  await writeFile(join(cwd, 'dist', 'mcp', 'server.js'), '', 'utf8');
  await chmod(join(cwd, 'dist', 'cli.js'), 0o644);
  await chmod(join(cwd, 'dist', 'mcp', 'server.js'), 0o644);
  await writeFile(join(cwd, 'demos', 'agentlink-demo.gif'), validGif);
  await writeFile(join(cwd, 'demos', 'agentlink-demo.cast'), validCast, 'utf8');

  const report = await collectShipCheckReport(cwd);
  const binExecutableCheck = report.checks.find((check) => check.label === 'npm bin executability');
  assert.equal(binExecutableCheck?.status, 'fail');
  assert.match(binExecutableCheck?.detail ?? '', /dist\/cli\.js not executable/);
  assert.match(binExecutableCheck?.detail ?? '', /dist\/mcp\/server\.js not executable/);
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
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'publication metadata'));
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'README command coverage'));
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'README install UX'));
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'README demo media'));
  assert.ok(report.checks.some((check) => check.status === 'fail' && check.label === 'release notes artifact'));
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

test('ship check derives the required release notes artifact from package version', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-release-version-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '0.2.0',
    license: 'MIT',
    bin: { agentlink: './dist/cli.js', 'agentlink-mcp': './dist/mcp/server.js' },
    files: ['README.md', 'LICENSE', 'CHANGELOG.md', 'release-notes-v0.1.0.md', 'dist/**/*.js', 'dist/**/*.d.ts'],
    scripts: { agentlink: 'node dist/cli.js', build: 'tsc -p tsconfig.json', test: 'node --test' },
    keywords: ['mcp', 'tmux', 'multi-agent'],
  }), 'utf8');
  await writeFile(join(cwd, 'README.md'), [
    '# AgentLink',
    'npx agentlink doctor',
    'npm install -g agentlink',
    'agentlink setup --harness all',
    'cross-repo contract negotiation',
    'Structured bus is source of truth',
    'tmux pane messaging is notification/bridge',
    'npm run agentlink -- setup',
    'npm run agentlink -- doctor',
    'npm run agentlink -- ship-check',
    'npm run agentlink -- demo --peer ../peer-repo',
    'npm run agentlink -- replay',
    'npm run agentlink -- version',
    'npm run agentlink -- launch-brief',
    'node dist/mcp/server.js',
    '![AgentLink terminal demo](demos/agentlink-demo.gif)',
    'asciinema play demos/agentlink-demo.cast',
    'release-notes-v0.1.0.md',
  ].join('\n'), 'utf8');
  await writeFile(join(cwd, 'release-notes-v0.1.0.md'), [
    '## AgentLink 0.1.0',
    '### Verification before release',
    'Local tests passed.',
    '### Known limitation',
    'GitHub Actions did not run.',
  ].join('\n'), 'utf8');

  const report = await collectShipCheckReport(cwd);
  const packageFiles = report.checks.find((check) => check.label === 'package files allowlist');
  const releaseNotes = report.checks.find((check) => check.label === 'release notes artifact');
  const packDryRun = report.checks.find((check) => check.label === 'npm pack dry-run');
  assert.equal(packageFiles?.status, 'fail');
  assert.match(packageFiles?.detail ?? '', /release notes/);
  assert.equal(releaseNotes?.status, 'fail');
  assert.match(releaseNotes?.detail ?? '', /release-notes-v0\.2\.0\.md/);
  assert.equal(packDryRun?.status, 'fail');
  assert.match(packDryRun?.detail ?? '', /release-notes-v0\.2\.0\.md/);
});

test('ship check fails corrupt demo media', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-demo-media-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink',
    version: '0.1.0',
    description: 'Local-first coordination bus for coding agents working across repos through durable contracts.',
    license: 'MIT',
    homepage: 'https://github.com/sruthik27/agentlink#readme',
    repository: { type: 'git', url: 'git+https://github.com/sruthik27/agentlink.git' },
    bugs: { url: 'https://github.com/sruthik27/agentlink/issues' },
    engines: { node: '>=20' },
    publishConfig: { access: 'public' },
    bin: { agentlink: './dist/cli.js', 'agentlink-mcp': './dist/mcp/server.js' },
    files: ['README.md', 'LICENSE', 'CHANGELOG.md', 'release-notes-v0.1.0.md', 'demos/agentlink-demo.gif', 'demos/agentlink-demo.cast', 'dist/**/*.js', 'dist/**/*.d.ts'],
    scripts: { agentlink: 'node dist/cli.js', build: 'tsc -p tsconfig.json', test: 'node --test' },
    keywords: ['mcp', 'tmux', 'multi-agent'],
  }), 'utf8');
  await writeFile(join(cwd, 'README.md'), [
    '# AgentLink',
    'npx agentlink doctor',
    'npm install -g agentlink',
    'agentlink setup --harness all',
    'cross-repo contract negotiation',
    'Structured bus is source of truth',
    'tmux pane messaging is notification/bridge',
    'npm run agentlink -- setup',
    'npm run agentlink -- doctor',
    'npm run agentlink -- ship-check',
    'npm run agentlink -- demo --peer ../peer-repo',
    'npm run agentlink -- replay',
    'npm run agentlink -- version',
    'npm run agentlink -- launch-brief',
    'node dist/mcp/server.js',
    '![AgentLink terminal demo](demos/agentlink-demo.gif)',
    'asciinema play demos/agentlink-demo.cast',
    'release-notes-v0.1.0.md',
  ].join('\n'), 'utf8');
  await writeFile(join(cwd, 'LICENSE'), 'MIT\n', 'utf8');
  await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
  await writeFile(join(cwd, 'release-notes-v0.1.0.md'), [
    '## AgentLink 0.1.0',
    '### Verification before release',
    'Local tests passed.',
    '### Known limitation',
    'GitHub Actions did not run.',
  ].join('\n'), 'utf8');
  await mkdir(join(cwd, 'dist', 'mcp'), { recursive: true });
  await mkdir(join(cwd, 'demos'), { recursive: true });
  await writeFile(join(cwd, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log(\'0.1.0\');\n', 'utf8');
  await writeFile(join(cwd, 'dist', 'mcp', 'server.js'), fakeMcpServer(), 'utf8');
  await chmod(join(cwd, 'dist', 'cli.js'), 0o755);
  await chmod(join(cwd, 'dist', 'mcp', 'server.js'), 0o755);
  await writeFile(join(cwd, 'demos', 'agentlink-demo.gif'), 'not a gif', 'utf8');
  await writeFile(join(cwd, 'demos', 'agentlink-demo.cast'), 'not json', 'utf8');

  const report = await collectShipCheckReport(cwd);
  const demoMedia = report.checks.find((check) => check.label === 'README demo media');
  assert.equal(demoMedia?.status, 'fail');
  assert.match(demoMedia?.detail ?? '', /GIF header/);
  assert.match(demoMedia?.detail ?? '', /agentlink-demo\.cast/);
});

test('ship check fails when installed MCP server version mismatches package version', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-mcp-version-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'agentlink', version: '0.2.0', description: 'Local-first coordination bus for coding agents working across repos through durable contracts.', license: 'MIT',
    homepage: 'https://github.com/sruthik27/agentlink#readme', repository: { type: 'git', url: 'git+https://github.com/sruthik27/agentlink.git' }, bugs: { url: 'https://github.com/sruthik27/agentlink/issues' },
    engines: { node: '>=20' }, publishConfig: { access: 'public' }, bin: { agentlink: './dist/cli.js', 'agentlink-mcp': './dist/mcp/server.js' },
    files: ['README.md', 'LICENSE', 'CHANGELOG.md', 'release-notes-v0.2.0.md', 'demos/agentlink-demo.gif', 'demos/agentlink-demo.cast', 'dist/**/*.js', 'dist/**/*.d.ts'],
    scripts: { agentlink: 'node dist/cli.js', build: 'tsc -p tsconfig.json', test: 'node --test' }, keywords: ['mcp', 'tmux', 'multi-agent'],
  }), 'utf8');
  await writeFile(join(cwd, 'README.md'), ['# AgentLink','npx agentlink doctor','npm install -g agentlink','agentlink setup --harness all','cross-repo contract negotiation','Structured bus is source of truth','tmux pane messaging is notification/bridge','npm run agentlink -- setup','npm run agentlink -- doctor','npm run agentlink -- ship-check','npm run agentlink -- demo --peer ../peer-repo','npm run agentlink -- replay','npm run agentlink -- version','npm run agentlink -- launch-brief','node dist/mcp/server.js','![AgentLink terminal demo](demos/agentlink-demo.gif)','asciinema play demos/agentlink-demo.cast','release-notes-v0.2.0.md'].join('\n'), 'utf8');
  await writeFile(join(cwd, 'LICENSE'), 'MIT\n', 'utf8');
  await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
  await writeFile(join(cwd, 'release-notes-v0.2.0.md'), '## AgentLink 0.2.0\n### Verification before release\nLocal tests passed.\n### Known limitation\nGitHub Actions did not run.\n', 'utf8');
  await mkdir(join(cwd, 'dist', 'mcp'), { recursive: true });
  await mkdir(join(cwd, 'demos'), { recursive: true });
  await writeFile(join(cwd, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log(\'0.2.0\');\n', 'utf8');
  await writeFile(join(cwd, 'dist', 'mcp', 'server.js'), fakeMcpServer('0.1.0'), 'utf8');
  await chmod(join(cwd, 'dist', 'cli.js'), 0o755);
  await chmod(join(cwd, 'dist', 'mcp', 'server.js'), 0o755);
  await writeFile(join(cwd, 'demos', 'agentlink-demo.gif'), validGif);
  await writeFile(join(cwd, 'demos', 'agentlink-demo.cast'), validCast, 'utf8');

  const report = await collectShipCheckReport(cwd);
  const smoke = report.checks.find((check) => check.label === 'installed tarball smoke');
  assert.equal(smoke?.status, 'fail');
  assert.match(smoke?.detail ?? '', /did not match package version 0\.2\.0/);
});

test('ship check fails when launch release notes are ignored by git', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-ship-check-gitignore-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await execFileAsync('git', ['init'], { cwd });
  await writeFile(join(cwd, '.gitignore'), 'release-notes-v*.md\n', 'utf8');
  await writeFile(join(cwd, 'README.md'), [
    '# AgentLink',
    'npx agentlink doctor',
    'npm install -g agentlink',
    'agentlink setup --harness all',
    'cross-repo contract negotiation',
    'Structured bus is source of truth',
    'tmux pane messaging is notification/bridge',
    'npm run agentlink -- setup',
    'npm run agentlink -- doctor',
    'npm run agentlink -- ship-check',
    'npm run agentlink -- demo --peer ../peer-repo',
    'npm run agentlink -- replay',
    'npm run agentlink -- version',
    'npm run agentlink -- launch-brief',
    'node dist/mcp/server.js',
    '![AgentLink terminal demo](demos/agentlink-demo.gif)',
    'asciinema play demos/agentlink-demo.cast',
    'release-notes-v0.1.0.md',
  ].join('\n'), 'utf8');
  await writeFile(join(cwd, 'release-notes-v0.1.0.md'), [
    '## AgentLink 0.1.0',
    '### Verification before release',
    'Local tests passed.',
    '### Known limitation',
    'GitHub Actions did not run.',
  ].join('\n'), 'utf8');

  const report = await collectShipCheckReport(cwd);
  const gitTracking = report.checks.find((check) => check.label === 'release notes git ignore');
  assert.equal(gitTracking?.status, 'fail');
  assert.match(gitTracking?.detail ?? '', /ignored by git/);
});
