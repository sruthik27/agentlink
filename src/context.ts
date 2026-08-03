import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<CommandResult>;

export interface PackageSummary {
  name?: string;
  version?: string;
  scripts: string[];
}

export interface RepoContextSummary {
  workspaceName: string;
  path: string;
  git: {
    isRepo: boolean;
    root?: string;
    branch?: string;
    commit?: string;
    dirtyFiles: number;
  };
  package?: PackageSummary;
}

const defaultRunner: CommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
};

async function tryRun(
  runner: CommandRunner,
  cwd: string,
  command: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const result = await runner(command, args, { cwd });
    const trimmed = result.stdout.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

async function readPackageSummary(cwd: string): Promise<PackageSummary | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
      scripts?: unknown;
    };
    const scripts = parsed.scripts && typeof parsed.scripts === 'object'
      ? Object.keys(parsed.scripts).sort()
      : [];
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      scripts,
    };
  } catch {
    return undefined;
  }
}

export async function collectRepoContext(
  cwd = process.cwd(),
  runner: CommandRunner = defaultRunner,
): Promise<RepoContextSummary> {
  const gitRoot = await tryRun(runner, cwd, 'git', ['rev-parse', '--show-toplevel']);
  const branch = gitRoot === undefined
    ? undefined
    : await tryRun(runner, cwd, 'git', ['branch', '--show-current']);
  const commit = gitRoot === undefined
    ? undefined
    : await tryRun(runner, cwd, 'git', ['rev-parse', '--short', 'HEAD']);
  const status = gitRoot === undefined
    ? undefined
    : await tryRun(runner, cwd, 'git', ['status', '--porcelain']);

  const packageSummary = await readPackageSummary(cwd);

  return {
    workspaceName: basename(gitRoot ?? cwd),
    path: cwd,
    git: {
      isRepo: gitRoot !== undefined,
      ...(gitRoot ? { root: gitRoot } : {}),
      ...(branch ? { branch } : {}),
      ...(commit ? { commit } : {}),
      dirtyFiles: status ? status.split('\n').filter(Boolean).length : 0,
    },
    ...(packageSummary ? { package: packageSummary } : {}),
  };
}

export function renderRepoContextMarkdown(summary: RepoContextSummary): string {
  const lines = [
    '# AgentLink Repo Context',
    '',
    `- Workspace: ${summary.workspaceName}`,
    `- Path: ${summary.path}`,
  ];

  if (summary.git.isRepo) {
    lines.push(`- Git root: ${summary.git.root}`);
    lines.push(`- Branch: ${summary.git.branch ?? 'unknown'}`);
    lines.push(`- Commit: ${summary.git.commit ?? 'unborn'}`);
    lines.push(`- Dirty files: ${summary.git.dirtyFiles}`);
  } else {
    lines.push('- Git: not a repository');
  }

  if (summary.package) {
    lines.push(`- Package: ${summary.package.name ?? 'unnamed'}${summary.package.version ? `@${summary.package.version}` : ''}`);
    lines.push(`- Scripts: ${summary.package.scripts.length === 0 ? 'none' : summary.package.scripts.join(', ')}`);
  }

  return `${lines.join('\n')}\n`;
}
