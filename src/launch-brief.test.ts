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
    name: 'agentlink',
    version: '0.1.0',
  }), 'utf8');

  const brief = await collectLaunchBrief(cwd);
  assert.equal(brief.packageName, 'agentlink');
  assert.equal(brief.version, '0.1.0');
  assert.equal(brief.approvalRequired, true);
  assert.match(brief.productThesis, /cross-repo contract negotiation/);
  assert.ok(brief.verificationCommands.includes('npm test'));
  assert.ok(brief.launchArtifacts.includes('agentlink ship-check launch-readiness gate'));
  assert.match(brief.launchBoundary, /without explicit Sruthik approval/);

  const markdown = renderLaunchBriefMarkdown(brief);
  assert.match(markdown, /# AgentLink Launch Approval Brief/);
  assert.match(markdown, /## Verification commands/);
  assert.match(markdown, /`npm run agentlink -- ship-check`/);
  assert.match(markdown, /## CEO decisions needed/);
});
