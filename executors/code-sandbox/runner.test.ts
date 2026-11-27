import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildContainerRunArgs, CodeSandboxInputError, runCodeSandbox } from './index.ts';
import type { CodeSandboxRunRequest } from './index.ts';

const limits = { timeoutMs: 1500, memoryMb: 128, maxOutputBytes: 2048 };
const oneCase = [{ caseId: 'c1', input: 'hi' }];
function run(partial: {
  readonly language: CodeSandboxRunRequest['language'];
  readonly sourceCode: string;
  readonly entrypoint?: string;
  readonly limits?: CodeSandboxRunRequest['limits'];
  readonly cases?: CodeSandboxRunRequest['cases'];
}) {
  return runCodeSandbox({ limits, cases: oneCase, ...partial });
}
const first = (report: Awaited<ReturnType<typeof run>>) => report.results[0]!;

it('python script reads stdin through an environment scrubbed of host secrets', async () => {
  process.env.MANGEKYO_TEST_SECRET = 'should-never-leak';
  const report = await run({ language: 'python', sourceCode: 'import os, sys\nprint(os.environ.get("MANGEKYO_TEST_SECRET", "NONE"), sys.stdin.read().strip())' });
  expect(first(report).status).toBe('passed'); expect(first(report).actualOutput).toBe('NONE hi\n'); expect(report.executorKind).toBe('isolated-code-sandbox');
  expect(report.totalDurationMs).toBeLessThanOrEqual(limits.timeoutMs * 2); expect(report.peakMemoryMb).toBeGreaterThan(0);
});

it('python entrypoint, __main__ guard and missing entrypoint behave correctly', async () => {
  const report = await run({ language: 'python', entrypoint: 'solve', sourceCode: 'def solve(text):\n    return text.upper()' });
  expect(first(report)).toMatchObject({ status: 'passed', actualOutput: 'HI', exitCode: 0 });
  const guarded = await run({ language: 'python', sourceCode: 'import sys\nif __name__ == "__main__":\n    print("guard:" + sys.stdin.read().strip())' });
  expect(first(guarded)).toMatchObject({ status: 'passed', actualOutput: 'guard:hi\n' });
  expect(first(await run({ language: 'python', entrypoint: 'absent', sourceCode: 'x = 1' })).status).toBe('runtime_error');
});

it('python failures classify as syntax, runtime, timeout and output limit', async () => {
  const syntax = await run({ language: 'python', sourceCode: 'def broken(:\n' });
  expect(syntax.compileError).toBeTruthy(); expect(first(syntax)).toMatchObject({ status: 'syntax_error', durationMs: 0 });
  const runtime = await run({ language: 'python', sourceCode: 'print(1 / 0)' });
  expect(first(runtime).status).toBe('runtime_error'); expect(first(runtime).exitCode).not.toBe(0);
  expect(first(await run({ language: 'python', sourceCode: 'import time\ntime.sleep(30)' })).status).toBe('timeout');
  expect(first(await run({ language: 'python', sourceCode: 'print("x" * 100000)' })).status).toBe('output_limit_exceeded');
}, 20000);

it('python students cannot write files or tamper with harness output channels', async () => {
  const writeSrc = 'with open("evil.txt", "w") as f:\n    f.write("x" * 5000)\n    f.flush()';
  expect(first(await run({ language: 'python', sourceCode: writeSrc })).status).toBe('runtime_error');
  const tamper = await run({ language: 'python', entrypoint: 'solve', sourceCode: 'import sys\nsys.stdout = None\ndef solve(text):\n    return text + "!"' });
  expect(first(tamper)).toMatchObject({ status: 'passed', actualOutput: 'hi!' });
});

