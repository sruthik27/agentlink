import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

export async function assertNotSymlink(path: string, label: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await assertNotSymlink(dirname(path), 'State directory');
  await assertNotSymlink(path, 'State file');
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface LockOwner {
  pid: number;
  token?: string;
  acquiredAt?: string;
}

interface LockSnapshot {
  owner: LockOwner | undefined;
  mtimeMs: number;
  identity: string;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const details = await lstat(lockPath);
    if (details.isSymbolicLink()) throw new Error(`Lock must not be a symbolic link: ${lockPath}`);
    const ownerPath = details.isDirectory() ? join(lockPath, 'owner.json') : lockPath;
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Partial<LockOwner>;
    if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) return undefined;
    return owner as LockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function lockOwnerIsAlive(owner: LockOwner | undefined): boolean {
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readReclaimOwner(claimPath: string): Promise<LockOwner | undefined> {
  try {
    const details = await lstat(claimPath);
    if (details.isSymbolicLink()) throw new Error(`Reclaim claim must not be a symbolic link: ${claimPath}`);
    const owner = JSON.parse(await readFile(claimPath, 'utf8')) as Partial<LockOwner>;
    if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) return undefined;
    if (typeof owner.token !== 'string' || owner.token.length === 0) return undefined;
    return owner as LockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function digestIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot> {
  const details = await stat(lockPath);
  const owner = await readLockOwner(lockPath);
  const identitySource = typeof owner?.token === 'string' && owner.token.length > 0
    ? `token:${owner.token}`
    : `legacy:${details.dev}:${details.ino}:${details.birthtimeMs}`;
  return { owner, mtimeMs: details.mtimeMs, identity: digestIdentity(identitySource) };
}

interface ReclaimClaim {
  path: string;
  token: string;
}

async function acquireReclaimClaim(claimRoot: string, staleMs: number): Promise<ReclaimClaim | undefined> {
  const token = randomUUID();
  const candidatePath = `${claimRoot}.candidate-${token}`;
  await atomicWriteFile(candidatePath, `${JSON.stringify({
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
  })}\n`);
  try {
    let claimPath = claimRoot;
    for (;;) {
      try {
        await link(candidatePath, claimPath);
        return { path: claimPath, token };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const details = await lstat(claimPath);
      if (details.isSymbolicLink()) throw new Error(`Reclaim claim must not be a symbolic link: ${claimPath}`);
      const owner = await readReclaimOwner(claimPath);
      if (lockOwnerIsAlive(owner)) return undefined;
      if (owner === undefined && Date.now() - details.mtimeMs <= staleMs) return undefined;

      const barrierDirectory = process.env.AGENTLINK_TEST_RECLAIM_CLAIM_BARRIER_DIRECTORY;
      if (barrierDirectory) {
        await atomicWriteFile(join(barrierDirectory, 'ready'), `${process.pid}\n`);
        while (await readUtf8IfExists(join(barrierDirectory, 'continue')) === undefined) await delay(1);
      }

      const current = await lstat(claimPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (current === undefined || current.dev !== details.dev || current.ino !== details.ino) {
        claimPath = claimRoot;
        continue;
      }
      const predecessorIdentity = typeof owner?.token === 'string' && owner.token.length > 0
        ? `token:${owner.token}`
        : `legacy:${details.dev}:${details.ino}:${details.birthtimeMs}`;
      claimPath = `${claimRoot}.successor-${digestIdentity(predecessorIdentity)}`;
    }
  } finally {
    await rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

async function cleanupReclaimClaims(claimRoot: string): Promise<void> {
  const directory = dirname(claimRoot);
  const prefix = claimRoot.slice(directory.length + 1);
  const entries = await readdir(directory).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry === prefix || entry.startsWith(`${prefix}.successor`))
    .map((entry) => rm(join(directory, entry), { force: true }).catch(() => undefined)));
}

async function releaseOwnedReclaimClaim(claim: ReclaimClaim): Promise<void> {
  // The claim was published from an immutable private inode. While this
  // process is alive, cooperative reclaimers treat it as live and cannot
  // create a successor, so no ownership-blind read-then-remove is needed.
  await rm(claim.path, { force: true });
}

async function reclaimStaleLock(lockPath: string, staleMs: number, observed: LockSnapshot): Promise<boolean> {
  const claimRoot = `${lockPath}.reclaim-${observed.identity}`;
  const claim = await acquireReclaimClaim(claimRoot, staleMs);
  if (claim === undefined) return false;
  const legacyClaimRoot = `${lockPath}.reclaim`;
  let legacyClaim: ReclaimClaim | undefined;
  try {
    await lstat(legacyClaimRoot);
    legacyClaim = await acquireReclaimClaim(legacyClaimRoot, staleMs);
    if (legacyClaim === undefined) {
      await releaseOwnedReclaimClaim(claim);
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await releaseOwnedReclaimClaim(claim);
      throw error;
    }
  }
  const quarantine = `${lockPath}.reclaimed-${randomUUID()}`;
  let removedIncarnation = false;
  try {
    const barrierDirectory = process.env.AGENTLINK_TEST_RECLAIM_BARRIER_DIRECTORY;
    if (barrierDirectory) {
      await atomicWriteFile(join(barrierDirectory, 'ready'), `${process.pid}\n`);
      while (await readUtf8IfExists(join(barrierDirectory, 'continue')) === undefined) await delay(1);
    }
    const current = await readLockSnapshot(lockPath);
    if (current.identity !== observed.identity) return false;
    if (lockOwnerIsAlive(current.owner)) return false;
    if (current.owner === undefined && Date.now() - current.mtimeMs <= staleMs) return false;
    await rename(lockPath, quarantine);
    removedIncarnation = true;
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    // Claim paths are immutable while an incarnation is present. They are
    // removed only after that incarnation is gone; a crashed claimant is
    // superseded through a unique successor path rather than path replacement.
    if (removedIncarnation) {
      await cleanupReclaimClaims(claimRoot);
      if (legacyClaim) await cleanupReclaimClaims(legacyClaimRoot);
    } else {
      await releaseOwnedReclaimClaim(claim);
      if (legacyClaim) await releaseOwnedReclaimClaim(legacyClaim);
    }
  }
}

export async function readUtf8IfExists(path: string): Promise<string | undefined> {
  try {
    await assertNotSymlink(path, 'State file');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function withFileLock<T>(
  locksDirectory: string,
  key: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(key)) throw new Error(`Invalid lock key: ${key}`);
  const timeoutMs = options.timeoutMs ?? 2_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 15;
  await mkdir(locksDirectory, { recursive: true });
  await assertNotSymlink(locksDirectory, 'Locks directory');
  const lockPath = join(locksDirectory, `${key}.lock`);
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  const candidatePath = join(locksDirectory, `.${key}.candidate-${ownerToken}`);

  for (;;) {
    try {
      await atomicWriteFile(candidatePath, `${JSON.stringify({
        pid: process.pid,
        token: ownerToken,
        acquiredAt: new Date().toISOString(),
      })}\n`);
      await link(candidatePath, lockPath);
      await rm(candidatePath, { force: true });
      break;
    } catch (error) {
      await rm(candidatePath, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await assertNotSymlink(lockPath, 'Lock');
      try {
        const snapshot = await readLockSnapshot(lockPath);
        const deadRecordedOwner = snapshot.owner !== undefined && !lockOwnerIsAlive(snapshot.owner);
        const staleOwnerlessLock = snapshot.owner === undefined && Date.now() - snapshot.mtimeMs > staleMs;
        if ((deadRecordedOwner || staleOwnerlessLock)
          && await reclaimStaleLock(lockPath, staleMs, snapshot)) continue;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out acquiring lock ${key} after ${timeoutMs}ms`);
      }
      await delay(retryMs);
    }
  }

  try {
    return await operation();
  } finally {
    const owner = await readLockOwner(lockPath).catch(() => undefined);
    if (owner?.token === ownerToken) await rm(lockPath, { force: true });
    await rm(candidatePath, { force: true }).catch(() => undefined);
  }
}
