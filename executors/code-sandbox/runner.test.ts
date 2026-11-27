import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CodeSandboxInputError, runCodeSandbox } from './index.ts';
import { buildContainerRunArgs } from './container.ts';
import type { CodeSandboxRunRequest } from './validate.ts';

const limits = { timeoutMs: 500, memoryMb: 128, maxOutputBytes: 256 } as const;
const oneCase = [{ caseId: 'c1', input: 'hi' }] as const;
const base = { language: 'python', sourceCode: 'pass', limits, cases: oneCase } as const;
type Report = Awaited<ReturnType<typeof runCodeSandbox>>;
type RunInput = Partial<CodeSandboxRunRequest> & Pick<CodeSandboxRunRequest, 'language' | 'sourceCode'>;
const firstOf = (report: Report) => report.results[0] as NonNullable<Report['results'][number]>;
const run = ({ entrypoint, ...rest }: RunInput) =>
  runCodeSandbox({ ...base, ...rest, ...(entrypoint === undefined ? {} : { entrypoint }) });
const py = (sourceCode: string, entrypoint?: string) =>
  run(entrypoint === undefined ? { language: 'python', sourceCode } : { language: 'python', sourceCode, entrypoint });
function expectFirst(promise: Promise<Report>, expected: Record<string, unknown>) {
  return promise.then((report) => expect(firstOf(report)).toMatchObject(expected));
}

