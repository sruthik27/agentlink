import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, stat, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { assertNotSymlink } from '../atomic.js';
import { workPath } from './work-artifacts.js';

const execute = promisify(execFile);
const fixedOptions = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.attributesFile=/dev/null', '-c', 'submodule.recurse=false'];

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Repository commands never enable hooks, fsmonitor, external diff or content filters. */
export async function workGit(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<Buffer> {
  const options = { cwd, env: gitEnvironment(), encoding: 'buffer' as const, maxBuffer, timeout: 15000 };
  let keys: string[] = [];
  try {
    const result = await execute('git', [...fixedOptions, 'config', '--null', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process|required)$'], options);
    keys = result.stdout.toString('utf8').split('\0').filter(Boolean);
  } catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
  const overrides = keys.flatMap(key => ['-c', key + (key.endsWith('.required') ? '=false' : '=')]);
  return (await execute('git', [...fixedOptions, ...overrides, ...args], options)).stdout;
}

export function selectedWorkPath(value: unknown): string {
  const path = workPath(value);
  if (path.split('/').some(part => part.toLowerCase() === '.git')) throw new Error('Git administrative paths are not work exports');
  return path;
}

export async function readSelectedFile(workspace: string, value: string): Promise<{ bytes: Buffer; executable: boolean } | null> {
  const path = selectedWorkPath(value), base = await realpath(workspace);
  let parent = base;
  for (const part of path.split('/')) { parent = join(parent, part); await assertNotSymlink(parent, 'Selected work path'); }
  try {
    const file = await realpath(join(base, path)), rel = relative(base, file);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Selected work path escapes workspace');
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Selected work file must be a regular file within 1 MiB');
    return { bytes: await readFile(file), executable: !!(info.mode & 0o111) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function workBaseFile(workspace: string, commit: string | null, path: string): Promise<{ bytes: Buffer; executable: boolean } | null> {
  if (!commit) return null;
  const entry = (await workGit(workspace, ['ls-tree', '-z', commit, '--', selectedWorkPath(path)])).toString('utf8').split('\0').filter(Boolean);
  if (!entry.length) return null;
  if (entry.length !== 1) throw new Error('Selected path must identify one regular file');
  const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(entry[0]!);
  if (!match) throw new Error('Symlinks, submodules and directories are not selected work files');
  return { bytes: await workGit(workspace, ['cat-file', 'blob', match[2]!], 1024 * 1024), executable: match[1] === '100755' };
}

export interface PatchFile { path: string; before: { bytes: Buffer; executable: boolean } | null; after: { bytes: Buffer; executable: boolean } | null; }

/** Construct a real Git binary/unified patch outside the source repository's attributes. */
export async function makeWorkPatch(files: PatchFile[]): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'agentlink-patch-'));
  try {
    for (const side of ['before', 'after'] as const) {
      await mkdir(join(directory, side));
      for (const file of files) if (file[side]) {
        const path = join(directory, side, selectedWorkPath(file.path));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file[side]!.bytes); await chmod(path, file[side]!.executable ? 0o755 : 0o644);
      }
    }
    let bytes: Buffer;
    try { bytes = await workGit(directory, ['diff', '--no-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--binary', '--', 'before', 'after'], 1024 * 1024); }
    catch (error) { if ((error as { code?: number }).code !== 1 || !Buffer.isBuffer((error as { stdout?: unknown }).stdout)) throw error; bytes = (error as { stdout: Buffer }).stdout; }
    return Buffer.from(bytes.toString('utf8').split('\n').map(line => /^(diff --git |--- |\+\+\+ |Binary files )/.test(line) ? line.replace(/([ab])\/(before|after)\//g, '$1/') : line).join('\n'));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