it('javascript and typescript stdin, entrypoint, syntax and runtime paths execute', async () => {
  const script = await run({ language: 'javascript', sourceCode: 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>console.log("js:"+b))' });
  expect(first(script).actualOutput).toBe('js:hi\n');
  const entry = await run({ language: 'javascript', entrypoint: 'solve', sourceCode: 'export function solve(text) { return text + "!" }' });
  expect(first(entry)).toMatchObject({ status: 'passed', actualOutput: 'hi!' });
  const jsSyntax = await run({ language: 'javascript', sourceCode: 'const broken = ;' });
  const jsRuntime = await run({ language: 'javascript', sourceCode: 'throw new Error("boom")' });
  expect(first(jsSyntax).status).toBe('syntax_error'); expect(first(jsRuntime).status).toBe('runtime_error');
  const ts = await run({ language: 'typescript', entrypoint: 'solve', sourceCode: 'export function solve(text: string): string { return text.toUpperCase() }' });
  expect(first(ts)).toMatchObject({ status: 'passed', actualOutput: 'HI' });
  const tsSyntax = await run({ language: 'typescript', sourceCode: 'const broken: = 3' });
  expect(tsSyntax.compileError).toBeTruthy(); expect(first(tsSyntax).status).toBe('syntax_error');
});

it('a then-exporting module cannot hijack the module namespace check', async () => {
  const sourceCode = 'export function solve(text) { return text }\nexport function then(resolve) { resolve("HIJACKED") }';
  const report = await run({ language: 'javascript', entrypoint: 'solve', sourceCode });
  expect(first(report).status).toBe('runtime_error'); expect(first(report).actualOutput).not.toBe('HIJACKED');
});

it('exact maxOutputBytes output passes while one byte more is killed', async () => {
  const tight = { timeoutMs: 1500, memoryMb: 128, maxOutputBytes: 256 };
  const exact = await run({ language: 'python', limits: tight, sourceCode: 'import sys; sys.stdout.write("y" * 256)' });
  expect(first(exact)).toMatchObject({ status: 'passed', actualOutput: 'y'.repeat(256) });
  expect(first(await run({ language: 'python', limits: tight, sourceCode: 'import sys; sys.stdout.write("y" * 257)' })).status).toBe('output_limit_exceeded');
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

it('rejects spoiler fields, sparse arrays, bad identifiers, extra keys and invalid shapes', async () => {
  const bad = (overrides: Record<string, unknown>) => runCodeSandbox({ language: 'python', sourceCode: 'pass', limits, cases: oneCase, ...overrides } as never);
  const shapes: readonly Record<string, unknown>[] = [
    { cases: [{ caseId: 'c1', input: '', expectedOutput: 'x' }] }, { cases: [{ caseId: 'c1', input: '', hidden: true }] },
    { cases: [{ caseId: 'c1', input: '', weight: 1 }] }, { cases: new Array(2) }, { cases: [] },
    { cases: [{ caseId: 'c1', input: '' }, { caseId: 'c1', input: '' }] },
    { cases: [{ caseId: `bad${String.fromCharCode(7)}`, input: '' }] }, { cases: [{ caseId: 'x'.repeat(129), input: '' }] },
    { expectedOutput: 'x' }, { entrypoint: '__proto__' }, { entrypoint: 'constructor' }, { entrypoint: '__import__' },
    { entrypoint: 'eval();process.exit(1)' }, { limits: { timeoutMs: 5, memoryMb: 128, maxOutputBytes: 2048 } },
  ];
  for (const shape of shapes) await expect(bad(shape)).rejects.toBeInstanceOf(CodeSandboxInputError);
});

it('a timeout kills the whole process group including orphaned grandchildren', async () => {
  const sourceCode = 'import subprocess, sys, time\nsubprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])\ntime.sleep(30)';
  const report = await run({ language: 'python', sourceCode });
  expect(first(report).status).toBe('timeout');
  expect(spawnSync('pgrep', ['-f', 'time;time.sleep'], { encoding: 'utf8' }).stdout.trim()).toBe('');
}, 15000);

it('container args enforce isolation and reject docker cli injection', () => {
  const args = buildContainerRunArgs({ image: 'python:3.13-alpine', containerName: 'probe', memoryMb: 64 });
  const required = ['--rm', '-i', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=64m', '--memory-swap=64m', '--cpus=0.5', '--user=65534:65534', '--tmpfs'];
  for (const flag of required) expect(args).toContain(flag);
  expect(args.some(arg => arg === '-v' || arg === '--mount' || arg.startsWith('--volume') || arg === '-e' || arg.startsWith('--env'))).toBe(false);
  expect(args[args.length - 1]).toBe('python:3.13-alpine');
  const evil = (overrides: Record<string, unknown>) => buildContainerRunArgs({ image: 'python:3.13-alpine', containerName: 'probe', memoryMb: 64, ...overrides });
  const injections: readonly Record<string, unknown>[] = [
    { image: '--privileged' }, { image: 'evil image' }, { image: 'evil/../escape' }, { image: '-v' },
    { containerName: '--rm=x' }, { containerName: 'bad name' }, { memoryMb: 8 }, { memoryMb: 4096 },
  ];
  for (const injection of injections) expect(() => evil(injection)).toThrow(CodeSandboxInputError);
});
