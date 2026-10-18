import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fingerprint shipped runtime JS bytes, not git state, timestamps or user config. */
export async function runtimeBuildIdentity(root = dirname(fileURLToPath(import.meta.url))) {
  const files: string[] = [];
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${name}/`);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(name);
    }
  }
  await visit(root);
  const hash = createHash('sha256');
  for (const name of files.sort()) {
    const bytes = await readFile(join(root, name));
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`); hash.update(bytes);
  }
  return { buildId: `sha256:${hash.digest('hex')}`, algorithm: 'sha256-runtime-js-v1', runtimeFiles: files.length };
}
