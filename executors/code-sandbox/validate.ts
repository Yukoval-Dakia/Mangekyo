import type { CodeLanguageWire } from '@mangekyo/kernel';

export class CodeSandboxInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeSandboxInputError';
  }
}
export class CodeSandboxExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeSandboxExecutorError';
  }
}

export type CodeSandboxCaseInput = { readonly caseId: string; readonly input: string };
export type CodeSandboxLimitsInput = {
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly maxOutputBytes: number;
};
export type CodeSandboxMode = 'process' | 'container';
export type CodeSandboxRunRequest = {
  readonly language: CodeLanguageWire;
  readonly sourceCode: string;
  readonly limits: CodeSandboxLimitsInput;
  readonly cases: readonly CodeSandboxCaseInput[];
  readonly entrypoint?: string;
  readonly mode?: CodeSandboxMode;
  readonly containerImage?: string;
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
};
export type NormalizedRequest = Omit<CodeSandboxRunRequest, 'mode'> & { readonly mode: CodeSandboxMode };
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_CASE_INPUT_BYTES = 256 * 1024;
const MAX_CASE_ID_LENGTH = 128;
const LANGUAGES: readonly CodeLanguageWire[] = ['python', 'javascript', 'typescript'];
const ENTRYPOINT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const IMAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/;
export const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const BLOCKED_ENTRYPOINTS = new Set([
  '__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'eval', 'exec',
  '__import__', '__builtins__', 'globalThis', 'process', 'require', 'module', 'exports',
]);
const REQUEST_KEYS = new Set([
  'language', 'sourceCode', 'limits', 'cases', 'entrypoint', 'mode', 'containerImage', 'totalTimeoutMs', 'signal',
]);
const LIMIT_KEYS = new Set(['timeoutMs', 'memoryMb', 'maxOutputBytes']);
const CASE_KEYS = new Set(['caseId', 'input']);

export function must(ok: unknown, message: string): asserts ok {
  if (!ok) throw new CodeSandboxInputError(message);
}
export function asObject(value: unknown, label: string): Record<string, unknown> {
  const invalid = typeof value !== 'object' || value === null || Array.isArray(value);
  if (invalid) throw new CodeSandboxInputError(`${label}必须是对象。`);
  return value as Record<string, unknown>;
}
export function intInRange(value: unknown, min: number, max: number, label: string): number {
  const valid = typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  must(valid, `${label}必须是 ${min}..${max} 内的整数。`);
  return value;
}
export function validImageRef(image: unknown, label: string): string {
  const valid = typeof image === 'string' && IMAGE_PATTERN.test(image) && !image.includes('..');
  must(valid, `${label}必须是合法的 OCI 镜像引用。`);
  return image;
}
function onlyKeys(row: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(row)) {
    must(allowed.has(key), `${label}禁止携带额外字段：${key}。`);
  }
}
function validateCase(entry: unknown, index: number, seen: Set<string>): CodeSandboxCaseInput {
  const row = asObject(entry, `用例 ${index}`);
  const spoiler = '用例输入禁止携带 expectedOutput/hidden 剧透字段，请在调用执行器前剥离评分数据。';
  must(!('expectedOutput' in row) && !('hidden' in row), spoiler);
  onlyKeys(row, CASE_KEYS, `用例 ${index}`);
  must(typeof row.caseId === 'string', `用例 ${index} 缺少字符串标识。`);
  const caseId = row.caseId.trim();
  must(caseId.length > 0 && caseId.length <= MAX_CASE_ID_LENGTH, `用例 ${index} 标识为空或超长。`);
  must(!/[\x00-\x1f\x7f]/.test(caseId), `用例 ${index} 标识不得包含控制字符。`);
  must(!seen.has(caseId), `用例标识重复：${caseId}。`);
  seen.add(caseId);
  must(typeof row.input === 'string', `用例 ${caseId} 输入必须是字符串。`);
  must(Buffer.byteLength(row.input, 'utf8') <= MAX_CASE_INPUT_BYTES, `用例 ${caseId} 输入超出大小上限。`);
  return Object.freeze({ caseId, input: row.input });
}

