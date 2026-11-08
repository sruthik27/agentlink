import { mkdir, readFile, realpath, stat, rm, utimes } from 'node:fs/promises';
import { join, isAbsolute, relative, sep } from 'node:path';
import { atomicWriteFile, assertNotSymlink, withFileLock } from '../atomic.js';
import { sha256 } from './types.js';
import { withWorkArtifactBudget,allocateWorkUpload } from './work-storage.js';

export interface WorkArtifact {
  digest: string; bytes: number; name: string; mediaType: string;
}
export const MAX_WORK_ARTIFACT_BYTES = 1024 * 1024;
export const WORK_ARTIFACT_PART_BYTES = 32768;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export function workPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || isAbsolute(value) || value.includes('\\') || value.includes('\0')
    || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Work path must be a relative path without traversal');
  return value;
}

export function parseWorkArtifact(value: unknown): WorkArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid work artifact');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'bytes,digest,mediaType,name' || typeof v.digest !== 'string' || !digestPattern.test(v.digest)
    || !Number.isSafeInteger(v.bytes) || (v.bytes as number) < 0 || (v.bytes as number) > MAX_WORK_ARTIFACT_BYTES
    || typeof v.mediaType !== 'string' || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(v.mediaType)) throw new Error('Invalid work artifact');
  return { digest: v.digest, bytes: v.bytes as number, name: workPath(v.name), mediaType: v.mediaType };
}

async function artifactDirectory(root: string): Promise<string> {
  const canonical = await realpath(root);
  const directory = join(canonical, 'work-artifacts');
  await assertNotSymlink(directory, 'Work artifacts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Content is an explicit export. This function never discovers or reads repository files. */
export async function putWorkArtifact(root: string, content: Uint8Array, name: string, mediaType = 'application/octet-stream'): Promise<WorkArtifact> {
  if (content.byteLength > MAX_WORK_ARTIFACT_BYTES) throw new Error('Work artifact exceeds 1 MiB');
  const bytes = Buffer.from(content);
  const ref = parseWorkArtifact({ name, mediaType, bytes: bytes.length, digest: sha256(bytes) });
  const directory = await artifactDirectory(root), path = join(directory, ref.digest.slice(7) + '.json');
  await withFileLock(join(directory, 'locks'), ref.digest.slice(7), async () => {
    await assertNotSymlink(path, 'Work artifact');
    try { await stat(path); await getWorkArtifact(root, ref);await withWorkArtifactBudget(root,0,0,()=>utimes(path,new Date(),new Date())); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const content=JSON.stringify({ version: 1, name:ref.name,data: bytes.toString('base64') });
    await withWorkArtifactBudget(root,Buffer.byteLength(content),1,()=>atomicWriteFile(path,content));
  });
  return ref;
}

export async function getWorkArtifact(root: string, value: unknown): Promise<Buffer> {
  const ref = parseWorkArtifact(value), directory = await artifactDirectory(root);
  const path = join(directory, ref.digest.slice(7) + '.json');
  await assertNotSymlink(path, 'Work artifact');
  if ((await stat(path)).size > MAX_WORK_ARTIFACT_BYTES * 2) throw new Error('Stored work artifact exceeds quota');
  const record = JSON.parse(await readFile(path, 'utf8')) as { version: number; data: string };
  if (record.version !== 1 || typeof record.data !== 'string') throw new Error('Invalid stored work artifact');
  const bytes = Buffer.from(record.data, 'base64');
  if (bytes.toString('base64') !== record.data || bytes.length !== ref.bytes || sha256(bytes) !== ref.digest) throw new Error('Work artifact digest/size mismatch');
  return bytes;
}

export async function exportWorkFile(root: string, workspace: string, path: string, allowedPaths: string[]): Promise<WorkArtifact> {
  const selected = workPath(path);
  if (!allowedPaths.some(prefix => selected === workPath(prefix) || selected.startsWith(workPath(prefix) + '/'))) throw new Error('Work export outside locally authorized paths');
  const base = await realpath(workspace), file = await realpath(join(base, selected)), rel = relative(base, file);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Work export escapes workspace');
  await assertNotSymlink(join(base, selected), 'Work export');
  if (!(await stat(file)).isFile() || (await stat(file)).size > MAX_WORK_ARTIFACT_BYTES) throw new Error('Work export must be a file within the size limit');
  return putWorkArtifact(root, await readFile(file), selected);
}

export async function getWorkArtifactPart(root: string, value: unknown, offset: number): Promise<{ data: string; nextOffset: number; complete: boolean }> {
  const ref = parseWorkArtifact(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > ref.bytes || offset % WORK_ARTIFACT_PART_BYTES !== 0) throw new Error('Invalid artifact part offset');
  const bytes = await getWorkArtifact(root, ref), part = bytes.subarray(offset, offset + WORK_ARTIFACT_PART_BYTES);
  return { data: part.toString('base64'), nextOffset: offset + part.length, complete: offset + part.length === bytes.length };
}

/** Retries are content-addressed; no artifact becomes readable before all bytes verify. */
export async function putWorkArtifactPart(root: string, value: unknown, offset: number, data: string): Promise<{ complete: boolean }> {
  const ref = parseWorkArtifact(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > Math.max(0, ref.bytes - 1) || offset % WORK_ARTIFACT_PART_BYTES !== 0
    || typeof data !== 'string' || data.length > WORK_ARTIFACT_PART_BYTES * 2) throw new Error('Invalid artifact part');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || bytes.length !== Math.min(WORK_ARTIFACT_PART_BYTES, ref.bytes - offset)) throw new Error('Invalid artifact part size or encoding');
  const directory = await artifactDirectory(root), incoming = join(directory, 'incoming');
  await assertNotSymlink(incoming, 'Incoming work artifacts'); await mkdir(incoming, { recursive: true, mode: 0o700 });
  return withFileLock(join(directory, 'locks'), 'upload-' + ref.digest.slice(7), async () => {
    try { await getWorkArtifact(root, ref); return { complete: true }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const staging = join(incoming, ref.digest.slice(7)); await assertNotSymlink(staging, 'Work upload');
    await allocateWorkUpload(root,staging);
    const part = join(staging, offset + '.json'); await assertNotSymlink(part, 'Work upload part');
    try { if (await readFile(part, 'utf8') !== data) throw new Error('Conflicting work artifact part retry'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await atomicWriteFile(part, data); }
    const chunks: Buffer[] = [];
    for (let position = 0; position < Math.max(1, ref.bytes); position += WORK_ARTIFACT_PART_BYTES) {
      const file = join(staging, position + '.json'); await assertNotSymlink(file, 'Work upload part');
      try { chunks.push(Buffer.from(await readFile(file, 'utf8'), 'base64')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { complete: false }; throw error; }
    }
    const content = Buffer.concat(chunks);
    if (content.length !== ref.bytes || sha256(content) !== ref.digest) throw new Error('Assembled work artifact digest/size mismatch');
    await putWorkArtifact(root, content, ref.name, ref.mediaType);
    await rm(staging, { recursive: true });
    return { complete: true };
  });
}
