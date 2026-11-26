import type { AnswerSlot, AssessmentCriterion } from './assessment-values.ts';
import { fields, list, record, text } from './parse.ts';

export const codeTestSuiteEvaluator = { id: 'code-test-suite', version: '1' } as const;
export const codeLanguages = ['python', 'javascript', 'typescript'] as const;
export const codeCompareModes = ['exact', 'trimmed', 'json_deep', 'numeric_tolerance'] as const;
export const isolatedCodeSandboxExecutorKind = 'isolated-code-sandbox' as const;

export class CodeSandboxExecutorError extends Error {
  constructor(message: string) { super(message); this.name = 'CodeSandboxExecutorError'; }
}

export type CodeLanguage = (typeof codeLanguages)[number];
export type CodeCompareMode = (typeof codeCompareModes)[number];
export type CodeTestCase = {
  readonly caseId: string; readonly input: string; readonly expectedOutput: string; readonly weight: number;
  readonly hidden?: boolean; readonly compareMode?: CodeCompareMode; readonly tolerance?: number;
};
export type CodeSandboxLimits = { readonly timeoutMs: number; readonly memoryMb: number; readonly maxOutputBytes: number };
export type CodeTestSuiteRule = {
  readonly language: CodeLanguage; readonly entrypoint?: string; readonly limits: CodeSandboxLimits;
  readonly cases: readonly CodeTestCase[]; readonly qualitativeDimensions: readonly string[];
};
export type CodeCaseRunStatus = 'passed' | 'failed' | 'timeout' | 'runtime_error' | 'syntax_error' | 'output_limit_exceeded';
export type CodeCaseRunResult = {
  readonly caseId: string; readonly status: CodeCaseRunStatus; readonly actualOutput?: string;
  readonly durationMs?: number; readonly stderr?: string; readonly exitCode?: number;
};
export type CodeSandboxRunReport = {
  readonly executorKind: string; readonly language: CodeLanguage; readonly runId?: string;
  readonly executedAtIso?: string; readonly compileError?: string; readonly timedOut?: boolean;
  readonly totalDurationMs?: number; readonly peakMemoryMb?: number;
  readonly results: readonly CodeCaseRunResult[]; readonly qualitativeDimensions?: readonly string[];
};
export type CodeQualitativeDimensionAssessment = {
  readonly dimension: string; readonly state: 'unknown'; readonly countsTowardMastery: false; readonly reason: string;
};
export type CodeCaseOutcome = {
  readonly caseId: string; readonly hidden: boolean; readonly weight: number; readonly passed: boolean;
  readonly status: CodeCaseRunStatus | 'missing'; readonly durationMs?: number;
  readonly stderr?: string; readonly diagnostic?: string;
};
export type CodeSandboxProjection = {
  readonly criterionId: string; readonly executorKind: 'isolated-code-sandbox'; readonly language: CodeLanguage;
  readonly state: 'scored' | 'partial' | 'ungradable'; readonly proportion: number; readonly earned: number;
  readonly maximum: number; readonly passedCount: number; readonly failedCount: number; readonly totalCount: number;
  readonly missingCaseIds: readonly string[]; readonly compileError?: string; readonly timedOut: boolean;
  readonly totalDurationMs?: number; readonly peakMemoryMb?: number; readonly caseOutcomes: readonly CodeCaseOutcome[];
  readonly qualitativeDimensions: readonly CodeQualitativeDimensionAssessment[];
};

