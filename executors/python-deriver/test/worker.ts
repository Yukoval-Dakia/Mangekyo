import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

/** Run one isolated process with the same JSON-line framing as the production worker. */
export function pythonLines(args: readonly string[], inputs: readonly unknown[]): unknown[] {
  const run = spawnSync(process.env.MANGEKYO_PYTHON ?? 'python3', ['-I', '-B', '-S', '-X', 'utf8', ...args], {
    cwd: new URL('../', import.meta.url), env: {}, encoding: 'utf8',
    input: inputs.map(input => JSON.stringify(input)).join('\n') + '\n',
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
}
