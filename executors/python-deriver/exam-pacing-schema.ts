import { isDeepStrictEqual } from 'node:util';
import { isCanonicalEvidenceSlice, type ItemPacingEvidence, type WireSlice as PacingSlice } from './schema.ts';

export const examPacingMethod = 'plan/exam-pacing@1';

type Score = { earned: number; maximum: number };
type InputRow = { id: string; effective_duration_ms?: number | null; score?: Score | null };
type ExamBasis = { paper_key: string; scale_key: string };
type PacingEvent = PacingSlice['events'][number];
type PacingEvidence = NonNullable<PacingEvent['exam_pacing']>;
type Ref = ItemPacingEvidence['attempt_ref'];
type ItemAnchor = Pick<ItemPacingEvidence, 'item_id' | 'position'> & { evidence_ref: Ref; occurred_at: string };
type ProcessItem = ItemAnchor & Pick<ItemPacingEvidence, 'skipped' | 'returned' | 'estimated_duration_ms'> & {
  effective_duration_ms?: number;
  over_estimate?: boolean;
  later_score_context?: 'timely-skip-with-later-credit' | 'overrun-with-later-shortfall';
};
type Observations<Item> = { kind: 'unknown' } | { kind: 'observed'; items: Item[] };
type WithinAttempt = {
  attempt_ref: Ref;
  process: Observations<ProcessItem>;
  later_scores: Observations<ItemAnchor & { score: Score }>;
};
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
  within_attempt?: WithinAttempt[];
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

function itemDuration(value: unknown): value is number {
  return value === 0 || duration(value);
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
function evidenceWindow(input: PacingSlice) {
  const deadlines = new Map<string, number>();
  for (const {ref, at} of input.constraints.deadlines) {
    deadlines.set(ref, Math.min(deadlines.get(ref) ?? Infinity, Date.parse(at)));
  }
  const omitted = new Set(input.omissions?.map(({ref}) => JSON.stringify([ref.id, ref.rev])));
  const cutoff = Date.parse(input.as_of_at);
  return (event: PacingEvent, ...refs: (string | undefined)[]) =>
    !omitted.has(JSON.stringify([event.ref, event.rev])) && Date.parse(event.occurred_at) <=
      Math.min(cutoff, deadlines.get(event.ref) ?? Infinity, ...refs.map(ref => ref === undefined ? Infinity : deadlines.get(ref) ?? Infinity));
}

function eligibleEvents(input: PacingSlice) {
  const eligible = evidenceWindow(input);
  return input.events.filter((event): event is TaggedEvent => !!event.exam_pacing && eligible(event, event.exam_pacing.paper_key));
}

function recentAttempts(input: PacingSlice) {
  return eligibleEvents(input).sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, 8);
}

function pacingRows(input: ExamPacingInput) {
  if ('attempts' in input) return input.attempts.map(row => ({ row, required: fields }));
  return recentAttempts(input)
    .map(event => ({
      row: { id: event.ref, ...event.exam_pacing,
        ...(duration(event.effective_duration_ms) ? {effective_duration_ms: event.effective_duration_ms} : {}) },
      required: canonicalFields,
    }));
}

function itemAnchor(event: PacingEvent, { item_id, position }: ItemPacingEvidence): ItemAnchor {
  return { item_id, position, evidence_ref: { id: event.ref, rev: event.rev }, occurred_at: event.occurred_at };
}

function observations<Item>(items: Item[]): Observations<Item> {
  return items.length ? { kind: 'observed', items } : { kind: 'unknown' };
}