const runStatuses: readonly CodeCaseRunStatus[] = ['passed', 'failed', 'timeout', 'runtime_error', 'syntax_error', 'output_limit_exceeded'];
const isoPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function intInRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}必须是 ${min}..${max} 内的整数。`);
  }
  return value;
}
function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label}必须是非负有限数值。`);
  return value;
}
function requireIso(value: unknown, label: string): string {
  const m = typeof value === 'string' ? isoPattern.exec(value) : null;
  if (!m) throw new Error(`${label}不是合法的 ISO 时间戳。`);
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const maxD = [31, ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  const tz = m[7]!, tzBad = tz !== 'Z' && (Number(tz.slice(1, 3)) > 23 || Number(tz.slice(4, 6)) > 59);
  if (mo < 1 || mo > 12 || d < 1 || d > maxD || h > 23 || mi > 59 || s > 59 || tzBad) throw new Error(`${label}不是合法的 ISO 时间戳。`);
  return value as string;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const match = allowed.find(item => item === value);
  if (match === undefined) throw new Error(`${label}无效。`);
  return match;
}
function dedupeDimensions(values: readonly unknown[] | undefined): readonly string[] {
  if (values === undefined) return [];
  const seen = new Set<string>(), out: string[] = [];
  for (const entry of values) {
    const dim = text(entry, '定性维度').trim();
    if (!seen.has(dim)) { seen.add(dim); out.push(dim); }
  }
  return out;
}
function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((v, i) => jsonDeepEqual(v, right[i]));
  }
  const lKeys = Object.keys(left), rKeys = Object.keys(right);
  return lKeys.length === rKeys.length && lKeys.every(k => Object.hasOwn(right, k) && jsonDeepEqual((left as Record<string, unknown>)[k], (right as Record<string, unknown>)[k]));
}
function outputMatches(testCase: CodeTestCase, actualOutput: string): boolean {
  const mode = testCase.compareMode ?? 'trimmed';
  if (mode === 'exact') return actualOutput === testCase.expectedOutput;
  if (mode === 'trimmed') return actualOutput.trim() === testCase.expectedOutput.trim();
  if (mode === 'json_deep') {
    try { return jsonDeepEqual(JSON.parse(actualOutput), JSON.parse(testCase.expectedOutput)); } catch { return false; }
  }
  const aTrim = actualOutput.trim(), eTrim = testCase.expectedOutput.trim();
  if (!aTrim || !eTrim) return false;
  const actual = Number(aTrim), expected = Number(eTrim), tol = testCase.tolerance ?? 0;
  return Number.isFinite(actual) && Number.isFinite(expected) &&
    (tol === 0 ? Math.abs(actual - expected) === 0 : Math.abs(actual - expected) <= tol + 1e-12);
}
function statusDiagnostic(status: CodeCaseRunStatus): string {
  if (status === 'timeout') return '用例执行超时。';
  if (status === 'syntax_error') return '代码存在语法错误。';
  if (status === 'runtime_error') return '代码运行时发生异常。';
  if (status === 'output_limit_exceeded') return '代码输出超出最大字节限制。';
  return '用例输出与期望不符。';
}

export function parseCodeTestSuiteRule(criterion: AssessmentCriterion): CodeTestSuiteRule {
  if (criterion.evaluator.id !== codeTestSuiteEvaluator.id || criterion.evaluator.version !== codeTestSuiteEvaluator.version) {
    throw new Error('代码测试套件评估必须使用 code-test-suite@1 判定器。');
  }
  if (criterion.maximum === null || !Number.isFinite(criterion.maximum) || criterion.maximum <= 0) {
    throw new Error('代码测试套件评估需要正数冻结满分。');
  }
  if (criterion.inputs.length !== 1) throw new Error('代码测试套件评估只支持单个作答字段。');
  const params = record(criterion.parameters);
  fields(params, 'language', 'entrypoint', 'limits', 'cases', 'qualitativeDimensions');
  const language = choice(params.language, codeLanguages, '代码语言');
  const entrypoint = params.entrypoint === undefined ? undefined : text(params.entrypoint, '代码入口点');
  const rawLimits = record(params.limits);
  fields(rawLimits, 'timeoutMs', 'memoryMb', 'maxOutputBytes');
  const limits: CodeSandboxLimits = Object.freeze({
    timeoutMs: intInRange(rawLimits.timeoutMs, 100, 15000, '超时限制'),
    memoryMb: intInRange(rawLimits.memoryMb, 32, 512, '内存限制'),
    maxOutputBytes: intInRange(rawLimits.maxOutputBytes, 256, 65536, '输出字节限制'),
  });
  const rawCases = list(params.cases);
  if (rawCases.length < 1 || rawCases.length > 64) throw new Error('代码测试套件需要 1..64 个测试用例。');
  const seenIds = new Set<string>();
  const cases: CodeTestCase[] = rawCases.map(entry => {
    const row = record(entry);
    fields(row, 'caseId', 'input', 'expectedOutput', 'weight', 'hidden', 'compareMode', 'tolerance');
    const caseId = text(row.caseId, '用例标识').trim();
    if (seenIds.has(caseId)) throw new Error(`用例标识重复：${caseId}。`);
    seenIds.add(caseId);
    const input = text(row.input, '用例输入', true), expectedOutput = text(row.expectedOutput, '期望输出', true);
    if (typeof row.weight !== 'number' || !Number.isFinite(row.weight) || row.weight <= 0) throw new Error('用例权重必须是正有限数值。');
    if (row.hidden !== undefined && typeof row.hidden !== 'boolean') throw new Error('用例隐藏开关须为布尔值。');
    const compareMode = row.compareMode === undefined ? undefined : choice(row.compareMode, codeCompareModes, '输出比较模式');
    const tolerance = compareMode === 'numeric_tolerance'
      ? nonNegativeFinite(row.tolerance, '数值比较容差')
      : row.tolerance === undefined ? undefined : (() => { throw new Error('tolerance 仅适用于 numeric_tolerance 比较模式。'); })();
    return Object.freeze({
      caseId, input, expectedOutput, weight: row.weight,
      ...(row.hidden === undefined ? {} : { hidden: row.hidden }),
      ...(compareMode === undefined ? {} : { compareMode }),
      ...(tolerance === undefined ? {} : { tolerance }),
    });
  });
  if (!Number.isFinite(cases.reduce((sum, item) => sum + item.weight, 0))) throw new Error('测试用例总权重无效。');
  const qualitativeDimensions = Object.freeze(dedupeDimensions(
    params.qualitativeDimensions === undefined ? undefined : list(params.qualitativeDimensions),
  ));
  return Object.freeze({
    language, ...(entrypoint === undefined ? {} : { entrypoint }), limits, cases: Object.freeze(cases), qualitativeDimensions,
  });
}

