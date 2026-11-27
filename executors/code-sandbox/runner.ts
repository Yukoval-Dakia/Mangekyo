import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeSandboxRunReportWire } from '@mangekyo/kernel';
import type { CodeSandboxRunRequest, NormalizedRequest } from './validate.ts';
import { validateRequest } from './validate.ts';
import type { CaseResult, SpawnedOutcome } from './shared.ts';
import { assembleReport, capText, throwIfAborted, totalBudgetOf } from './shared.ts';
import { cleanEnv, pythonCommand, runIsolatedProcess } from './process.ts';
import { runInContainerMode } from './container.ts';
const PRECHECK_DIAGNOSTIC_BYTES = 8192;
const PYTHON_HARNESS = fileURLToPath(new URL('./python-harness.py', import.meta.url));
const NODE_HARNESS = fileURLToPath(new URL('./node-harness.mjs', import.meta.url));

// Student sources live in a read-only directory (0o500/0o400) so no case process can
// rewrite the shared harness inputs or poison a later case; harness files stay inside
// this package and are never copied into any student-writable directory.
async function stageCodeDir(tmpRoot: string, input: NormalizedRequest): Promise<{ readonly codeDir: string; readonly student: string }> {
  const codeDir = await mkdtemp(path.join(tmpRoot, 'mangekyo-code-'));
  const extension = input.language === 'python' ? 'py' : input.language === 'javascript' ? 'mjs' : 'mts';
  const student = path.join(codeDir, `student.${extension}`);
  await writeFile(student, input.sourceCode, { encoding: 'utf8', mode: 0o400 });
  await chmod(codeDir, 0o500);
  return { codeDir, student };
}

