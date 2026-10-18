import { X509Certificate } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { assertNotSymlink, atomicWriteFile, readUtf8IfExists } from '../atomic.js';
import { NETWORK_SCHEMA_VERSION, type NodeIdentity, type NodePublicIdentity, validateNetworkId } from './types.js';

const execFileAsync = promisify(execFile);
const IDENTITY_DIRECTORY = 'identity';
const METADATA_FILE = 'identity.json';
const CERTIFICATE_FILE = 'certificate.pem';
const PRIVATE_KEY_FILE = 'private-key.pem';

interface IdentityMetadata {
  version: 1;
  nodeId: string;
  fingerprint: string;
}

interface SecurePathSnapshot {
  dev: number;
  ino: number;
}

function requireSecureDetails(
  details: Stats,
  path: string,
  label: string,
  kind: 'directory' | 'file',
  expectedMode: number,
): SecurePathSnapshot {
  if (details.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (kind === 'directory' ? !details.isDirectory() : !details.isFile()) {
    throw new Error(`${label} must be a regular ${kind}: ${path}`);
  }
  if ((details.mode & 0o777) !== expectedMode) {
    throw new Error(`${label} has unsafe permissions; expected ${expectedMode.toString(8)}: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && details.uid !== uid) throw new Error(`${label} is not owned by the current user: ${path}`);
  return { dev: details.dev, ino: details.ino };
}

async function requireSecurePath(
  path: string,
  label: string,
  kind: 'directory' | 'file',
  expectedMode: number,
  expected?: SecurePathSnapshot,
): Promise<SecurePathSnapshot> {
  const snapshot = requireSecureDetails(await lstat(path), path, label, kind, expectedMode);
  if (expected && (snapshot.dev !== expected.dev || snapshot.ino !== expected.ino)) {
    throw new Error(`${label} changed while loading node identity: ${path}`);
  }
  return snapshot;
}

async function openSecureFile(
  path: string,
  label: string,
  expected: SecurePathSnapshot,
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} must not be a symbolic link: ${path}`);
    }
    throw error;
  }
  try {
    const snapshot = requireSecureDetails(await handle.stat(), path, label, 'file', 0o600);
    if (snapshot.dev !== expected.dev || snapshot.ino !== expected.ino) {
      throw new Error(`${label} changed while loading node identity: ${path}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openSecureFiles(
  files: Array<{ path: string; label: string; expected: SecurePathSnapshot }>,
): Promise<FileHandle[]> {
  const handles: FileHandle[] = [];
  try {
    for (const file of files) handles.push(await openSecureFile(file.path, file.label, file.expected));
    return handles;
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
}

function certificateFingerprint(certificatePem: string): string {
  const hex = new X509Certificate(certificatePem).fingerprint256.replaceAll(':', '').toLowerCase();
  return `sha256:${hex}`;
}

async function requireOpenSsl(): Promise<void> {
  try {
    await execFileAsync('openssl', ['version'], { timeout: 5_000 });
  } catch (error) {
    throw new Error(`OpenSSL is required to generate AgentLink node certificates: ${(error as Error).message}`);
  }
}

export async function initializeNodeIdentity(stateRoot: string, nodeIdValue: string): Promise<NodeIdentity> {
  const nodeId = validateNetworkId(nodeIdValue, 'nodeId');
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await assertNotSymlink(stateRoot, 'Network state root');
  await chmod(stateRoot, 0o700);
  const identityDirectory = join(stateRoot, IDENTITY_DIRECTORY);
  await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
  await assertNotSymlink(identityDirectory, 'Identity directory');
  await chmod(identityDirectory, 0o700);
  if (await readUtf8IfExists(join(identityDirectory, METADATA_FILE)) !== undefined) {
    const existing = await loadNodeIdentity(stateRoot);
    if (existing.nodeId !== nodeId) throw new Error(`Node identity already exists as ${existing.nodeId}`);
    return existing;
  }

  await requireOpenSsl();
  const keyPath = join(identityDirectory, PRIVATE_KEY_FILE);
  const certificatePath = join(identityDirectory, CERTIFICATE_FILE);
  try {
    const keyHandle = await open(keyPath, 'wx', 0o600);
    await keyHandle.close();
    const certificateHandle = await open(certificatePath, 'wx', 0o600);
    await certificateHandle.close();
    await execFileAsync('openssl', [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-x509', '-sha256', '-days', '3650',
      '-subj', `/CN=${nodeId}`, '-keyout', keyPath, '-out', certificatePath,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    await chmod(keyPath, 0o600);
    await chmod(certificatePath, 0o600);
    const certificatePem = await readFile(certificatePath, 'utf8');
    const metadata: IdentityMetadata = { version: NETWORK_SCHEMA_VERSION, nodeId, fingerprint: certificateFingerprint(certificatePem) };
    await atomicWriteFile(join(identityDirectory, METADATA_FILE), `${JSON.stringify(metadata)}\n`);
    return await loadNodeIdentity(stateRoot);
  } catch (error) {
    await rm(keyPath, { force: true });
    await rm(certificatePath, { force: true });
    throw error;
  }
}

export async function loadNodeIdentity(stateRoot: string): Promise<NodeIdentity> {
  const identityDirectory = join(stateRoot, IDENTITY_DIRECTORY);
  const metadataPath = join(identityDirectory, METADATA_FILE);
  const certificatePath = join(identityDirectory, CERTIFICATE_FILE);
  const privateKeyPath = join(identityDirectory, PRIVATE_KEY_FILE);
  const rootSnapshot = await requireSecurePath(stateRoot, 'Network state root', 'directory', 0o700);
  const directorySnapshot = await requireSecurePath(identityDirectory, 'Identity directory', 'directory', 0o700);
  const metadataSnapshot = await requireSecurePath(metadataPath, 'Identity metadata', 'file', 0o600);
  const certificateSnapshot = await requireSecurePath(certificatePath, 'Identity certificate', 'file', 0o600);
  const privateKeySnapshot = await requireSecurePath(privateKeyPath, 'Identity private key', 'file', 0o600);
  const handles = await openSecureFiles([
    { path: metadataPath, label: 'Identity metadata', expected: metadataSnapshot },
    { path: certificatePath, label: 'Identity certificate', expected: certificateSnapshot },
    { path: privateKeyPath, label: 'Identity private key', expected: privateKeySnapshot },
  ]);
  try {
    const [metadataContent, certificatePem, privateKeyPem] = await Promise.all(handles.map((handle) => handle.readFile('utf8')));
    await requireSecurePath(stateRoot, 'Network state root', 'directory', 0o700, rootSnapshot);
    await requireSecurePath(identityDirectory, 'Identity directory', 'directory', 0o700, directorySnapshot);
    await Promise.all([
      requireSecurePath(metadataPath, 'Identity metadata', 'file', 0o600, metadataSnapshot),
      requireSecurePath(certificatePath, 'Identity certificate', 'file', 0o600, certificateSnapshot),
      requireSecurePath(privateKeyPath, 'Identity private key', 'file', 0o600, privateKeySnapshot),
    ]);
    const metadata = JSON.parse(metadataContent) as Partial<IdentityMetadata>;
    if (metadata.version !== NETWORK_SCHEMA_VERSION) throw new Error('Unsupported node identity version');
    const nodeId = validateNetworkId(metadata.nodeId, 'nodeId');
    const fingerprint = certificateFingerprint(certificatePem);
    if (metadata.fingerprint !== fingerprint) throw new Error('Node certificate fingerprint does not match identity metadata');
    return { version: NETWORK_SCHEMA_VERSION, nodeId, fingerprint, certificatePem, privateKeyPem };
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

export async function exportPublicIdentity(stateRoot: string): Promise<NodePublicIdentity> {
  const { privateKeyPem: _privateKeyPem, ...publicIdentity } = await loadNodeIdentity(stateRoot);
  return publicIdentity;
}
