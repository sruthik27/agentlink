import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLaunchBrief, renderLaunchBriefMarkdown } from './launch-brief.js';

test('launch brief renders approval boundary, verification commands, and artifacts', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-launch-brief-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: '@sruthik/agentlink',
    version: '0.1.1',
  }), 'utf8');

  const brief = await collectLaunchBrief(cwd);
  assert.equal(brief.packageName, '@sruthik/agentlink');
  assert.equal(brief.version, '0.1.1');
  assert.equal(brief.approvalRequired, true);
  assert.match(brief.productThesis, /cross-repo contract negotiation/);
  assert.ok(brief.verificationCommands.includes('npm test'));
  assert.ok(brief.verificationCommands.includes('node dist/cli.js ship-check --format json'));
  assert.ok(brief.verificationCommands.includes('npm --silent pack --dry-run --json'));
  assert.ok(brief.launchArtifacts.includes('agentlink ship-check launch-readiness gate'));
  assert.ok(brief.launchArtifacts.includes('npm tarball dry-run/install smoke with agentlink and agentlink-mcp bins'));
  assert.ok(brief.launchArtifacts.includes('README demo GIF plus asciinema cast source'));
  assert.ok(brief.launchArtifacts.includes('release-notes-v0.1.1.md launch notes included in README and npm tarball'));
  assert.match(brief.demoCommands[0], /node .*dist\/cli\.js demo --peer/);
  assert.doesNotMatch(brief.demoCommands[0], /\/absolute\/path\/to\/agentlink/);
  assert.match(brief.launchBoundary, /without explicit Sruthik approval/);

  const markdown = renderLaunchBriefMarkdown(brief);
  assert.match(markdown, /# AgentLink Launch Approval Brief/);
  assert.match(markdown, /## Verification commands/);
  assert.match(markdown, /`npm run agentlink -- ship-check`/);
  assert.match(markdown, /`node dist\/cli\.js ship-check --format json`/);
  assert.match(markdown, /npm tarball dry-run\/install smoke/);
  assert.match(markdown, /## CEO decisions needed/);
});

test('launch brief derives release notes artifact from package version', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-launch-brief-versioned-notes-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: '@sruthik/agentlink',
    version: '0.2.0',
  }), 'utf8');

  const brief = await collectLaunchBrief(cwd);
  assert.ok(brief.launchArtifacts.includes('release-notes-v0.2.0.md launch notes included in README and npm tarball'));
  assert.ok(!brief.launchArtifacts.includes('release-notes-v0.1.1.md launch notes included in README and npm tarball'));
});
