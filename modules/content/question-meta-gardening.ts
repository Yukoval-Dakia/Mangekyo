import type { FactId, JsonObject, QuestionMetaStickyFieldKeyWire, Revision } from '@mangekyo/kernel';
import { assetType, type AssetBasis } from './asset.ts';
import { compareText, purposeAllowed } from './content-guard.ts';
import { jsonDeepEqual } from './parse.ts';
import { parseQuestionMetaProposal } from './question-writes.ts';
import { questionSolutionKey, questionTagKey, validateQuestionMetaReferences, type QuestionMetaDraft } from './question-state.ts';

export type QuestionMetaGap =
  | 'missing_target_skill'
  | 'missing_discriminator'
  | 'missing_hint_ladder'
  | 'missing_time_calibration';
export type QuestionMetaStickyFieldKey = QuestionMetaStickyFieldKeyWire;

export type QuestionGardeningCandidate = {
  readonly id: FactId; readonly rev: Revision; readonly accessEpoch: string; readonly purpose: readonly string[];
  readonly title: string; readonly prompt: string; readonly promptBlockId?: string; readonly metaDraft?: QuestionMetaDraft | null;
  readonly metaRev?: Revision; readonly attemptDurationsMs?: readonly number[]; readonly conceptTitles?: readonly string[];
};
export type DurationCalibration = { readonly sampleCount: number; readonly medianSeconds: number; readonly p75Seconds: number; };

export type QuestionMetaGardeningSelection = {
  readonly candidate: QuestionGardeningCandidate; readonly gaps: readonly QuestionMetaGap[];
  readonly durationCalibration?: DurationCalibration; readonly lockedStickyFields: readonly QuestionMetaStickyFieldKeyWire[];
};

function sortedDurations(durationsMs: readonly number[] | undefined) {
  return (durationsMs ?? []).filter(ms => typeof ms === 'number' && Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
}

export function calibrateAttemptDurations(durationsMs: readonly number[]): DurationCalibration | undefined {
  const sorted = sortedDurations(durationsMs);
  if (!sorted.length) return undefined;
  const at = (ratio: number) => Math.round(sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)]! / 100) / 10;
  return { sampleCount: sorted.length, medianSeconds: at(0.5), p75Seconds: at(0.75) };
}

function lockedStickyFields(draft: QuestionMetaDraft | null | undefined): QuestionMetaStickyFieldKeyWire[] {
  if (draft?.sticky !== true || !draft.append_metadata) return [];
  const fields: QuestionMetaStickyFieldKeyWire[] = [];
  if (draft.append_metadata.hint_ladder) fields.push('hint_ladder');
  for (const tag of draft.append_metadata.tags) fields.push(`tag:${questionTagKey(tag)}`);
  for (const solution of draft.append_metadata.solutions) fields.push(`solution:${questionSolutionKey(solution)}`);
  return fields;
}

function questionGaps(candidate: QuestionGardeningCandidate, minDurationSamples: number) {
  const metadata = candidate.metaDraft?.append_metadata;
  const gaps: QuestionMetaGap[] = [];
  if (!metadata?.tags.some(tag => tag.kind === 'target_skill')) gaps.push('missing_target_skill');
  if (!metadata?.tags.some(tag => tag.kind === 'discriminator')) gaps.push('missing_discriminator');
  if (!metadata?.hint_ladder) gaps.push('missing_hint_ladder');
  if (sortedDurations(candidate.attemptDurationsMs).length >= minDurationSamples &&
      !metadata?.solutions.some(solution => solution.method.includes('作答耗时校准'))) {
    gaps.push('missing_time_calibration');
  }
  return gaps;
}

function gapRank(gaps: readonly QuestionMetaGap[]) {
  const has = (one: QuestionMetaGap, other: QuestionMetaGap) =>
    (gaps.includes(one) || gaps.includes(other) ? 0 : 1);
  return [has('missing_hint_ladder', 'missing_target_skill'), gaps.includes('missing_discriminator') ? 0 : 1,
    gaps.includes('missing_time_calibration') ? 0 : 1];
}

