import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRepoContext, renderRepoContextMarkdown, type CommandRunner } from './context.js';

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentlink-context-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('repo context summarizes git/package metadata without file lists or source content', async (t) => {
  const cwd = await temporaryWorkspace(t);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    name: 'producer-api',
    version: '0.2.0',
    scripts: {
      test: 'node --test',
      build: 'tsc',
    },
  }), 'utf8');

  const runner: CommandRunner = async (_command, args) => {
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return { stdout: `${cwd}\n`, stderr: '' };
    if (key === 'branch --show-current') return { stdout: 'feature/contracts\n', stderr: '' };
    if (key === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
    if (key === 'status --porcelain') return { stdout: ' M src/api.ts\n?? CONTRACT.md\n', stderr: '' };
    throw new Error(`unexpected git args: ${key}`);
  };

  const summary = await collectRepoContext(cwd, runner);

  assert.deepEqual(summary, {
    workspaceName: cwd.split('/').at(-1),
    path: cwd,
    git: {
      isRepo: true,
      root: cwd,
      branch: 'feature/contracts',
      commit: 'abc1234',
      dirtyFiles: 2,
    },
    package: {
      name: 'producer-api',
      version: '0.2.0',
      scripts: ['build', 'test'],
    },
  });

  const markdown = renderRepoContextMarkdown(summary);
  assert.match(markdown, /# AgentLink Repo Context/);
  assert.match(markdown, /- Workspace: agentlink-context-/);
  assert.match(markdown, /- Branch: feature\/contracts/);
  assert.match(markdown, /- Commit: abc1234/);
  assert.match(markdown, /- Dirty files: 2/);
  assert.match(markdown, /- Scripts: build, test/);
  assert.doesNotMatch(markdown, /src\/api\.ts/);
  assert.doesNotMatch(markdown, /CONTRACT\.md/);
});

test('repo context handles non-git workspaces and missing package metadata', async (t) => {
  const cwd = await temporaryWorkspace(t);
  const runner: CommandRunner = async () => {
    throw new Error('not a git repo');
  };

  const summary = await collectRepoContext(cwd, runner);

  assert.equal(summary.git.isRepo, false);
  assert.equal(summary.git.dirtyFiles, 0);
  assert.equal(summary.package, undefined);
  assert.match(renderRepoContextMarkdown(summary), /- Git: not a repository/);
});
