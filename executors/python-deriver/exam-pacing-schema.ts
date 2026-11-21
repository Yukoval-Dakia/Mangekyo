import type { CanonicalEvidenceSliceV1, EvidenceEventV1 } from '@mangekyo/kernel';
import { isCanonicalEvidenceSlice } from './schema.ts';

export const examPacingMethod = 'plan/exam-pacing@1';

type Score = { earned: number; maximum: number };
type InputRow = { id: string; effective_duration_ms?: number | null; score?: Score | null };
type ExamBasis = { paper_key: string; scale_key: string };
type PacingEvidence = Partial<ExamBasis> & { score?: Score };
type PacingEvent = EvidenceEventV1 & { readonly exam_pacing?: PacingEvidence };
type PacingSlice = Omit<CanonicalEvidenceSliceV1, 'events'> & { readonly events: readonly PacingEvent[] };
const fields = ['effective_duration_ms', 'score'] as const;
const basis = ['paper_key', 'scale_key'] as const;
const canonicalFields = [...fields, ...basis] as const;
type ObservedRow = { id: string; kind: 'observed'; effective_duration_ms: number; score: Score; score_rate: number } & Partial<ExamBasis>;
type UnknownRow = { id: string; kind: 'unknown'; missing: (typeof canonicalFields)[number][] };
type Comparison = {
  slower_attempt_id: string;
  faster_attempt_id: string;
  extra_duration_ms: number;
  score_rate_gap: number;
};

export type ExamPacingInput = { attempts: InputRow[] } | PacingSlice;
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

function key(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}

type TaggedEvent = PacingEvent & { readonly exam_pacing: PacingEvidence };
function eligibleEvents(input: PacingSlice) {
  const deadlines = new Map<string, number>();
  for (const {ref, at} of input.constraints.deadlines) {
    deadlines.set(ref, Math.min(deadlines.get(ref) ?? Infinity, Date.parse(at)));
  }
  const omitted = new Set(input.omissions?.map(({ref}) => JSON.stringify([ref.id, ref.rev])));
  const cutoff = Date.parse(input.as_of_at);
  return input.events.filter((event): event is TaggedEvent => {
    const details = event.exam_pacing;
    if (!details || omitted.has(JSON.stringify([event.ref, event.rev]))) return false;
    const paperCutoff = details.paper_key === undefined ? Infinity : deadlines.get(details.paper_key) ?? Infinity;
    return Date.parse(event.occurred_at) <= Math.min(cutoff, paperCutoff, deadlines.get(event.ref) ?? Infinity);
  });
}

function pacingRows(input: ExamPacingInput) {
  if ('attempts' in input) return input.attempts.map(row => ({ row, required: fields }));
  return eligibleEvents(input)
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
    .slice(0, 8)
    .map(event => ({
      row: { id: event.ref, ...event.exam_pacing,
        ...(duration(event.effective_duration_ms) ? {effective_duration_ms: event.effective_duration_ms} : {}) },
      required: canonicalFields,
    }));
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
  if (record(value, ['attempts'])) return attempts(value.attempts, inputRow);
  if (!isCanonicalEvidenceSlice(value)) return false;
  const slice: PacingSlice = value;
  if (!slice.events.every(event => {
    const details = event.exam_pacing;
    return details === undefined || (key(event.ref) && record(details, [], [...basis, 'score']) &&
      basis.every(field => !Object.hasOwn(details, field) || key(details[field])) &&
      (!Object.hasOwn(details, 'score') || score(details.score)));
  })) return false;
  const refs = eligibleEvents(slice).map(event => event.ref);
  return new Set(refs).size === refs.length;
}

function outputRow(value: unknown): value is ObservedRow | UnknownRow {
  if (record(value, ['id', 'kind', 'missing']) && value.kind === 'unknown') {
    const missing = value.missing;
    if (typeof value.id !== 'string' || !value.id.trim() || !Array.isArray(missing) || !missing.length) return false;
    const listed = canonicalFields.filter(key => missing.includes(key));
    return listed.length === missing.length && listed.every((key, i) => key === missing[i]);
  }
  return record(value, ['id', 'kind', ...fields, 'score_rate'], basis) && key(value.id) &&
    (basis.every(field => key(value[field])) || basis.every(field => !Object.hasOwn(value, field))) &&
    value.kind === 'observed' && duration(value.effective_duration_ms) && score(value.score) &&
    value.score_rate === value.score.earned / value.score.maximum;
}

export function isExamPacingResult(value: unknown, input?: ExamPacingInput): value is ExamPacingResult {
  if (!record(value, ['method_version', 'attempts', 'strategy']) || value.method_version !== examPacingMethod ||
      !attempts(value.attempts, outputRow)) return false;
  if (input) {
    const supplied = pacingRows(input);
    if (value.attempts.length !== supplied.length || !value.attempts.every((row, index) => {
      const source = supplied[index]!;
      const expected: InputRow & Partial<ExamBasis> = source.row;
      if (row.id !== expected.id) return false;
      const missing = source.required.filter(field => expected[field] == null);
      if (row.kind === 'unknown') return missing.length === row.missing.length && missing.every((field, i) => field === row.missing[i]);
      return missing.length === 0 && row.effective_duration_ms === expected.effective_duration_ms &&
        basis.every(field => row[field] === expected[field]) &&
        row.score.earned === expected.score?.earned && row.score.maximum === expected.score?.maximum;
    })) return false;
  }
  const observed = value.attempts.filter(row => row.kind === 'observed');
  const strategy = value.strategy;
  const candidates = observed.flatMap((first, i) =>
    observed.slice(i + 1).filter(second => first.score.maximum === second.score.maximum &&
      basis.every(field => first[field] === second[field])).map(second =>
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
