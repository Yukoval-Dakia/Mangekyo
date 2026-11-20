export const examPacingMethod = 'plan/exam-pacing@1';

type Score = { earned: number; maximum: number };
type InputRow = { id: string; effective_duration_ms?: number | null; score?: Score | null };
const fields = ['effective_duration_ms', 'score'] as const;
type ObservedRow = { id: string; kind: 'observed'; effective_duration_ms: number; score: Score; score_rate: number };
type UnknownRow = { id: string; kind: 'unknown'; missing: (typeof fields)[number][] };
type Comparison = {
  slower_attempt_id: string;
  faster_attempt_id: string;
  extra_duration_ms: number;
  score_rate_gap: number;
};

export type ExamPacingInput = { attempts: InputRow[] };
export type ExamPacingResult = {
  method_version: typeof examPacingMethod;
  attempts: (ObservedRow | UnknownRow)[];
  strategy:
    | { kind: 'unknown'; reason: 'insufficient-comparable-attempts' }
    | { kind: 'observed'; comparisons: Comparison[] };
};

function record(value: unknown, required: readonly string[], optional: readonly string[] = []):
  value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function duration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 86_400_000;
}

function score(value: unknown): value is Score {
  return record(value, ['earned', 'maximum']) && typeof value.maximum === 'number' &&
    Number.isFinite(value.maximum) && value.maximum > 0 &&
    typeof value.earned === 'number' && value.earned >= 0 && value.earned <= value.maximum;
}

function attempts<T extends { id: string }>(value: unknown, valid: (row: unknown) => row is T): value is T[] {
  return Array.isArray(value) && value.length <= 8 && [...value].every(valid) &&
    new Set(value.map(row => row.id)).size === value.length;
}

function inputRow(value: unknown): value is InputRow {
  return record(value, ['id'], fields) && typeof value.id === 'string' && !!value.id.trim() &&
    (!Object.hasOwn(value, 'effective_duration_ms') || value.effective_duration_ms === null ||
      duration(value.effective_duration_ms)) &&
    (!Object.hasOwn(value, 'score') || value.score === null || score(value.score));
}

export function isExamPacingInput(value: unknown): value is ExamPacingInput {
  return record(value, ['attempts']) && attempts(value.attempts, inputRow);
}

function outputRow(value: unknown): value is ObservedRow | UnknownRow {
  if (record(value, ['id', 'kind', 'missing']) && value.kind === 'unknown') {
    const missing = value.missing;
    if (typeof value.id !== 'string' || !value.id.trim() || !Array.isArray(missing) || !missing.length) return false;
    const listed = fields.filter(key => missing.includes(key));
    return listed.length === missing.length && listed.every((key, i) => key === missing[i]);
  }
  return record(value, ['id', 'kind', ...fields, 'score_rate']) && typeof value.id === 'string' && !!value.id.trim() &&
    value.kind === 'observed' && duration(value.effective_duration_ms) && score(value.score) &&
    value.score_rate === value.score.earned / value.score.maximum;
}

export function isExamPacingResult(value: unknown, input?: ExamPacingInput): value is ExamPacingResult {
  if (!record(value, ['method_version', 'attempts', 'strategy']) || value.method_version !== examPacingMethod ||
      !attempts(value.attempts, outputRow)) return false;
  if (input && (value.attempts.length !== input.attempts.length || !value.attempts.every((row, index) => {
    const supplied = input.attempts[index];
    if (!supplied || row.id !== supplied.id) return false;
    if (row.kind === 'unknown') return fields.every(key => row.missing.includes(key) === (supplied[key] == null));
    return row.effective_duration_ms === supplied.effective_duration_ms &&
      row.score.earned === supplied.score?.earned && row.score.maximum === supplied.score.maximum;
  }))) return false;
  const observed = value.attempts.filter(row => row.kind === 'observed');
  const strategy = value.strategy;
  const candidates = observed.flatMap((first, i) =>
    observed.slice(i + 1).filter(second => first.score.maximum === second.score.maximum).map(second =>
      first.effective_duration_ms <= second.effective_duration_ms ? [first, second] as const : [second, first] as const));
  if (!candidates.length) {
    return record(strategy, ['kind', 'reason']) && strategy.kind === 'unknown' &&
      strategy.reason === 'insufficient-comparable-attempts';
  }
  if (!record(strategy, ['kind', 'comparisons']) || strategy.kind !== 'observed' ||
      !Array.isArray(strategy.comparisons)) return false;
  const comparisons: unknown[] = strategy.comparisons;
  const observedRegressions = candidates.filter(([faster, slower]) =>
    faster.effective_duration_ms < slower.effective_duration_ms && faster.score.earned >= slower.score.earned);
  return comparisons.length === observedRegressions.length && observedRegressions.every(([faster, slower], i) => {
    const row = comparisons[i];
    return record(row, ['slower_attempt_id', 'faster_attempt_id', 'extra_duration_ms', 'score_rate_gap']) &&
      row.slower_attempt_id === slower.id && row.faster_attempt_id === faster.id &&
      row.extra_duration_ms === slower.effective_duration_ms - faster.effective_duration_ms &&
      row.score_rate_gap === faster.score_rate - slower.score_rate;
  });
}
