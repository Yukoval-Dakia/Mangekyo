import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeLanguageWire, CodeSandboxExecutorKindWire, CodeSandboxRunReportWire, CodeSandboxRunResultWire } from '@mangekyo/kernel';

export const isolatedCodeSandboxKind: CodeSandboxExecutorKindWire = 'isolated-code-sandbox';
export class CodeSandboxInputError extends Error {
  constructor(message: string) { super(message); this.name = 'CodeSandboxInputError'; }
}
export class CodeSandboxExecutorError extends Error {
  constructor(message: string) { super(message); this.name = 'CodeSandboxExecutorError'; }
}
function fail(message: string): never { throw new CodeSandboxInputError(message); }
function must(ok: unknown, message: string): asserts ok { if (!ok) fail(message); }
export type CodeSandboxCaseInput = { readonly caseId: string; readonly input: string };
export type CodeSandboxLimitsInput = { readonly timeoutMs: number; readonly memoryMb: number; readonly maxOutputBytes: number };
export type CodeSandboxMode = 'process' | 'container';
export type CodeSandboxRunRequest = {
  readonly language: CodeLanguageWire; readonly sourceCode: string;
  readonly limits: CodeSandboxLimitsInput; readonly cases: readonly CodeSandboxCaseInput[];
  readonly entrypoint?: string; readonly mode?: CodeSandboxMode; readonly containerImage?: string;
  readonly totalTimeoutMs?: number; readonly signal?: AbortSignal;
};
type NormalizedRequest = Omit<CodeSandboxRunRequest, 'mode'> & { readonly mode: CodeSandboxMode };
type CaseResult = CodeSandboxRunResultWire;
type ProcessRunPlan = { readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv };
type SpawnSpec = {
  readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly cwd: string;
  readonly timeoutMs: number; readonly maxOutputBytes: number; readonly input?: string; readonly signal?: AbortSignal;
};
type ProcessOutcome = {
  readonly kind: 'exit' | 'timeout' | 'output_limit' | 'aborted'; readonly exitCode: number | null;
  readonly stdout: string; readonly stderr: string; readonly durationMs: number;
};
type SpawnedOutcome = ProcessOutcome & { readonly rssKb: number };