export function validateCodeTestSuiteCriterion(criterion: AssessmentCriterion, slots?: readonly AnswerSlot[]): void {
  parseCodeTestSuiteRule(criterion);
  if (slots === undefined) return;
  const { slotId, path } = criterion.inputs[0]!;
  const kind = slots.find(slot => slot.slotId === slotId)?.fields.find(field => field.path === path)?.kind;
  if (!kind) throw new Error(`标准 ${criterion.criterionId} 引用了未声明的作答位或路径。`);
  if (kind !== 'text' && kind !== 'structured') throw new Error('代码测试套件评估仅允许绑定 text 或 structured 作答字段。');
}

export function projectCodeSandboxOutcome(criterion: AssessmentCriterion, report: CodeSandboxRunReport): CodeSandboxProjection {
  if (typeof report !== 'object' || report === null || Array.isArray(report) || report.executorKind !== isolatedCodeSandboxExecutorKind) {
    const actual = typeof report === 'object' && report !== null ? String((report as { executorKind?: unknown }).executorKind) : 'unknown';
    throw new CodeSandboxExecutorError(`拒绝非隔离代码沙箱执行报告（executorKind=${actual}），必须为 ${isolatedCodeSandboxExecutorKind}。`);
  }
  const rule = parseCodeTestSuiteRule(criterion), maximum = criterion.maximum!;
  if (report.language !== rule.language) throw new Error(`执行报告语言（${report.language}）与规则语言（${rule.language}）不一致。`);
  if (report.executedAtIso !== undefined) requireIso(report.executedAtIso, '沙箱执行时间');
  if (report.totalDurationMs !== undefined) nonNegativeFinite(report.totalDurationMs, '总执行耗时');
  if (report.peakMemoryMb !== undefined) nonNegativeFinite(report.peakMemoryMb, '峰值内存');
  if (report.compileError !== undefined) text(report.compileError, '编译错误', true);
  if (report.timedOut !== undefined && typeof report.timedOut !== 'boolean') throw new Error('超时标记须为布尔值。');
  const caseById = new Map(rule.cases.map(item => [item.caseId, item]));
  const resultById = new Map<string, CodeCaseRunResult>();
  for (const entry of list(report.results)) {
    const row = record(entry), caseId = text(row.caseId, '结果用例标识').trim();
    if (!caseById.has(caseId)) throw new Error(`执行报告包含未声明的用例标识：${caseId}。`);
    if (resultById.has(caseId)) throw new Error(`执行报告包含重复的用例标识：${caseId}。`);
    const status = choice(row.status, runStatuses, '用例执行状态');
    const actualOutput = row.actualOutput === undefined ? undefined : text(row.actualOutput, '实际输出', true);
    const durationMs = row.durationMs === undefined ? undefined : nonNegativeFinite(row.durationMs, '用例耗时');
    const stderr = row.stderr === undefined ? undefined : text(row.stderr, '标准错误输出', true);
    if (row.exitCode !== undefined && (typeof row.exitCode !== 'number' || !Number.isInteger(row.exitCode))) {
      throw new Error('退出码必须是整数。');
    }
    resultById.set(caseId, {
      caseId, status, ...(actualOutput === undefined ? {} : { actualOutput }),
      ...(durationMs === undefined ? {} : { durationMs }), ...(stderr === undefined ? {} : { stderr }),
      ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
    });
  }
  const timedOut = report.timedOut === true;
  const hasCompileError = report.compileError !== undefined && report.compileError.trim().length > 0;
  const missingCaseIds: string[] = [];
  const caseOutcomes: CodeCaseOutcome[] = rule.cases.map(testCase => {
    const res = resultById.get(testCase.caseId), hidden = testCase.hidden === true;
    if (!res) {
      missingCaseIds.push(testCase.caseId);
      const diagnostic = hasCompileError ? '因编译/语法错误未执行该用例。' : timedOut ? '因沙箱整体超时未执行该用例。' : '执行报告缺失该用例结果。';
      return Object.freeze({ caseId: testCase.caseId, hidden, weight: testCase.weight, passed: false, status: 'missing' as const, diagnostic });
    }
    let passed = res.status === 'passed', status: CodeCaseRunStatus = res.status, diagnostic: string | undefined;
    if (passed && res.actualOutput !== undefined && !outputMatches(testCase, res.actualOutput)) {
      passed = false; status = 'failed'; diagnostic = `输出核验未通过（模式：${testCase.compareMode ?? 'trimmed'}）。`;
    } else if (!passed) diagnostic = statusDiagnostic(res.status);
    return Object.freeze({
      caseId: testCase.caseId, hidden, weight: testCase.weight, passed, status,
      ...(res.durationMs === undefined ? {} : { durationMs: res.durationMs }),
      ...(res.stderr === undefined ? {} : { stderr: res.stderr }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
  });
  const totalWeight = rule.cases.reduce((sum, item) => sum + item.weight, 0);
  const proportion = caseOutcomes.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0) / totalWeight;
  const state: 'scored' | 'partial' | 'ungradable' =
    !hasCompileError && !timedOut && resultById.size === 0 ? 'ungradable'
      : !hasCompileError && !timedOut && missingCaseIds.length > 0 ? 'partial' : 'scored';
  const qualitativeDimensions: readonly CodeQualitativeDimensionAssessment[] = Object.freeze(
    dedupeDimensions([...rule.qualitativeDimensions, ...(report.qualitativeDimensions === undefined ? [] : list(report.qualitativeDimensions))])
      .map(dimension => Object.freeze({
        dimension, state: 'unknown' as const, countsTowardMastery: false as const,
        reason: '代码沙箱仅产出客观测试结果，定性维度保持 unknown 且不计入掌握度。',
      })),
  );
  return Object.freeze({
    criterionId: criterion.criterionId, executorKind: isolatedCodeSandboxExecutorKind, language: rule.language,
    state, proportion, earned: maximum * proportion, maximum,
    passedCount: caseOutcomes.filter(item => item.passed).length,
    failedCount: caseOutcomes.filter(item => !item.passed && item.status !== 'missing').length,
    totalCount: rule.cases.length, missingCaseIds: Object.freeze(missingCaseIds),
    ...(report.compileError === undefined ? {} : { compileError: report.compileError }), timedOut,
    ...(report.totalDurationMs === undefined ? {} : { totalDurationMs: report.totalDurationMs }),
    ...(report.peakMemoryMb === undefined ? {} : { peakMemoryMb: report.peakMemoryMb }),
    caseOutcomes: Object.freeze(caseOutcomes), qualitativeDimensions,
  });
}
