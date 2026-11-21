import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Read a local JSON config file; missing file returns the provided default. */
export async function readJsonConfig<T>(file: string, fallback: () => T, normalize: (value: unknown) => T): Promise<T> {
  try {
    return normalize(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw error;
  }
}

/** Atomically replace a local JSON config file with mode-0600 permissions. */
export async function writeJsonConfig(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID();
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