const MAX_SOURCE_BYTES = 256 * 1024, MAX_CASE_INPUT_BYTES = 256 * 1024, MAX_CONTAINER_OUTPUT_BYTES = 6 * 1024 * 1024;
const LANGUAGES: readonly CodeLanguageWire[] = ['python', 'javascript', 'typescript'];
const RUN_STATUSES = new Set(['passed', 'failed', 'timeout', 'runtime_error', 'syntax_error', 'output_limit_exceeded']);
const ENTRYPOINT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCKED_ENTRYPOINTS = new Set([
  '__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'eval', 'exec',
  '__import__', '__builtins__', 'globalThis', 'process', 'require', 'module', 'exports',
]);
const MEMORY_MARKER = /^MGKYO_RSS_KB=(\d+)$/;

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label}必须是对象。`);
  return value as Record<string, unknown>;
}
function intInRange(value: unknown, min: number, max: number, label: string): number {
  must(typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max, `${label}必须是 ${min}..${max} 内的整数。`);
  return value;
}

function validateCase(entry: unknown, index: number, seen: Set<string>): CodeSandboxCaseInput {
  const row = asObject(entry, `用例 ${index}`);
  must(!('expectedOutput' in row) && !('hidden' in row), '用例输入禁止携带 expectedOutput/hidden 剧透字段，请在调用执行器前剥离评分数据。');
  for (const key of Object.keys(row)) must(key === 'caseId' || key === 'input', `用例输入禁止携带额外字段：${key}。`);
  must(typeof row.caseId === 'string', `用例 ${index} 缺少字符串标识。`); const caseId = row.caseId.trim();
  must(caseId.length > 0, `用例 ${index} 标识为空。`); must(!seen.has(caseId), `用例标识重复：${caseId}。`);
  seen.add(caseId);
  must(typeof row.input === 'string', `用例 ${caseId} 输入必须是字符串。`); must(Buffer.byteLength(row.input, 'utf8') <= MAX_CASE_INPUT_BYTES, `用例 ${caseId} 输入超出大小上限。`);
  return Object.freeze({ caseId, input: row.input });
}

function validateRequest(request: CodeSandboxRunRequest): NormalizedRequest {
  const raw = asObject(request, '执行请求');
  must(LANGUAGES.includes(raw.language as CodeLanguageWire), '代码语言必须是 python/javascript/typescript。');
  must(typeof raw.sourceCode === 'string', '学生源码必须是字符串。');
  must(Buffer.byteLength(raw.sourceCode, 'utf8') <= MAX_SOURCE_BYTES, '学生源码超出 256KiB 大小上限。');
  const limitRow = asObject(raw.limits, '资源限制');
  const limits = Object.freeze({
    timeoutMs: intInRange(limitRow.timeoutMs, 100, 15000, '超时限制'),
    memoryMb: intInRange(limitRow.memoryMb, 32, 512, '内存限制'),
    maxOutputBytes: intInRange(limitRow.maxOutputBytes, 256, 65536, '输出字节限制'),
  });
  must(Array.isArray(raw.cases) && raw.cases.length >= 1 && raw.cases.length <= 64, '需要 1..64 个测试用例。');
  const seen = new Set<string>(); const cases = Object.freeze(raw.cases.map((entry, index) => validateCase(entry, index, seen)));
  let entrypoint: string | undefined;
  if (raw.entrypoint !== undefined) {
    must(typeof raw.entrypoint === 'string' && ENTRYPOINT_PATTERN.test(raw.entrypoint), '代码入口点必须是合法的标识符。');
    const blocked = BLOCKED_ENTRYPOINTS.has(raw.entrypoint) || (raw.entrypoint.startsWith('__') && raw.entrypoint.endsWith('__'));
    must(!blocked, `代码入口点命中保留名称：${raw.entrypoint}。`);
    entrypoint = raw.entrypoint;
  }
  const mode = raw.mode === undefined ? 'process' : raw.mode;
  must(mode === 'process' || mode === 'container', '执行模式必须是 process 或 container。');
  let containerImage: string | undefined;
  if (raw.containerImage !== undefined) {
    must(typeof raw.containerImage === 'string' && raw.containerImage.trim().length > 0, '容器镜像必须是非空字符串。');
    containerImage = raw.containerImage.trim();
  }
  must(mode !== 'container' || containerImage !== undefined, '容器模式必须提供 containerImage。');
  const totalTimeoutMs = raw.totalTimeoutMs === undefined ? undefined
    : intInRange(raw.totalTimeoutMs, 1, limits.timeoutMs * (cases.length + 1), '总超时预算');
  must(raw.signal === undefined || raw.signal instanceof AbortSignal, 'signal 必须是 AbortSignal。');
  return {
    language: raw.language as CodeLanguageWire, sourceCode: raw.sourceCode,
    limits, cases, mode,
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(containerImage === undefined ? {} : { containerImage }),
    ...(totalTimeoutMs === undefined ? {} : { totalTimeoutMs }),
    ...(raw.signal === undefined ? {} : { signal: raw.signal as AbortSignal }),
  };
}

function totalBudgetOf(input: NormalizedRequest): number {
  const fallback = Math.min(input.limits.timeoutMs * input.cases.length + Math.min(input.limits.timeoutMs, 2000), 60_000);
  return Math.min(input.totalTimeoutMs ?? fallback, input.limits.timeoutMs * (input.cases.length + 1));
}
function abortError(): Error {
  return Object.assign(new Error('code sandbox run aborted'), { name: 'AbortError' });
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}
function capText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.byteLength <= maxBytes ? text : buffer.subarray(0, maxBytes).toString('utf8');
}
function basePathParts(): readonly string[] {
  return [...new Set(['/usr/bin', '/bin', '/usr/local/bin', path.dirname(process.execPath)])];
}
let cachedPython: string | null | undefined;
function pythonCommand(): string {
  if (cachedPython === undefined) {
    const probe = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    const resolved = probe.status === 0 && typeof probe.stdout === 'string' ? probe.stdout.trim() : '';
    cachedPython = resolved.length > 0 ? resolved : null;
  }
  if (cachedPython === null) throw new CodeSandboxExecutorError('python3 解释器不可用，无法执行 python 沙盒。');
  return cachedPython;
}
// Built from scratch: nothing is inherited from the host environment, so API keys,
// tokens and database URLs can never leak into the student process.
function cleanEnv(workDir: string, pythonBinDir?: string): NodeJS.ProcessEnv {
  const parts = pythonBinDir === undefined ? basePathParts() : [pythonBinDir, ...basePathParts()];
  return {
    PATH: [...new Set(parts)].join(':'),
    HOME: workDir, TMPDIR: workDir, TEMP: workDir, TMP: workDir,
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONSAFEPATH: '1', PYTHONUTF8: '1',
    NODE_OPTIONS: '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  };
}
function dockerEnv(): NodeJS.ProcessEnv {
  return { PATH: basePathParts().join(':'), HOME: process.env.HOME ?? tmpdir(), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
}

function killProcessGroup(pid: number): void {
  let groupGone = false;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    groupGone = (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  if (groupGone) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ESRCH means the process already exited; nothing more to reap here.
  }
}
// One child per case in a detached process group: timeouts, output floods and aborts
// escalate to a group-wide SIGKILL so orphaned grandchildren cannot survive the runner.
function runIsolatedProcess(spec: SpawnSpec): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(spec.command, [...spec.args], { detached: true, cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let combinedBytes = 0, truncated = false, settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (kind: ProcessOutcome['kind'], exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        kind, exitCode,
        stdout: capText(Buffer.concat(stdoutChunks).toString('utf8'), spec.maxOutputBytes),
        stderr: capText(Buffer.concat(stderrChunks).toString('utf8'), spec.maxOutputBytes),
        durationMs: Date.now() - started,
      });
    };
    const kill = (): void => {
      if (typeof child.pid === 'number') killProcessGroup(child.pid);
    };
    const onAbort = (): void => {
      kill();
      finish('aborted', null);
    };
    const timer = setTimeout(() => { kill(); finish('timeout', null); }, spec.timeoutMs);
    child.on('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CodeSandboxExecutorError(`无法启动沙盒子进程：${error.message}`));
    });
    const onData = (chunks: Buffer[]) => (chunk: Buffer) => {
      combinedBytes += chunk.length;
      if (combinedBytes > spec.maxOutputBytes) {
        if (!truncated) {
          truncated = true;
          kill();
          finish('output_limit', null);
        }
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', onData(stdoutChunks));
    child.stderr.on('data', onData(stderrChunks));
    child.on('close', code => finish('exit', code));
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });
    if (child.stdin) {
      child.stdin.on('error', () => {
        // EPIPE when the student exits without reading stdin; close decides the outcome.
      });
      child.stdin.end(spec.input ?? '');
    }
  });
}
// Harness processes end stderr with MGKYO_RSS_KB= lines; they are stripped from
// student-visible diagnostics and folded into the run's peak-memory report.
function extractMemory(stderr: string): { readonly text: string; readonly rssKb: number } {
  let rssKb = 0;
  const kept: string[] = [];
  for (const line of stderr.split('\n')) {
    const match = MEMORY_MARKER.exec(line);
    if (match) rssKb = Math.max(rssKb, Number.parseInt(match[1] ?? '0', 10));
    else kept.push(line);
  }
  return { text: kept.join('\n'), rssKb };
}

function studentFile(workDir: string, language: CodeLanguageWire): string {
  const extension = language === 'python' ? 'py' : language === 'javascript' ? 'mjs' : 'mts';
  return path.join(workDir, `student.${extension}`);
}
async function stageFiles(workDir: string, input: NormalizedRequest): Promise<void> {
  await writeFile(studentFile(workDir, input.language), input.sourceCode, 'utf8');
  const isPython = input.language === 'python';
  const harness = fileURLToPath(new URL(isPython ? './python-harness.py' : './node-harness.mjs', import.meta.url));
  await copyFile(harness, path.join(workDir, isPython ? 'python-harness.py' : 'node-harness.mjs'));
}

function buildPlan(workDir: string, input: NormalizedRequest, kind: 'check' | 'run'): ProcessRunPlan {
  const student = studentFile(workDir, input.language);
  const submode = input.entrypoint === undefined ? 'script' : 'entry';
  const tail = input.entrypoint === undefined ? [] : [input.entrypoint];
  if (input.language === 'python') {
    const executable = pythonCommand();
    const rest = kind === 'check' ? ['check', student]
      : ['run', student, submode, String(Math.ceil(input.limits.timeoutMs / 1000) + 1), String(input.limits.memoryMb), ...tail];
    return { command: executable, args: ['-I', path.join(workDir, 'python-harness.py'), ...rest], env: cleanEnv(workDir, path.dirname(executable)) };
  }
  const rest = kind === 'check' ? ['check', student, input.language] : ['run', student, submode, ...tail];
  return {
    command: process.execPath,
    args: [
      '--no-warnings', '--experimental-vm-modules', `--max-old-space-size=${input.limits.memoryMb}`,
      '--disable-proto=throw', '--no-addons', '--permission', `--allow-fs-read=${workDir}`,
      path.join(workDir, 'node-harness.mjs'), ...rest,
    ],
    env: cleanEnv(workDir),
  };
}
async function spawnWithPlan(plan: ProcessRunPlan, input: NormalizedRequest, workDir: string, timeoutMs: number, stdin?: string): Promise<SpawnedOutcome> {
  const outcome = await runIsolatedProcess({
    command: plan.command, args: plan.args, env: plan.env, cwd: workDir,
    timeoutMs, maxOutputBytes: input.limits.maxOutputBytes,
    ...(stdin === undefined ? {} : { input: stdin }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const memory = extractMemory(outcome.stderr);
  return { ...outcome, stderr: memory.text, rssKb: memory.rssKb };
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

function assembleReport(parts: {
  readonly input: NormalizedRequest; readonly startedAt: number; readonly results: readonly CaseResult[];
  readonly compileError?: string; readonly timedOut?: boolean; readonly peakRssKb?: number; readonly peakMemoryMb?: number;
}): CodeSandboxRunReportWire {
  const cap = parts.input.limits.timeoutMs * (parts.input.cases.length + 1);
  const totalDurationMs = Math.max(0, Math.min(Math.round(Date.now() - parts.startedAt), cap));
  let peakMemoryMb = parts.peakMemoryMb;
  if (peakMemoryMb === undefined && parts.peakRssKb !== undefined && parts.peakRssKb > 0) {
    const mb = Math.round((parts.peakRssKb / 1024) * 100) / 100;
    if (Number.isFinite(mb) && mb <= parts.input.limits.memoryMb * 2) peakMemoryMb = mb;
  }
  return {
    executorKind: isolatedCodeSandboxKind, language: parts.input.language,
    runId: randomUUID(), executedAtIso: new Date(parts.startedAt).toISOString(), totalDurationMs, results: parts.results,
    ...(parts.compileError === undefined ? {} : { compileError: parts.compileError }),
    ...(parts.timedOut === true ? { timedOut: true } : {}),
    ...(peakMemoryMb === undefined ? {} : { peakMemoryMb }),
  };
}

async function runInProcessMode(input: NormalizedRequest): Promise<CodeSandboxRunReportWire> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + totalBudgetOf(input);
  const workDir = await mkdtemp(path.join(await realpath(tmpdir()), 'mangekyo-sandbox-'));
  await chmod(workDir, 0o700);
  const results: CaseResult[] = [];
  let timedOut = false, peakRssKb = 0;
  let compileError: string | undefined;
  try {
    await stageFiles(workDir, input);
    throwIfAborted(input.signal);
    const preBudget = Math.min(5000, Math.max(2000, input.limits.timeoutMs), Math.max(1, deadlineAt - Date.now()));
    const precheck = await spawnWithPlan(buildPlan(workDir, input, 'check'), input, workDir, preBudget);
    if (precheck.kind === 'aborted') throwIfAborted(input.signal);
    peakRssKb = Math.max(peakRssKb, precheck.rssKb);
    if (!(precheck.kind === 'exit' && precheck.exitCode === 0)) {
      const detail = precheck.stderr.trim();
      const fallback = precheck.kind === 'timeout' ? '语法预检超时（疑似资源耗尽构造）。' : '语法预检失败。';
      compileError = capText(detail.length > 0 ? detail : fallback, input.limits.maxOutputBytes);
      for (const testCase of input.cases) {
        results.push({ caseId: testCase.caseId, status: 'syntax_error', durationMs: 0, stderr: compileError, exitCode: precheck.exitCode ?? 1 });
      }
    } else {
      for (const testCase of input.cases) {
        throwIfAborted(input.signal);
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) { timedOut = true; break; }
        const budget = Math.min(input.limits.timeoutMs, remaining);
        const outcome = await spawnWithPlan(buildPlan(workDir, input, 'run'), input, workDir, budget, testCase.input);
        if (outcome.kind === 'aborted') throwIfAborted(input.signal);
        peakRssKb = Math.max(peakRssKb, outcome.rssKb);
        results.push(toCaseResult(testCase.caseId, outcome, input));
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return assembleReport({ input, startedAt, results, timedOut, peakRssKb, ...(compileError === undefined ? {} : { compileError }) });
}

export function buildContainerRunArgs(options: {
  readonly image: string; readonly containerName: string; readonly memoryMb: number;
}): readonly string[] {
  return [
    'run', '--rm', '-i', '--name', options.containerName,
    '--network=none', '--read-only', '--cap-drop=ALL', '--pids-limit=32',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--security-opt=no-new-privileges',
    `--memory=${options.memoryMb}m`, `--memory-swap=${options.memoryMb}m`, '--cpus=0.5', '--user=65534:65534',
    options.image,
  ];
}
type ContainerRow = {
  readonly caseId: string; readonly status: string;
  readonly actualOutput?: string; readonly durationMs?: number; readonly stderr?: string; readonly exitCode?: number;
};
type ContainerReport = {
  readonly compileError?: string; readonly timedOut?: boolean; readonly peakMemoryMb?: number; readonly results: readonly ContainerRow[];
};

function parseContainerReport(stdout: string, input: NormalizedRequest): ContainerReport {
  const lines = stdout.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) throw new CodeSandboxExecutorError('容器未返回任何执行报告。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[lines.length - 1] ?? '');
  } catch {
    throw new CodeSandboxExecutorError('容器执行报告不是合法 JSON。');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Array.isArray((parsed as ContainerReport).results)) {
    throw new CodeSandboxExecutorError('容器执行报告缺少 results 数组。');
  }
  const report = parsed as ContainerReport;
  const knownIds = new Set(input.cases.map(testCase => testCase.caseId));
  for (const result of report.results) {
    if (typeof result.caseId !== 'string' || !knownIds.has(result.caseId)) throw new CodeSandboxExecutorError(`容器执行报告包含未知用例标识：${String(result.caseId)}。`);
    if (!RUN_STATUSES.has(String(result.status))) throw new CodeSandboxExecutorError(`容器执行报告包含非法用例状态：${String(result.status)}。`);
  }
  return report;
}
function containerResultRow(row: ContainerRow, input: NormalizedRequest): CaseResult {
  return {
    caseId: row.caseId, status: row.status as CaseResult['status'],
    ...(row.actualOutput === undefined ? {} : { actualOutput: capText(row.actualOutput, input.limits.maxOutputBytes) }),
    ...(typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? { durationMs: Math.max(0, row.durationMs) } : {}),
    ...(row.stderr === undefined ? {} : { stderr: capText(row.stderr, input.limits.maxOutputBytes) }),
    ...(typeof row.exitCode === 'number' && Number.isInteger(row.exitCode) ? { exitCode: row.exitCode } : {}),
  };
}

async function runInContainerMode(input: NormalizedRequest): Promise<CodeSandboxRunReportWire> {
  const startedAt = Date.now();
  const budget = totalBudgetOf(input);
  const containerName = `mangekyo-sandbox-${randomUUID()}`;
  const args = buildContainerRunArgs({ image: input.containerImage ?? '', containerName, memoryMb: input.limits.memoryMb });
  const payload = JSON.stringify({
    language: input.language, sourceCode: input.sourceCode, limits: input.limits, cases: input.cases, totalTimeoutMs: budget,
    ...(input.entrypoint === undefined ? {} : { entrypoint: input.entrypoint }),
  });
  let outcome: ProcessOutcome;
  try {
    throwIfAborted(input.signal);
    outcome = await runIsolatedProcess({
      command: 'docker', args, env: dockerEnv(), cwd: tmpdir(),
      timeoutMs: budget, maxOutputBytes: MAX_CONTAINER_OUTPUT_BYTES, input: payload,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } finally {
    spawnSync('docker', ['rm', '-f', containerName], { env: dockerEnv(), stdio: 'ignore' });
  }
  if (outcome.kind === 'aborted') throwIfAborted(input.signal);
  const report = parseContainerReport(outcome.stdout, input);
  const peak = report.peakMemoryMb;
  return assembleReport({
    input, startedAt,
    results: report.results.map(row => containerResultRow(row, input)),
    timedOut: report.timedOut === true || outcome.kind === 'timeout',
    ...(typeof report.compileError === 'string' && report.compileError.trim().length > 0
      ? { compileError: capText(report.compileError, input.limits.maxOutputBytes) } : {}),
    ...(typeof peak === 'number' && Number.isFinite(peak) && peak >= 0 && peak <= input.limits.memoryMb * 2 ? { peakMemoryMb: peak } : {}),
  });
}

export async function runCodeSandbox(request: CodeSandboxRunRequest): Promise<CodeSandboxRunReportWire> {
  const input = validateRequest(request);
  throwIfAborted(input.signal);
  if (input.mode === 'container') return runInContainerMode(input);
  return runInProcessMode(input);
}