export function selectQuestionsForMetaGardening(
  candidates: readonly QuestionGardeningCandidate[],
  options: { readonly requireTeaching?: boolean; readonly minDurationSamples?: number; readonly limit?: number } = {},
): QuestionMetaGardeningSelection[] {
  const requireTeaching = options.requireTeaching ?? true;
  const minDurationSamples = options.minDurationSamples ?? 3;
  const limit = options.limit ?? 5;
  const selected = [];
  for (const candidate of candidates) {
    if (requireTeaching && !purposeAllowed(candidate.purpose, 'teaching')) continue;
    const gaps = questionGaps(candidate, minDurationSamples);
    if (!gaps.length) continue;
    const calibration = calibrateAttemptDurations(candidate.attemptDurationsMs ?? []);
    selected.push({
      candidate, gaps,
      ...(calibration ? { durationCalibration: calibration } : {}),
      lockedStickyFields: lockedStickyFields(candidate.metaDraft),
    });
  }
  return selected.sort((left, right) => {
    const a = gapRank(left.gaps), b = gapRank(right.gaps);
    for (const index of [0, 1, 2]) if (a[index] !== b[index]) return a[index]! - b[index]!;
    return compareText(left.candidate.id, right.candidate.id) || left.candidate.rev - right.candidate.rev;
  }).slice(0, limit);
}

/** Drops empty `steps`/`hints` arrays so a structurally identical solution compares equal regardless of filler keys. */
function normalizedSolution(value: unknown): unknown {
  const solution = objectEntry(value);
  if (!solution) return value;
  const entries = Object.entries(solution).filter(([key, entry]) =>
    !((key === 'steps' || key === 'hints') && Array.isArray(entry) && entry.length === 0));
  return entries.length === Object.keys(solution).length ? value : Object.fromEntries(entries);
}

function objectEntry(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function keyOfTag(value: unknown) {
  const tag = objectEntry(value);
  return tag && typeof tag.kind === 'string' && typeof tag.term === 'string' && typeof tag.scope === 'string'
    ? questionTagKey({ kind: tag.kind, term: tag.term, scope: tag.scope }) : null;
}

function keyOfSolution(value: unknown) {
  const solution = objectEntry(value);
  return solution && typeof solution.method === 'string' ? questionSolutionKey({ method: solution.method }) : null;
}

function listField(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`园艺建议的${label}须为列表。`);
  return [...value];
}

export type QuestionMetaGardeningSuggestion = {
  readonly tags?: readonly unknown[]; readonly solutions?: readonly unknown[]; readonly hint_ladder?: unknown;
  readonly includeTimeCalibration?: boolean; readonly extraBasis?: readonly AssetBasis[];
};
export type QuestionMetaGardeningProposal = {
  readonly key: string; readonly type: 'content.proposeQuestionMeta'; readonly input: JsonObject;
  readonly added: { readonly tags: number; readonly solutions: number; readonly hintLadder: boolean; readonly timeCalibration: boolean };
  readonly skippedStickyFields: readonly QuestionMetaStickyFieldKeyWire[];
};

