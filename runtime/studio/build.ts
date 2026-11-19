import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Development deployments pin the actual code even when the checkout has uncommitted changes. */
export async function sourceBuildId() {
  const digest = createHash('sha256');
  async function add(path: string) {
    digest
      .update(relative(root, path))
      .update('\0')
      .update(await readFile(path))
      .update('\0');
  }
  async function scan(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !['node_modules', 'dist', 'test'].includes(entry.name)) await scan(path);
      if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name === 'package.json') &&
        !entry.name.endsWith('.test.ts')
      )
        await add(path);
    }
  }
  for (const directory of [
    'kernel/src',
    'kernel/dist',
    'modules/activity',
    'modules/content',
    'surfaces/shared/presentation',
    'modules/companion',
    'executors/temporal/src',
    'executors/teaching',
    'runtime/studio',
  ]) {
    await scan(join(root, directory));
  }
  await add(join(root, 'pnpm-lock.yaml'));
  return 'dev-' + digest.digest('hex').slice(0, 20);
}