function validateCases(rawCases: unknown): readonly CodeSandboxCaseInput[] {
  must(Array.isArray(rawCases) && rawCases.length >= 1 && rawCases.length <= 64, '需要 1..64 个测试用例。');
  const seen = new Set<string>();
  const rows: CodeSandboxCaseInput[] = [];
  const list = rawCases as readonly unknown[];
  for (let i = 0; i < list.length; i += 1) {
    must(Object.prototype.hasOwnProperty.call(list, i), `用例数组第 ${i} 项为空洞，禁止稀疏数组。`);
    rows.push(validateCase(list[i], i, seen));
  }
  return Object.freeze(rows);
}

function validateEntrypoint(raw: Record<string, unknown>): string | undefined {
  if (raw.entrypoint === undefined) return undefined;
  must(typeof raw.entrypoint === 'string' && ENTRYPOINT_PATTERN.test(raw.entrypoint), '代码入口点必须是合法的标识符。');
  const reserved = BLOCKED_ENTRYPOINTS.has(raw.entrypoint) || (raw.entrypoint.startsWith('__') && raw.entrypoint.endsWith('__'));
  must(!reserved, `代码入口点命中保留名称：${raw.entrypoint}。`);
  return raw.entrypoint;
}

export function validateRequest(request: CodeSandboxRunRequest): NormalizedRequest {
  const raw = asObject(request, '执行请求');
  onlyKeys(raw, REQUEST_KEYS, '执行请求');
  must(LANGUAGES.includes(raw.language as CodeLanguageWire), '代码语言必须是 python/javascript/typescript。');
  must(typeof raw.sourceCode === 'string', '学生源码必须是字符串。');
  must(Buffer.byteLength(raw.sourceCode, 'utf8') <= MAX_SOURCE_BYTES, '学生源码超出 256KiB 大小上限。');
  const limitRow = asObject(raw.limits, '资源限制');
  onlyKeys(limitRow, LIMIT_KEYS, '资源限制');
  const limits = Object.freeze({
    timeoutMs: intInRange(limitRow.timeoutMs, 100, 15000, '超时限制'),
    memoryMb: intInRange(limitRow.memoryMb, 32, 512, '内存限制'),
    maxOutputBytes: intInRange(limitRow.maxOutputBytes, 256, 65536, '输出字节限制'),
  });
  const cases = validateCases(raw.cases);
  const entrypoint = validateEntrypoint(raw);
  const mode = raw.mode === undefined ? 'process' : raw.mode;
  must(mode === 'process' || mode === 'container', '执行模式必须是 process 或 container。');
  let containerImage: string | undefined;
  if (raw.containerImage !== undefined) containerImage = validImageRef(raw.containerImage, '容器镜像');
  must(mode !== 'container' || containerImage !== undefined, '容器模式必须提供 containerImage。');
  let totalTimeoutMs: number | undefined;
  if (raw.totalTimeoutMs !== undefined) {
    totalTimeoutMs = intInRange(raw.totalTimeoutMs, 1, limits.timeoutMs * (cases.length + 1), '总超时预算');
  }
  must(raw.signal === undefined || raw.signal instanceof AbortSignal, 'signal 必须是 AbortSignal。');
  return {
    language: raw.language as CodeLanguageWire, sourceCode: raw.sourceCode, limits, cases, mode,
    ...(entrypoint === undefined ? {} : { entrypoint }), ...(containerImage === undefined ? {} : { containerImage }),
    ...(totalTimeoutMs === undefined ? {} : { totalTimeoutMs }), ...(raw.signal === undefined ? {} : { signal: raw.signal as AbortSignal }),
  };
}
