import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { CodeSandboxRunReportWire } from '@mangekyo/kernel';
import type { NormalizedRequest } from './validate.ts';
import {
  asObject, CONTAINER_NAME_PATTERN, CodeSandboxExecutorError, intInRange, must, validImageRef,
} from './validate.ts';
import type { CaseResult, SpawnedOutcome } from './shared.ts';
import { assembleReport, capText, throwIfAborted, totalBudgetOf } from './shared.ts';
import { dockerEnv, runIsolatedProcess } from './process.ts';
const MAX_CONTAINER_OUTPUT_BYTES = 6 * 1024 * 1024;
const RUN_STATUSES = new Set(['passed', 'failed', 'timeout', 'runtime_error', 'syntax_error', 'output_limit_exceeded']);

export function buildContainerRunArgs(options: {
  readonly image: string;
  readonly containerName: string;
  readonly memoryMb: number;
}): readonly string[] {
  const image = validImageRef(options.image, '容器镜像');
  const nameValid = typeof options.containerName === 'string' && CONTAINER_NAME_PATTERN.test(options.containerName);
  must(nameValid, '容器名称必须是合法的 Docker 标识符。');
  intInRange(options.memoryMb, 32, 512, '容器内存');
  return [
    'run', '--rm', '-i', '--name', options.containerName,
    '--network=none', '--read-only', '--cap-drop=ALL', '--pids-limit=32',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--security-opt=no-new-privileges',
    `--memory=${options.memoryMb}m`, `--memory-swap=${options.memoryMb}m`, '--cpus=0.5', '--user=65534:65534', image,
  ];
}

type ContainerRow = {
  readonly caseId: string;
  readonly status: string;
  readonly actualOutput?: string;
  readonly durationMs?: number;
  readonly stderr?: string;
  readonly exitCode?: number;
};
type ContainerReport = {
  readonly compileError?: string;
  readonly timedOut?: boolean;
  readonly peakMemoryMb?: number;
  readonly results: readonly ContainerRow[];
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
  const report = asObject(parsed, '容器执行报告') as unknown as ContainerReport;
  if (!Array.isArray(report.results)) throw new CodeSandboxExecutorError('容器执行报告缺少 results 数组。');
  const bad = (detail: string): never => { throw new CodeSandboxExecutorError(`容器执行报告校验失败：${detail}。`); };
  if (report.compileError !== undefined && typeof report.compileError !== 'string') bad('compileError 必须是字符串');
  const knownIds = new Set(input.cases.map(testCase => testCase.caseId));
  const seenIds = new Set<string>();
  for (const result of report.results as unknown[]) {
    const row = asObject(result, '容器用例结果');
    if (typeof row.caseId !== 'string' || !knownIds.has(row.caseId)) bad(`未知用例标识 ${String(row.caseId)}`);
    if (seenIds.has(row.caseId as string)) bad(`重复用例标识 ${String(row.caseId)}`);
    seenIds.add(row.caseId as string);
    if (typeof row.status !== 'string' || !RUN_STATUSES.has(row.status)) bad(`非法用例状态 ${String(row.status)}`);
    if (row.actualOutput !== undefined && typeof row.actualOutput !== 'string') bad('actualOutput 必须是字符串');
    if (row.stderr !== undefined && typeof row.stderr !== 'string') bad('stderr 必须是字符串');
    const badDuration = typeof row.durationMs !== 'number' || !Number.isFinite(row.durationMs) || row.durationMs < 0;
    if (row.durationMs !== undefined && badDuration) bad('durationMs 必须是非负有限数');
  }
  return report;
}

function containerResultRow(row: ContainerRow, input: NormalizedRequest): CaseResult {
  return {
    caseId: row.caseId, status: row.status as CaseResult['status'],
    ...(row.actualOutput === undefined ? {} : { actualOutput: capText(row.actualOutput, input.limits.maxOutputBytes) }),
    ...(row.durationMs === undefined ? {} : { durationMs: Math.max(0, row.durationMs) }),
    ...(row.stderr === undefined ? {} : { stderr: capText(row.stderr, input.limits.maxOutputBytes) }),
    ...(Number.isInteger(row.exitCode) ? { exitCode: row.exitCode } : {}),
  };
}

// Async cleanup: the execFile timeout SIGKILLs a wedged docker client without blocking the event loop.
async function forceRemoveContainer(containerName: string): Promise<void> {
  await promisify(execFile)('docker', ['rm', '-f', containerName], { env: dockerEnv(), timeout: 3000 }).catch(() => undefined);
}

// Container mode boundary: the student payload crosses into a network-less,
// read-only, capability-less container as a JSON stdin envelope; nothing from the
// host filesystem or environment is mounted or forwarded, and the container is
// force-removed even on timeouts, output floods and aborts.
export async function runInContainerMode(input: NormalizedRequest): Promise<CodeSandboxRunReportWire> {
  const startedAt = Date.now();
  const budget = totalBudgetOf(input);
  const containerName = `mangekyo-sandbox-${randomUUID()}`;
  const args = buildContainerRunArgs({ image: input.containerImage ?? '', containerName, memoryMb: input.limits.memoryMb });
  const payload = JSON.stringify({
    language: input.language, sourceCode: input.sourceCode, limits: input.limits, cases: input.cases, totalTimeoutMs: budget,
    ...(input.entrypoint === undefined ? {} : { entrypoint: input.entrypoint }),
  });
  let outcome: SpawnedOutcome;
  try {
    throwIfAborted(input.signal);
    outcome = await runIsolatedProcess({
      command: 'docker', args, env: dockerEnv(), cwd: tmpdir(),
      timeoutMs: budget, maxOutputBytes: MAX_CONTAINER_OUTPUT_BYTES, input: payload,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } finally {
    await forceRemoveContainer(containerName);
  }
  if (outcome.kind === 'aborted') throwIfAborted(input.signal);
  if (outcome.kind === 'output_limit') {
    throw new CodeSandboxExecutorError('容器输出超出限值，执行报告不可信，已拒绝评分。');
  }
  let report: ContainerReport;
  try {
    report = parseContainerReport(outcome.stdout, input);
  } catch (error) {
    if (outcome.kind === 'timeout' && error instanceof CodeSandboxExecutorError) {
      return assembleReport({ input, startedAt, results: [], timedOut: true });
    }
    throw error;
  }
  const peak = report.peakMemoryMb;
  const peakValid = typeof peak === 'number' && Number.isFinite(peak) && peak >= 0 && peak <= input.limits.memoryMb * 2;
  const peakMemoryMb = peakValid ? peak : undefined;
  const compileError = typeof report.compileError === 'string' && report.compileError.trim().length > 0
    ? { compileError: capText(report.compileError, input.limits.maxOutputBytes) } : {};
  return assembleReport({
    input, startedAt,
    results: report.results.map(row => containerResultRow(row, input)),
    timedOut: report.timedOut === true || outcome.kind === 'timeout',
    ...compileError,
    ...(peakMemoryMb === undefined ? {} : { peakMemoryMb }),
  });
}
