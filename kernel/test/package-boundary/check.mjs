import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const consumer = path.join(root, 'kernel/test/package-boundary/consumer');
const temporary = await mkdtemp(path.join(tmpdir(), 'mangekyo-package-boundary-'));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}
try {
  const artifact = path.join(temporary, 'package');
  await mkdir(artifact);
  await copyFile(path.join(root, 'kernel/package.json'), path.join(artifact, 'package.json'));
  const tsrs = path.join(root, 'node_modules/tsrs/bin/tsrs');
  run(process.execPath, [tsrs, '-p', 'kernel/tsconfig.build.json', '--outDir', path.join(artifact, 'dist')]);
  run('pnpm', ['pack', '--pack-destination', temporary], artifact);
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'index.ts', 'forbidden.ts', 'runtime.test.mjs']) {
    await copyFile(path.join(consumer, file), path.join(temporary, file));
  }
  run('pnpm', ['install', '--prefer-offline', '--no-lockfile'], temporary);
  const flags = [
    '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--allowImportingTsExtensions',
    '--strict', '--noEmit', '--types', '--skipLibCheck', 'true',
  ];
  for (const file of ['index.ts', 'forbidden.ts']) {
    run(process.execPath, [tsrs, ...flags, path.join(temporary, file)], temporary);
  }
  run(process.execPath, ['--test', 'runtime.test.mjs'], temporary);
  console.log('Packed consumer compiles and runs; Db imports are rejected.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
