import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectSetupGuide,
  parseSetupHarness,
  renderSetupGuideMarkdown,
} from './setup.js';

test('setup guide renders deterministic local MCP and harness instructions', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-setup-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: '@sruthik/agentlink',
    version: '0.1.1',
  }), 'utf8');

  const guide = await collectSetupGuide(cwd, 'claude-code');
  assert.equal(guide.packageName, '@sruthik/agentlink');
  assert.equal(guide.version, '0.1.1');
  assert.equal(guide.mcpCommand, 'agentlink-mcp');
  assert.deepEqual(guide.mcpArgs, []);
  assert.deepEqual(guide.harnesses, ['claude-code']);
  assert.match(guide.agentPrompt, /Keep repo source isolated/);

  const markdown = renderSetupGuideMarkdown(guide);
  assert.match(markdown, /# AgentLink Setup Guide/);
  assert.match(markdown, /claude mcp add -s user agentlink -- agentlink-mcp/);
  assert.doesNotMatch(markdown, /### Codex CLI/);
});

test('setup harness parser accepts supported harnesses and rejects unknown names', () => {
  assert.equal(parseSetupHarness('codex'), 'codex');
  assert.equal(parseSetupHarness('copilot'), 'copilot');
  assert.equal(parseSetupHarness('Gemini'), 'gemini');
  assert.equal(parseSetupHarness(' Claude-Code '), 'claude-code');
  assert.throws(
    () => parseSetupHarness('cursor'),
    /Invalid setup harness: cursor\. Expected one of: stdio, claude-code, codex, copilot, opencode, gemini/,
  );
});

test('setup guide includes Copilot and Gemini harness guidance when requested', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentlink-setup-harnesses-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const allGuide = await collectSetupGuide(cwd, 'all');
  assert.deepEqual(allGuide.harnesses, ['stdio', 'claude-code', 'codex', 'copilot', 'opencode', 'gemini']);
  const allMarkdown = renderSetupGuideMarkdown(allGuide);
  assert.match(allMarkdown, /### GitHub Copilot CLI/);
  assert.match(allMarkdown, /### Gemini CLI/);

  const geminiGuide = await collectSetupGuide(cwd, 'gemini');
  const geminiMarkdown = renderSetupGuideMarkdown(geminiGuide);
  assert.match(geminiMarkdown, /### Gemini CLI/);
  assert.doesNotMatch(geminiMarkdown, /### GitHub Copilot CLI/);
});
