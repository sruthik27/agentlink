import { mkdir, realpath, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { atomicWriteFile, assertNotSymlink, withFileLock } from '../atomic.js';
import { validateNetworkId } from './types.js';
import { workPath } from './work-artifacts.js';
import { boundedWorkWrite } from './work-storage.js';

export type WorkPermission = 'read' | 'edit' | 'test';
export interface WorkScope { paths: string[]; permissions: WorkPermission[]; checks: string[]; }
export interface WorkPolicy extends WorkScope {
  version: 1; id: string; workspace: string; peerFingerprint: string; expiresAt: string; revoked: boolean;
}

export function parseWorkScope(value: unknown): WorkScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid work scope');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'checks,paths,permissions' || !Array.isArray(v.paths) || v.paths.length < 1 || v.paths.length > 64
    || !Array.isArray(v.permissions) || !v.permissions.length || v.permissions.some(p => !['read','edit','test'].includes(p))
    || !Array.isArray(v.checks) || v.checks.length > 32) throw new Error('Invalid work scope');
  const result: WorkScope = { paths: [...new Set(v.paths.map(workPath))], permissions: [...new Set(v.permissions)] as WorkPermission[], checks: [...new Set(v.checks.map(x => validateNetworkId(x, 'local check id')))] };
  if (result.checks.length && !result.permissions.includes('test')) throw new Error('Test checks require test permission');
  return result;
}

async function location(root: string, id: string): Promise<string> {
  const directory = join(await realpath(root), 'work-policies');
  await assertNotSymlink(directory, 'Work policies'); await mkdir(directory, { recursive: true, mode: 0o700 });
  return join(directory, validateNetworkId(id, 'policy id') + '.json');
}

export async function readWorkPolicy(root: string, id: string): Promise<WorkPolicy> {
  const file = await location(root, id); await assertNotSymlink(file, 'Local work policy');
  const p = JSON.parse(await readFile(file, 'utf8')) as WorkPolicy;
  if (p.version !== 1 || p.id !== id || typeof p.workspace !== 'string' || !isAbsolute(p.workspace)
    || !/^sha256:[a-f0-9]{64}$/.test(p.peerFingerprint) || typeof p.revoked !== 'boolean'
    || !Number.isFinite(Date.parse(p.expiresAt)) || new Date(p.expiresAt).toISOString() !== p.expiresAt) throw new Error('Invalid local work policy');
  parseWorkScope({ paths: p.paths, permissions: p.permissions, checks: p.checks });
  return p;
}

export async function revokeWorkPolicy(root: string, id: string): Promise<void> {
  await withFileLock(join(root, 'locks'), 'work-policy-' + validateNetworkId(id, 'policy id'), async () => {
    const p = await readWorkPolicy(root, id);
    await boundedWorkWrite(root,await location(root, id), JSON.stringify({ ...p, revoked: true }),true);
  });
}

/** Only a local owner-facing command may invoke this; never exposed as a peer/work operation. */
export async function writeWorkPolicy(root: string, input: WorkPolicy): Promise<void> {
  if (Object.keys(input).sort().join(',') !== 'checks,expiresAt,id,paths,peerFingerprint,permissions,revoked,version,workspace'
    || input.version !== 1 || typeof input.revoked !== 'boolean' || !/^sha256:[a-f0-9]{64}$/.test(input.peerFingerprint)) throw new Error('Invalid local work policy');
  const workspace = await realpath(input.workspace), state = await realpath(root), rel = relative(workspace, state);
  if (!isAbsolute(input.workspace) || !rel || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) throw new Error('Local work policy state must be outside its workspace');
  if (new Date(input.expiresAt).toISOString() !== input.expiresAt || Date.parse(input.expiresAt) <= Date.now()) throw new Error('Work policy expiry must be a future canonical timestamp');
  const scope = parseWorkScope({ paths: input.paths, permissions: input.permissions, checks: input.checks });
  const path = await location(root, input.id);
  await withFileLock(join(root, 'locks'), 'work-policy-' + input.id, () => boundedWorkWrite(root,path, JSON.stringify({ ...input, ...scope, workspace })));
}

export async function withWorkPolicy<T>(root: string, id: string, workspace: string, peerFingerprint: string, requested: WorkScope, operation: () => Promise<T>): Promise<T> {
  const canonical = await realpath(workspace);
  return withFileLock(join(root, 'locks'), 'work-policy-' + validateNetworkId(id, 'policy id'), async () => {
    const p = await readWorkPolicy(root, id);
    if (p.version !== 1 || p.id !== id || p.workspace !== canonical || p.peerFingerprint !== peerFingerprint || p.revoked || Date.parse(p.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error('Local work policy is expired, revoked or belongs to another workspace/peer');
    const allowed = parseWorkScope({ paths: p.paths, permissions: p.permissions, checks: p.checks }), scope = parseWorkScope(requested);
    if (scope.paths.some(path => !allowed.paths.some(prefix => path === prefix || path.startsWith(prefix + '/')))
      || scope.permissions.some(permission => !allowed.permissions.includes(permission)) || scope.checks.some(check => !allowed.checks.includes(check))) throw new Error('Work exceeds locally delegated policy; explicit owner decision required');
    return operation();
  });
}