/** Build one idempotent append-only proposal. Sticky fields are never overwritten; exact repeats become a no-op. */
export function buildQuestionMetaGardeningProposal(
  candidate: QuestionGardeningCandidate, suggestion: QuestionMetaGardeningSuggestion,
  options: { readonly expectedMetaRev?: Revision; readonly minDurationSamples?: number } = {},
): QuestionMetaGardeningProposal | null {
  const draft = candidate.metaDraft ?? null;
  const sticky = draft?.sticky === true;
  const existing = draft?.append_metadata;
  const expectedMetaRev = options.expectedMetaRev ?? candidate.metaRev;
  const promptSourceRef = JSON.stringify({ v: 1, fact: { id: candidate.id, rev: candidate.rev, type: assetType },
    anchor: { kind: 'block', blockId: candidate.promptBlockId ?? 'prompt' } });
  const skipped = new Set<QuestionMetaStickyFieldKeyWire>();

  // New keys may only fill the quota left after the already-stored unique keys; overwrites do not consume quota.
  const collect = <Entry>(
    kind: 'tag' | 'solution', items: readonly unknown[], existingEntries: readonly Entry[],
    keyOf: (value: unknown) => string | null, keyOfEntry: (entry: Entry) => string, quota: number, normalize: (value: unknown) => unknown,
  ): unknown[] => {
    const existingKeys = new Set(existingEntries.map(keyOfEntry));
    let room = Math.max(0, quota - existingKeys.size);
    const seen = new Set<string>(), additions: unknown[] = [];
    for (const item of items) {
      const key = keyOf(item);
      const matched = key === null ? undefined : existingEntries.find(entry => keyOfEntry(entry) === key);
      if (key !== null && matched !== undefined) {
        if (sticky) {
          skipped.add(kind === 'tag' ? `tag:${key}` : `solution:${key}`);
          continue;
        }
        if (jsonDeepEqual(normalize(matched), normalize(item))) continue;
        if (expectedMetaRev === undefined) continue; // A blind overwrite would race the stored revision; skip instead.
      }
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      if (matched === undefined && key !== null) {
        if (room === 0) continue;
        room -= 1;
      }
      additions.push(item);
    }
    return additions;
  };
  const tags = collect('tag', listField(suggestion.tags, '标签'), existing?.tags ?? [], keyOfTag, questionTagKey, 16, value => value);

  const durations = sortedDurations(candidate.attemptDurationsMs);
  const calibrationSolution = suggestion.includeTimeCalibration !== false && durations.length >= (options.minDurationSamples ?? 3) &&
      !existing?.solutions.some(entry => entry.method.includes('作答耗时校准'))
    ? (() => {
      const calibration = calibrateAttemptDurations(durations)!;
      return { method: '作答耗时校准', source_ref: promptSourceRef,
        explanation: `基于 ${calibration.sampleCount} 次真实作答，中位耗时 ${calibration.medianSeconds} 秒（P75 ${calibration.p75Seconds} 秒）。` };
    })() : undefined;
  const solutionItems = [...listField(suggestion.solutions, '解法'), ...(calibrationSolution ? [calibrationSolution] : [])];
  const solutions = collect('solution', solutionItems, existing?.solutions ?? [], keyOfSolution, questionSolutionKey, 8,
    normalizedSolution);
  const timeCalibration = calibrationSolution !== undefined && solutions.includes(calibrationSolution);

  let hintLadder = false;
  let ladder: unknown;
  if (suggestion.hint_ladder !== undefined && purposeAllowed(candidate.purpose, 'teaching')) {
    if (sticky && existing?.hint_ladder) skipped.add('hint_ladder');
    else if (!existing?.hint_ladder ||
        (expectedMetaRev !== undefined && !jsonDeepEqual(existing.hint_ladder, suggestion.hint_ladder))) {
      ladder = suggestion.hint_ladder;
      hintLadder = true;
    }
  }

  if (!tags.length && !solutions.length && !hintLadder) return null;

  // The question's own pinned witness is authoritative and can never be overridden by caller-supplied basis entries.
  const basis = [...new Map([
    ...(suggestion.extraBasis ?? []),
    { id: candidate.id, rev: candidate.rev, epoch: candidate.accessEpoch, type: assetType },
  ].map(witness => [`${witness.id}:${witness.rev}`, witness])).values()];
  const append_metadata = { tags, solutions, ...(hintLadder ? { hint_ladder: ladder } : {}), };
  const parsed = parseQuestionMetaProposal({
    id: candidate.id, expectedRev: candidate.rev,
    ...(expectedMetaRev === undefined ? {} : { expectedMetaRev }),
    append_metadata, basis,
  });
  validateQuestionMetaReferences({ ...parsed, sticky: true });
  return {
    key: `meta-${candidate.id}-${candidate.rev}`,
    type: 'content.proposeQuestionMeta', input: parsed as unknown as JsonObject,
    added: { tags: tags.length, solutions: solutions.length, hintLadder, timeCalibration }, skippedStickyFields: [...skipped]
  };
}
