import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { atomicWriteFile, assertNotSymlink, readUtf8IfExists, withFileLock } from './atomic.js';

interface TransactionWrite {
  path: string;
  content: string;
}

interface WriteTransaction {
  schemaVersion: 1;
  transactionId: string;
  key: string;
  createdAt: string;
  writes: TransactionWrite[];
}

function transactionsPath(busPath: string): string {
  return join(busPath, 'transactions');
}

function locksPath(busPath: string): string {
  return join(busPath, 'locks');
}

function containedBy(path: string, root: string): boolean {
  const candidate = resolve(path);
  const permitted = resolve(root);
  return candidate === permitted || candidate.startsWith(`${permitted}${sep}`);
}

function validateTransaction(transaction: WriteTransaction, permittedRoots: string[]): WriteTransaction {
  if (transaction.schemaVersion !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(transaction.key)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(transaction.transactionId)
    || !Array.isArray(transaction.writes) || transaction.writes.length === 0) {
    throw new Error('Invalid AgentLink write transaction journal');
  }
  for (const write of transaction.writes) {
    if (!write || typeof write.path !== 'string' || !isAbsolute(write.path) || typeof write.content !== 'string') {
      throw new Error(`Invalid write in AgentLink transaction ${transaction.transactionId}`);
    }
    if (!permittedRoots.some((root) => containedBy(write.path, root))) {
      throw new Error(`Transaction ${transaction.transactionId} targets a path outside registered AgentLink state: ${write.path}`);
    }
  }
  return transaction;
}

async function applyTransaction(transaction: WriteTransaction): Promise<void> {
  const configuredFault = process.env.AGENTLINK_TEST_FAIL_AFTER_TRANSACTION_WRITE;
  const configuredCrash = process.env.AGENTLINK_TEST_CRASH_AFTER_TRANSACTION_WRITE;
  const failAfter = configuredFault === undefined ? undefined : Number(configuredFault);
  const crashAfter = configuredCrash === undefined ? undefined : Number(configuredCrash);
  const faultKey = process.env.AGENTLINK_TEST_FAIL_TRANSACTION_KEY;
  let completed = 0;
  for (const write of transaction.writes) {
    await atomicWriteFile(write.path, write.content);
    completed += 1;
    if (Number.isInteger(crashAfter) && crashAfter! > 0 && completed === crashAfter
      && (faultKey === undefined || faultKey === transaction.key)) {
      process.kill(process.pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
    }
    if (Number.isInteger(failAfter) && failAfter! > 0 && completed === failAfter
      && (faultKey === undefined || faultKey === transaction.key)) {
      throw new Error(`Injected transaction interruption after durable write ${completed} for ${transaction.key}`);
    }
  }
}

async function readJournal(path: string, permittedRoots: string[]): Promise<WriteTransaction> {
  await assertNotSymlink(path, 'Transaction journal');
  const content = await readUtf8IfExists(path);
  if (content === undefined) throw new Error(`Transaction journal disappeared during recovery: ${path}`);
  try {
    return validateTransaction(JSON.parse(content) as WriteTransaction, permittedRoots);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in transaction journal: ${path}`);
    throw error;
  }
}

/**
 * Recover every prepared write set by replaying its complete, idempotent after-image.
 * Callers provide the bus plus registered workspace .agentlink roots so a repository
 * journal cannot turn recovery into an arbitrary filesystem writer.
 */
export async function recoverWriteTransactions(busPath: string, permittedRoots: string[]): Promise<number> {
  const directory = transactionsPath(busPath);
  await mkdir(directory, { recursive: true });
  await assertNotSymlink(directory, 'Transactions directory');
  return withFileLock(locksPath(busPath), 'transactions', async () => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const transaction = await readJournal(path, permittedRoots);
      await applyTransaction(transaction);
      await rm(path, { force: true });
    }
    return entries.length;
  }, { timeoutMs: 10_000, staleMs: 30_000, retryMs: 10 });
}

export async function journaledWriteFiles(
  busPath: string,
  key: string,
  writes: TransactionWrite[],
  permittedRoots: string[],
  transactionId = `txn_${randomUUID()}`,
): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(key)) throw new Error(`Invalid transaction key: ${key}`);
  if (writes.length < 2) throw new Error('A journaled write transaction requires at least two durable writes');
  const directory = transactionsPath(busPath);
  await mkdir(directory, { recursive: true });
  await assertNotSymlink(directory, 'Transactions directory');
  return withFileLock(locksPath(busPath), 'transactions', async () => {
    const transaction: WriteTransaction = validateTransaction({
      schemaVersion: 1,
      transactionId,
      key,
      createdAt: new Date().toISOString(),
      writes,
    }, permittedRoots);
    const path = join(directory, `${transaction.transactionId}.json`);
    await atomicWriteFile(path, `${JSON.stringify(transaction, null, 2)}\n`);
    await applyTransaction(transaction);
    await rm(path, { force: true });
    return transaction.transactionId;
  }, { timeoutMs: 10_000, staleMs: 30_000, retryMs: 10 });
}

export function transactionPermittedRoots(busPath: string, workspacePaths: string[]): string[] {
  return [resolve(busPath), ...workspacePaths.map((path) => resolve(path, '.agentlink'))]
    .filter((path, index, values) => values.indexOf(path) === index);
}
