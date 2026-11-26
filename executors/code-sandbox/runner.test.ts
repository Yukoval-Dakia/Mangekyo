import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildContainerRunArgs, CodeSandboxInputError, runCodeSandbox } from './index.ts';
import type { CodeSandboxRunRequest } from './index.ts';

const limits = { timeoutMs: 1500, memoryMb: 128, maxOutputBytes: 2048 };
const oneCase = [{ caseId: 'c1', input: 'hi' }];
function run(partial: { readonly language: CodeSandboxRunRequest['language']; readonly sourceCode: string; readonly entrypoint?: string }) {
  return runCodeSandbox({ limits, cases: oneCase, ...partial });
}
function first(report: Awaited<ReturnType<typeof run>>) {
  return report.results[0]!;
}

it('python script reads stdin through an environment scrubbed of host secrets', async () => {
  process.env.MANGEKYO_TEST_SECRET = 'should-never-leak';
  const report = await run({ language: 'python', sourceCode: 'import os, sys\nprint(os.environ.get("MANGEKYO_TEST_SECRET", "NONE"), sys.stdin.read().strip())' });
  expect(first(report).status).toBe('passed');
  expect(first(report).actualOutput).toBe('NONE hi\n');
  expect(report.executorKind).toBe('isolated-code-sandbox');
  expect(report.totalDurationMs).toBeLessThanOrEqual(limits.timeoutMs * 2);
  expect(report.peakMemoryMb).toBeGreaterThan(0);
});

it('python entrypoint receives stdin text and a missing entrypoint is a runtime error', async () => {
  const report = await run({ language: 'python', entrypoint: 'solve', sourceCode: 'def solve(text):\n    return text.upper()' });
  expect(first(report)).toMatchObject({ status: 'passed', actualOutput: 'HI', exitCode: 0 });
  const missing = await run({ language: 'python', entrypoint: 'absent', sourceCode: 'x = 1' });
  expect(first(missing).status).toBe('runtime_error');
});

it('python failures classify as syntax, runtime, timeout and output limit', async () => {
  const syntax = await run({ language: 'python', sourceCode: 'def broken(:\n' });
  expect(syntax.compileError).toBeTruthy();
  expect(first(syntax)).toMatchObject({ status: 'syntax_error', durationMs: 0 });
  const runtime = await run({ language: 'python', sourceCode: 'print(1 / 0)' });
  expect(first(runtime).status).toBe('runtime_error');
  expect(first(runtime).exitCode).not.toBe(0);
  const timeout = await run({ language: 'python', sourceCode: 'import time\ntime.sleep(30)' });
  expect(first(timeout).status).toBe('timeout');
  const flooded = await run({ language: 'python', sourceCode: 'print("x" * 100000)' });
  expect(first(flooded).status).toBe('output_limit_exceeded');
}, 20000);

it('javascript script stdin mode and entrypoint mode both execute', async () => {
  const script = await run({ language: 'javascript', sourceCode: 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>console.log("js:"+b))' });
  expect(first(script).actualOutput).toBe('js:hi\n');
  const entry = await run({ language: 'javascript', entrypoint: 'solve', sourceCode: 'export function solve(text) { return text + "!" }' });
  expect(first(entry)).toMatchObject({ status: 'passed', actualOutput: 'hi!' });
});

it('javascript syntax and runtime failures are distinguished', async () => {
  const syntax = await run({ language: 'javascript', sourceCode: 'const broken = ;' });
  expect(first(syntax).status).toBe('syntax_error');
  const runtime = await run({ language: 'javascript', sourceCode: 'throw new Error("boom")' });
  expect(first(runtime).status).toBe('runtime_error');
});

it('typescript entrypoint executes and bad syntax becomes a compile error', async () => {
  const entry = await run({ language: 'typescript', entrypoint: 'solve', sourceCode: 'export function solve(text: string): string { return text.toUpperCase() }' });
  expect(first(entry)).toMatchObject({ status: 'passed', actualOutput: 'HI' });
  const syntax = await run({ language: 'typescript', sourceCode: 'const broken: = 3' });
  expect(syntax.compileError).toBeTruthy();
  expect(first(syntax).status).toBe('syntax_error');
});

it('node permission model blocks host reads, writes and child processes', async () => {
  const sourceCode = [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const marks = [];',
    'try { readFileSync("/etc/passwd"); marks.push("read-ok"); } catch { marks.push("read-blocked"); }',
    'try { writeFileSync("evil.txt", "x"); marks.push("write-ok"); } catch { marks.push("write-blocked"); }',
    'try { (await import("node:child_process")).execSync("echo hi"); marks.push("cp-ok"); } catch { marks.push("cp-blocked"); }',
    'console.log(marks.join(","));',
  ].join('\n');
  const report = await run({ language: 'javascript', sourceCode });
  expect(first(report).actualOutput).toBe('read-blocked,write-blocked,cp-blocked\n');
}, 15000);

it('rejects spoiler fields, extra keys, reserved entrypoints and invalid shapes', async () => {
  const bad = (overrides: Record<string, unknown>) => runCodeSandbox({ language: 'python', sourceCode: 'pass', limits, cases: oneCase, ...overrides } as never);
  await expect(bad({ cases: [{ caseId: 'c1', input: '', expectedOutput: 'x' }] })).rejects.toBeInstanceOf(CodeSandboxInputError);
  await expect(bad({ cases: [{ caseId: 'c1', input: '', hidden: true }] })).rejects.toBeInstanceOf(CodeSandboxInputError);
  await expect(bad({ cases: [{ caseId: 'c1', input: '', weight: 1 }] })).rejects.toBeInstanceOf(CodeSandboxInputError);
  await expect(bad({ entrypoint: '__proto__' })).rejects.toBeInstanceOf(CodeSandboxInputError);
  await expect(bad({ entrypoint: 'constructor' })).rejects.toBeInstanceOf(CodeSandboxInputError);
  await expect(bad({ entrypoint: 'eval();process.exit(1)' })).rejects.toBeInstanceOf(CodeSandboxInputError);
  await expect(bad({ limits: { timeoutMs: 5, memoryMb: 128, maxOutputBytes: 2048 } })).rejects.toBeInstanceOf(CodeSandboxInputError);
  await expect(bad({ cases: [] })).rejects.toBeInstanceOf(CodeSandboxInputError);
  await expect(bad({ cases: [{ caseId: 'c1', input: '' }, { caseId: 'c1', input: '' }] })).rejects.toBeInstanceOf(CodeSandboxInputError);
});

it('a timeout kills the whole process group including orphaned grandchildren', async () => {
  const sourceCode = 'import subprocess, sys, time\nsubprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])\ntime.sleep(30)';
  const report = await run({ language: 'python', sourceCode });
  expect(first(report).status).toBe('timeout');
  const orphans = spawnSync('pgrep', ['-f', 'time;time.sleep'], { encoding: 'utf8' });
  expect(orphans.stdout.trim()).toBe('');
}, 15000);

it('container args enforce isolation without host mounts or env passthrough', () => {
  const args = buildContainerRunArgs({ image: 'python:3.13-alpine', containerName: 'probe', memoryMb: 64 });
  const required = ['--rm', '-i', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=64m', '--memory-swap=64m', '--cpus=0.5', '--user=65534:65534', '--tmpfs'];
  for (const flag of required) expect(args).toContain(flag);
  expect(args.some(arg => arg === '-v' || arg === '--mount' || arg.startsWith('--volume') || arg === '-e' || arg.startsWith('--env'))).toBe(false);
  expect(args[args.length - 1]).toBe('python:3.13-alpine');
});