// Every case (and the syntax precheck) receives its own private scratch directory as
// cwd/HOME/TMPDIR, created outside the read-only staging tree and removed immediately
// after the case finishes, so no writable state is ever shared between cases.
async function withCaseScratch<T>(tmpRoot: string, run: (scratchDir: string) => Promise<T>): Promise<T> {
  const scratchDir = await mkdtemp(path.join(tmpRoot, 'mangekyo-case-'));
  try {
    return await run(scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function spawnCase(
  student: string, scratchDir: string, input: NormalizedRequest, kind: 'check' | 'run',
  timeoutMs: number, maxOutputBytes: number, stdin?: string,
): Promise<SpawnedOutcome> {
  const submode = input.entrypoint === undefined ? 'script' : 'entry';
  const tail = input.entrypoint === undefined ? [] : [input.entrypoint];
  const cpuSec = String(Math.ceil(input.limits.timeoutMs / 1000) + 1);
  let command: string;
  let args: string[];
  let env: NodeJS.ProcessEnv;
  if (input.language === 'python') {
    const executable = pythonCommand();
    const rest = kind === 'check'
      ? ['check', student, cpuSec, String(input.limits.memoryMb)]
      : ['run', student, submode, cpuSec, String(input.limits.memoryMb), ...tail];
    command = executable;
    args = ['-I', PYTHON_HARNESS, ...rest];
    env = cleanEnv(scratchDir, path.dirname(executable));
  } else {
    const rest = kind === 'check' ? ['check', student] : ['run', student, submode, ...tail];
    const vmFlag = kind === 'check' ? ['--experimental-vm-modules'] : [];
    command = process.execPath;
    args = [
      '--no-warnings', ...vmFlag, `--max-old-space-size=${input.limits.memoryMb}`, '--disable-proto=throw',
      '--no-addons', '--permission', `--allow-fs-read=${student}`, NODE_HARNESS, ...rest,
    ];
    env = cleanEnv(scratchDir);
  }
  return runIsolatedProcess({
    command, args, env, cwd: scratchDir, timeoutMs, maxOutputBytes,
    ...(stdin === undefined ? {} : { input: stdin }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function toCaseResult(caseId: string, outcome: SpawnedOutcome, input: NormalizedRequest): CaseResult {
  const durationMs = Math.max(0, Math.round(outcome.durationMs));
  const stderr = capText(outcome.stderr, input.limits.maxOutputBytes);
  const diagnostics = stderr.trim().length > 0 ? { stderr } : {};
  if (outcome.kind === 'timeout') return { caseId, status: 'timeout', durationMs, ...diagnostics };
  if (outcome.kind === 'output_limit') return { caseId, status: 'output_limit_exceeded', durationMs, ...diagnostics };
  if (outcome.kind === 'exit' && outcome.exitCode === 0) {
    return { caseId, status: 'passed', actualOutput: outcome.stdout, durationMs, exitCode: 0, ...diagnostics };
  }
  return { caseId, status: 'runtime_error', durationMs, exitCode: outcome.exitCode ?? 1, ...diagnostics };
}

// Process mode boundary: same host uid but zero ambient env, no writable shared state,
// read-only staged sources, Node --permission deny-by-default for JS/TS, rlimits for
// Python, per-case scratch directories and group-wide SIGKILL on every limit breach.
async function runInProcessMode(input: NormalizedRequest): Promise<CodeSandboxRunReportWire> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + totalBudgetOf(input);
  const tmpRoot = await realpath(tmpdir());
  const results: CaseResult[] = [];
  let timedOut = false;
  let peakRssKb = 0;
  let compileError: string | undefined;
  let codeDir: string | undefined;
  try {
    const staged = await stageCodeDir(tmpRoot, input);
    codeDir = staged.codeDir;
    const student = staged.student;
    throwIfAborted(input.signal);
    const preBudget = Math.min(5000, Math.max(2000, input.limits.timeoutMs), Math.max(1, deadlineAt - Date.now()));
    const preMaxBytes = Math.max(input.limits.maxOutputBytes, PRECHECK_DIAGNOSTIC_BYTES);
    const precheck = await withCaseScratch(tmpRoot, scratch =>
      spawnCase(student, scratch, input, 'check', preBudget, preMaxBytes));
    if (precheck.kind === 'aborted') throwIfAborted(input.signal);
    peakRssKb = Math.max(peakRssKb, precheck.rssKb);
    if (!(precheck.kind === 'exit' && precheck.exitCode === 0)) {
      // A precheck starved by the shrinking total budget is an honest overall timeout
      // (ungradable downstream), never a fabricated zero-score syntax error.
      if (precheck.kind === 'timeout' && (preBudget < 2000 || Date.now() >= deadlineAt)) timedOut = true;
      else {
        const detail = precheck.stderr.trim();
        const fallback = precheck.kind === 'timeout' ? '语法预检超时（疑似资源耗尽构造）。' : '语法预检失败。';
        compileError = capText(detail.length > 0 ? detail : fallback, input.limits.maxOutputBytes);
        const exitCode = precheck.exitCode ?? 1;
        for (const testCase of input.cases) {
          results.push({ caseId: testCase.caseId, status: 'syntax_error', durationMs: 0, stderr: compileError, exitCode });
        }
      }
    } else {
      for (const testCase of input.cases) {
        throwIfAborted(input.signal);
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        const budget = Math.min(input.limits.timeoutMs, remaining);
        const outcome = await withCaseScratch(tmpRoot, scratch =>
          spawnCase(student, scratch, input, 'run', budget, input.limits.maxOutputBytes, testCase.input));
        if (outcome.kind === 'aborted') throwIfAborted(input.signal);
        peakRssKb = Math.max(peakRssKb, outcome.rssKb);
        results.push(toCaseResult(testCase.caseId, outcome, input));
        // Only a genuine case timeout starved by the shrinking total budget counts as
        // an overall timeout; a passing case that merely finishes near the deadline is not.
        const starved = outcome.kind === 'timeout' && (budget < input.limits.timeoutMs || Date.now() >= deadlineAt);
        if (starved) timedOut = true;
      }
    }
  } finally {
    // Restore owner write permission on the read-only staging directory so the
    // recursive cleanup can unlink the student source; without this the rm fails.
    if (codeDir !== undefined) {
      await chmod(codeDir, 0o700).catch(() => undefined);
      await rm(codeDir, { recursive: true, force: true });
    }
  }
  return assembleReport({
    input, startedAt, results, timedOut, peakRssKb,
    ...(compileError === undefined ? {} : { compileError }),
  });
}

export async function runCodeSandbox(request: CodeSandboxRunRequest): Promise<CodeSandboxRunReportWire> {
  const input = validateRequest(request);
  throwIfAborted(input.signal);
  if (input.mode === 'container') return runInContainerMode(input);
  return runInProcessMode(input);
}