function withinAttempt(input: ExamPacingInput): WithinAttempt[] | undefined {
  if ('attempts' in input) return undefined;
  const eligible = evidenceWindow(input);
  const items = input.events.flatMap(event => {
    const item = event.exam_pacing_item;
    return item && eligible(event, item.paper_key, item.attempt_ref.id) ? [{event, item}] : [];
  });
  if (!items.length) return undefined;
  return recentAttempts(input).map(attempt => {
    const { paper_key, scale_key } = attempt.exam_pacing;
    const submittedAt = Date.parse(attempt.occurred_at);
    const matching = items.flatMap(({event, item}) => {
      if (item.attempt_ref.id !== attempt.ref || item.attempt_ref.rev !== attempt.rev ||
          item.paper_key !== paper_key) return [];
      const time = Date.parse(event.occurred_at);
      // Process precedes submission. A formal score may settle later within the evidence window.
      const process = time <= submittedAt && (item.skipped || item.returned || itemDuration(event.effective_duration_ms));
      const score = time >= submittedAt && scale_key === item.scale_key ? item.score : undefined;
      return process || score ? [{event, item, process, score}] : [];
    });
    const count = matching[0]?.item.item_count ?? 0;
    const positions = new Map<number, string>();
    const ids = new Map<string, number>();
    const process: ProcessItem[] = [];
    const scores = new Map<number, ItemAnchor & { score: Score }>();
    const processIds = new Set<string>();
    let duplicateScore = false;
    const halfway = Math.ceil(count / 2);
    const attempt_ref = { id: attempt.ref, rev: attempt.rev };
    for (const {event, item, process: hasProcess, score} of matching) {
      const {item_id, position, skipped, returned, estimated_duration_ms: estimate} = item;
      if (item.item_count !== count || (positions.get(position) ?? item_id) !== item_id ||
          (ids.get(item_id) ?? position) !== position) {
        return { attempt_ref, process: {kind: 'unknown'}, later_scores: {kind: 'unknown'} };
      }
      positions.set(position, item_id);
      ids.set(item_id, position);
      const elapsed = event.effective_duration_ms;
      const anchor = itemAnchor(event, item);
      if (hasProcess) {
        if (processIds.has(item_id)) return {attempt_ref, process: {kind: 'unknown'}, later_scores: {kind: 'unknown'}};
        processIds.add(item_id);
        process.push({ ...anchor, ...(skipped ? {skipped} : {}), ...(returned ? {returned} : {}),
          ...(estimate === undefined ? {} : {estimated_duration_ms: estimate}),
          ...(itemDuration(elapsed) ? {effective_duration_ms: elapsed,
            ...(estimate === undefined ? {} : {over_estimate: 5 * elapsed > 9 * estimate})} : {}) });
      }
      if (position > halfway && score) {
        duplicateScore ||= scores.has(position);
        scores.set(position, { ...anchor, score });
      }
    }
    const later = !duplicateScore && scores.size === count - halfway
      ? [...scores.values()].sort((a, b) => a.position - b.position) : [];
    const earnedLater = later.some(row => row.score.earned > 0);
    const missedLater = later.some(row => row.score.earned < row.score.maximum);
    for (const row of process) {
      if (row.position > halfway) continue;
      if (row.skipped && row.over_estimate === false && earnedLater) row.later_score_context = 'timely-skip-with-later-credit';
      if (row.over_estimate && missedLater) row.later_score_context = 'overrun-with-later-shortfall';
    }
    return { attempt_ref, process: observations(process), later_scores: observations(later) };
  });
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
    const item = event.exam_pacing_item;
    const details = event.exam_pacing;
    if (item) return key(event.ref) && key(item.item_id) && item.position <= item.item_count &&
      (item.score === undefined || key(item.scale_key)) &&
      (event.effective_duration_ms === undefined || itemDuration(event.effective_duration_ms));
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
  if (!record(value, ['method_version', 'attempts', 'strategy'], ['within_attempt']) || value.method_version !== examPacingMethod ||
      !attempts(value.attempts, outputRow)) return false;
  const within = input && withinAttempt(input);
  if (within === undefined ? Object.hasOwn(value, 'within_attempt') : !isDeepStrictEqual(value.within_attempt, within)) return false;
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

export const examTimeValueMethod = 'plan/exam-pacing@2';
export type ExamTimeValueInput = { readonly slice: PacingSlice; readonly attempt_ref: Ref };
type TimeValueState = 'steady' | 'fast-slip' | 'time-sink' | 'recovered-skip' | 'unknown';
type TimeValueItem = {
  readonly item_id: string;
  readonly position: number;
  readonly effective_duration_ms: number;
  readonly state: TimeValueState;
};

export type ExamTimeValueResult = {
  readonly method_version: typeof examTimeValueMethod;
  readonly attempt_ref: Ref;
} & ({ readonly kind: 'unknown' } | {
  readonly kind: 'observed';
  readonly items: readonly TimeValueItem[];
  readonly total_duration_ms: number;
  readonly summary: string;
});

export function isExamTimeValueInput(value: unknown): value is ExamTimeValueInput {
  return record(value, ['slice', 'attempt_ref']) && record(value.attempt_ref, ['id', 'rev']) &&
    key(value.attempt_ref.id) && typeof value.attempt_ref.rev === 'number' &&
    Number.isSafeInteger(value.attempt_ref.rev) && value.attempt_ref.rev > 0 && isCanonicalEvidenceSlice(value.slice);
}

type ItemEvent = PacingEvent & { readonly exam_pacing_item: ItemPacingEvidence };
type ItemRole = 'process' | 'estimate' | 'formal';

function itemEventRole(event: ItemEvent, submittedAt: number, scaleKey: string | undefined): ItemRole | undefined {
  const item = event.exam_pacing_item;
  const at = Date.parse(event.occurred_at);
  const process = event.effective_duration_ms !== undefined || item.skipped === true;
  const estimate = item.estimated_duration_ms !== undefined;
  const formal = item.score !== undefined;
  if (Number(process) + Number(estimate) + Number(formal) !== 1) return undefined;
  if (process && at <= submittedAt) return 'process';
  if (estimate && at <= submittedAt) return 'estimate';
  if (formal && at >= submittedAt && scaleKey && item.scale_key === scaleKey) return 'formal';
  return undefined;
}

function timeValueState(process: ItemEvent, elapsed: number, formal?: ItemEvent | null, estimate?: ItemEvent | null): TimeValueState {
  const score = formal?.exam_pacing_item.score;
  if (!score) return 'unknown';
  const { skipped, returned } = process.exam_pacing_item;
  if (skipped && returned && score.earned > 0) return 'recovered-skip';
  if (score.earned === score.maximum) return 'steady';
  const expected = estimate?.exam_pacing_item.estimated_duration_ms;
  if (expected === undefined) return 'unknown';
  if (5 * elapsed > 9 * expected) return 'time-sink';
  if (elapsed < expected && (formal.error_stage === 'reading' || formal.error_stage === 'execution')) return 'fast-slip';
  return 'unknown';
}

function timeValueSummary(items: readonly TimeValueItem[]): string {
  const count = (state: TimeValueState) => items.filter(item => item.state === state).length;
  return `本卷有 ${count('steady')} 题拿满分、${count('fast-slip')} 题低耗时失分、${count('time-sink')} 题超估时失分、` +
    `${count('recovered-skip')} 题回访得分，另有 ${count('unknown')} 题节奏未确认。`;
}

function expectedTimeValue({slice, attempt_ref}: ExamTimeValueInput): ExamTimeValueResult {
  const base = { method_version: examTimeValueMethod, attempt_ref } as const;
  const unknown = { ...base, kind: 'unknown' } as const;
  const matchesRef = (ref: Ref) => ref.id === attempt_ref.id && ref.rev === attempt_ref.rev;
  const attempts = eligibleEvents(slice).filter(event => matchesRef({ id: event.ref, rev: event.rev }));
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt) return unknown;
  const { paper_key, scale_key } = attempt.exam_pacing;
  if (!key(paper_key)) return unknown;
  const eligible = evidenceWindow(slice);
  const submittedAt = Date.parse(attempt.occurred_at);
  const rows = new Map<string, { process: ItemEvent; formal?: ItemEvent | null; estimate?: ItemEvent | null }>();
  const positions = new Set<number>();
  const counts = new Set<number>();
  const classifications: { role: 'formal' | 'estimate'; event: ItemEvent }[] = [];
  for (const event of slice.events) {
    const item = event.exam_pacing_item;
    if (!item || !matchesRef(item.attempt_ref) || item.paper_key !== paper_key ||
      !eligible(event, paper_key, attempt_ref.id)) continue;
    const typedEvent = { ...event, exam_pacing_item: item };
    const role = itemEventRole(typedEvent, submittedAt, scale_key);
    if (!role || !key(event.ref)) continue;
    if (role !== 'process') {
      classifications.push({ role, event: typedEvent });
      continue;
    }
    const { item_id, position, item_count } = item;
    if (!key(item_id) || rows.has(item_id) || positions.has(position)) return unknown;
    positions.add(position);
    counts.add(item_count);
    rows.set(item_id, { process: typedEvent });
  }
  if (counts.size !== 1 || !counts.has(positions.size)) return unknown;

  // Process rows projected from the frozen paper define coverage and order.
  for (const { role, event } of classifications) {
    const item = event.exam_pacing_item;
    const row = rows.get(item.item_id);
    if (!row) continue;
    const anchor = row.process.exam_pacing_item;
    if (item.position !== anchor.position || item.item_count !== anchor.item_count || event.ref === row.process.ref) continue;
    row[role] = role in row ? null : event;
  }
  const items: TimeValueItem[] = [];
  let total_duration_ms = 0;
  for (const [item_id, {process, formal, estimate}] of rows) {
    const elapsed = process.effective_duration_ms;
    if (!itemDuration(elapsed)) return unknown;
    const { position } = process.exam_pacing_item;
    const distinctEstimate = estimate?.ref === formal?.ref ? undefined : estimate;
    items.push({ item_id, position, effective_duration_ms: elapsed, state: timeValueState(process, elapsed, formal, distinctEstimate) });
    total_duration_ms += elapsed;
  }
  const wholeDuration = attempt.effective_duration_ms;
  if (total_duration_ms === 0 || (wholeDuration !== undefined &&
    (!itemDuration(wholeDuration) || total_duration_ms > wholeDuration))) return unknown;
  items.sort((a, b) => a.position - b.position);
  return { ...base, kind: 'observed', total_duration_ms, items, summary: timeValueSummary(items) };
}

export function isExamTimeValueResult(value: unknown, input: ExamTimeValueInput): value is ExamTimeValueResult {
  return isDeepStrictEqual(value, expectedTimeValue(input));
}