describe('runCodeSandbox process mode', () => {
  it('python scripts, entrypoints and __main__ guards run in a scrubbed environment', async () => {
    process.env.MANGEKYO_TEST_SECRET = 'should-never-leak';
    const source = 'import os, sys\nprint(os.environ.get("MANGEKYO_TEST_SECRET", "NONE"), sys.stdin.read().strip())';
    const report = await py(source);
    expect(report).toMatchObject({ executorKind: 'isolated-code-sandbox', results: [{ status: 'passed', actualOutput: 'NONE hi\n' }] });
    await expectFirst(py('def solve(text):\n    return text.upper()', 'solve'), { status: 'passed', actualOutput: 'HI', exitCode: 0 });
    const guarded = 'import sys\nif __name__ == "__main__":\n    print("guard:" + sys.stdin.read().strip())';
    await expectFirst(py(guarded), { status: 'passed', actualOutput: 'guard:hi\n' });
  });

  it('python failures classify syntax, runtime, timeout and exact output boundaries', async () => {
    const pySyntax = await py('def broken(:\n    pass');
    expect(firstOf(pySyntax)).toMatchObject({ status: 'syntax_error', durationMs: 0, exitCode: 65 });
    const timedOut = await py('import time\ntime.sleep(5)');
    expect(firstOf(timedOut).status).toBe('timeout');
    await expectFirst(py('import sys\nsys.stdout.write("x")\nsys.exit(3)'), { status: 'runtime_error', exitCode: 3 });
    await expectFirst(py('import sys; sys.stdout.write("x" * 256)'), { status: 'passed', actualOutput: 'x'.repeat(256) });
    const tsSyntax = await run({ language: 'typescript', sourceCode: 'const broken: number = ;' });
    expect(firstOf(tsSyntax)).toMatchObject({ status: 'syntax_error', durationMs: 0 });
    expect([pySyntax.compileError, tsSyntax.compileError].every((s) => (s ?? '').length > 0)).toBe(true);
    const overReport = py('import sys; sys.stdout.write("y" * 257)');
    await expectFirst(overReport, { status: 'output_limit_exceeded', actualOutput: 'y'.repeat(256) });
    const orphanSpawner = 'import subprocess, time\nsubprocess.Popen(["python3", "-c", "import time;time.sleep(30)"])\ntime.sleep(30)';
    expect(firstOf(await py(orphanSpawner)).status).toBe('timeout');
    expect(spawnSync('pgrep', ['-f', 'time;time.sleep'], { encoding: 'utf8' }).stdout.trim()).toBe('');
  }, 20000);

  it('python cannot write files, leak host paths, forge memory or corrupt later cases', async () => {
    await expectFirst(py('w = open("evil.txt", "w")\nw.write("payload")\nw.close()'), { status: 'runtime_error' });
    const sabotage = [
      'import os, sys',
      'def attempt(fn):\n    try: fn()\n    except OSError: pass',
      'attempt(lambda: os.unlink("student.py"))',
      'attempt(lambda: os.chmod(os.getcwd(), 0o500))',
      'attempt(lambda: os.symlink("/tmp/x-marker", "link"))',
      'sys.stdout.write("link:" + str(os.path.islink("link")))',
    ].join('\n');
    const cases = [{ caseId: 'c1', input: '' }, { caseId: 'c2', input: '' }] as const;
    const report = await run({ language: 'python', sourceCode: sabotage, cases });
    expect(report.results.map((r) => [r.caseId, r.status])).toEqual([['c1', 'passed'], ['c2', 'passed']]);
    await expectFirst(py('import sys; sys.stdout.write("argv0=" + sys.argv[0])'), { status: 'passed', actualOutput: 'argv0=<student>' });
    const flood = 'import { writeSync } from "node:fs"\nwriteSync(3, "x".repeat(2048))';
    await expectFirst(run({ language: 'javascript', sourceCode: flood }), { status: 'output_limit_exceeded' });
  });

  it('javascript and typescript entrypoints run and node hardening blocks escapes', async () => {
    const js = 'import fs from "node:fs"\nconsole.log(fs.readFileSync(0, "utf8").trim().toUpperCase())';
    const entry = 'export function solve(text) { return text + "!" }';
    const tsEntry = 'export function solve(text: string): string { return text.trim() }';
    await expectFirst(run({ language: 'javascript', sourceCode: js }), { status: 'passed', actualOutput: 'HI\n' });
    await expectFirst(run({ language: 'javascript', entrypoint: 'solve', sourceCode: entry }), { status: 'passed', actualOutput: 'hi!' });
    await expectFirst(run({ language: 'typescript', entrypoint: 'solve', sourceCode: tsEntry }), { status: 'passed', actualOutput: 'hi' });
    const hijack = 'export function solve() { return "unused" }\nexport function then(resolve) { resolve("HIJACKED") }';
    await expectFirst(run({ language: 'javascript', entrypoint: 'solve', sourceCode: hijack }), { status: 'runtime_error' });
    const exitAtTop = 'process.exit(0)\nexport function solve(text) { return text }';
    await expectFirst(run({ language: 'javascript', entrypoint: 'solve', sourceCode: exitAtTop }), { status: 'runtime_error' });
    const symbolReturn = 'export function solve() { return Symbol("x") }';
    const symbolReport = run({ language: 'javascript', entrypoint: 'solve', sourceCode: symbolReturn });
    await expectFirst(symbolReport, { status: 'passed', actualOutput: 'Symbol(x)' });
    await expectFirst(run({ language: 'javascript', sourceCode: 'throw null' }), { status: 'runtime_error' });
    const attempts = [
      'import fs from "node:fs"\nfs.readFileSync("/etc/passwd", "utf8")',
      'import fs from "node:fs"\nfs.writeFileSync("evil.txt", "x")',
      'import cp from "node:child_process"\ncp.execSync("id")',
    ];
    for (const sourceCode of attempts) {
      await expectFirst(run({ language: 'javascript', sourceCode }), { status: 'runtime_error' });
    }
  }, 20000);

  it('rejects hostile input shapes and container cli injection', async () => {
    const bad = (overrides: Record<string, unknown>) => runCodeSandbox({ ...base, ...overrides } as never);
    const shapes: readonly Record<string, unknown>[] = [
      { language: 'ruby' },
      { language: 3 },
      { sourceCode: 3 },
      { limits: null },
      { cases: null },
      { cases: [{ caseId: 'c1', input: '', expectedOutput: 1 }] },
      { cases: [{ caseId: 'c1', input: '', hidden: 1 }] },
      { cases: [{ caseId: 'bad\x00id', input: '' }] },
      { limits: { ...limits, maxOutputBytes: 128 } },
      { entrypoint: 'constructor' },
      { entrypoint: 'eval' },
      { entrypoint: 'bad-name' },
      { entrypoint: '__proto__' },
      { extraKey: 1 },
      { cases: [] },
      { cases: Array(2) },
    ];
    for (const shape of shapes) {
      await expect(bad(shape)).rejects.toBeInstanceOf(CodeSandboxInputError);
    }

    const args = buildContainerRunArgs({ image: 'python:3.13-alpine', containerName: 'probe', memoryMb: 64 });
    const required = [
      '--rm',
      '-i',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=32',
      '--memory=64m',
      '--memory-swap=64m',
      '--cpus=0.5',
      '--user=65534:65534',
      '--tmpfs',
    ];
    for (const flag of required) {
      expect(args).toContain(flag);
    }
    const hostile = (arg: string) =>
      arg === '-v' || arg === '--mount' || arg.startsWith('--volume') || arg === '-e' || arg.startsWith('--env');
    expect(args.some(hostile)).toBe(false);
    const evil = (overrides: Record<string, unknown>) =>
      buildContainerRunArgs({ image: 'python:3.13-alpine', containerName: 'probe', memoryMb: 64, ...overrides });
    const injections: readonly Record<string, unknown>[] = [
      { image: '--privileged' },
      { image: 'evil image' },
      { image: 'evil/../escape' },
      { image: '-v' },
      { containerName: '--rm=x' },
      { containerName: 'bad name' },
      { memoryMb: 8 },
      { memoryMb: 4096 },
    ];
    for (const injection of injections) {
      expect(() => evil(injection)).toThrow(CodeSandboxInputError);
    }
  });
});
