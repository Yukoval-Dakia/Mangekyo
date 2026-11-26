import type { FactId, JsonObject, Revision } from '@mangekyo/kernel';
import { assetType, type AssetBasis } from './asset.ts';
import { parseQuestionMetaProposal } from './question-writes.ts';
import { questionSolutionKey, questionTagKey, validateQuestionMetaReferences, type QuestionMetaDraft } from './question-state.ts';

export type QuestionMetaGap =
  | 'missing_target_skill'
  | 'missing_discriminator'
  | 'missing_hint_ladder'
  | 'missing_time_calibration';

export type QuestionGardeningCandidate = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly accessEpoch: string;
  readonly purpose: readonly string[];
  readonly title: string;
  readonly prompt: string;
  readonly metaDraft?: QuestionMetaDraft | null;
  readonly metaRev?: Revision;
  readonly attemptDurationsMs?: readonly number[];
  readonly conceptTitles?: readonly string[];
};

export type DurationCalibration = {
  readonly sampleCount: number;
  readonly medianSeconds: number;
  readonly p75Seconds: number;
};

export type QuestionMetaGardeningSelection = {
  readonly candidate: QuestionGardeningCandidate;
  readonly gaps: readonly QuestionMetaGap[];
  readonly durationCalibration?: DurationCalibration;
  readonly lockedStickyFields: readonly string[];
};

function validDurations(candidate: QuestionGardeningCandidate) {
  return (candidate.attemptDurationsMs ?? []).filter(ms => typeof ms === 'number' && Number.isFinite(ms) && ms > 0)
    .sort((left, right) => left - right);
}

function quantile(sorted: readonly number[], ratio: number) {
  return sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)]!;
}

function seconds(milliseconds: number) {
  return Math.round(milliseconds / 100) / 10;
}

export function calibrateAttemptDurations(durationsMs: readonly number[]): DurationCalibration | undefined {
  const sorted = durationsMs.filter(ms => typeof ms === 'number' && Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  return { sampleCount: sorted.length, medianSeconds: seconds(quantile(sorted, 0.5)), p75Seconds: seconds(quantile(sorted, 0.75)) };
}

function lockedStickyFields(draft: QuestionMetaDraft | null | undefined): string[] {
  if (draft?.sticky !== true || !draft.append_metadata) return [];
  const fields: string[] = [];
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
  if (validDurations(candidate).length >= minDurationSamples &&
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
    if (requireTeaching && !candidate.purpose.some(use => use === 'teaching' || use === 'all')) continue;
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
    for (const index of [0, 1, 2]) {
      if (a[index] !== b[index]) return a[index]! - b[index]!;
    }
    return left.candidate.id.localeCompare(right.candidate.id) || left.candidate.rev - right.candidate.rev;
  }).slice(0, limit);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  }
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length &&
    leftKeys.every(key => Object.hasOwn(right, key) && deepEqual(Reflect.get(left, key), Reflect.get(right, key)));
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
  readonly tags?: readonly unknown[];
  readonly solutions?: readonly unknown[];
  readonly hint_ladder?: unknown;
  readonly includeTimeCalibration?: boolean;
  readonly extraBasis?: readonly AssetBasis[];
};

export type QuestionMetaGardeningProposal = {
  readonly key: string;
  readonly type: 'content.proposeQuestionMeta';
  readonly input: JsonObject;
  readonly added: { readonly tags: number; readonly solutions: number; readonly hintLadder: boolean; readonly timeCalibration: boolean };
  readonly skippedStickyFields: readonly string[];
};

/** Build one idempotent append-only proposal. Sticky fields are never overwritten; exact repeats become a no-op. */
export function buildQuestionMetaGardeningProposal(
  candidate: QuestionGardeningCandidate,
  suggestion: QuestionMetaGardeningSuggestion,
  options: { readonly expectedMetaRev?: Revision; readonly minDurationSamples?: number } = {},
): QuestionMetaGardeningProposal | null {
  const draft = candidate.metaDraft ?? null;
  const sticky = draft?.sticky === true;
  const existing = draft?.append_metadata;
  const promptSourceRef = JSON.stringify({ v: 1, fact: { id: candidate.id, rev: candidate.rev, type: assetType }, anchor: { kind: 'block', blockId: 'prompt' } });
  const skipped = new Set<string>();

  const tags: unknown[] = [];
  const seenTagKeys = new Set<string>();
  for (const tag of listField(suggestion.tags, '标签')) {
    const key = keyOfTag(tag);
    const matched = key === null ? undefined : existing?.tags.find(entry => questionTagKey(entry) === key);
    if (key !== null && matched) {
      if (sticky) { skipped.add(`tag:${key}`); continue; }
      if (deepEqual(matched, tag)) continue;
    }
    if (key !== null) {
      if (seenTagKeys.has(key)) continue;
      seenTagKeys.add(key);
    }
    tags.push(tag);
  }

  const solutions: unknown[] = [];
  const seenSolutionKeys = new Set<string>();
  const pushSolution = (solution: unknown) => {
    const key = keyOfSolution(solution);
    const matched = key === null ? undefined : existing?.solutions.find(entry => questionSolutionKey(entry) === key);
    if (key !== null && matched) {
      if (sticky) { skipped.add(`solution:${key}`); return false; }
      if (deepEqual(matched, solution)) return false;
    }
    if (key !== null) {
      if (seenSolutionKeys.has(key)) return false;
      seenSolutionKeys.add(key);
    }
    solutions.push(solution);
    return true;
  };
  for (const solution of listField(suggestion.solutions, '解法')) pushSolution(solution);

  let timeCalibration = false;
  const durations = validDurations(candidate);
  if (suggestion.includeTimeCalibration !== false && durations.length >= (options.minDurationSamples ?? 3) &&
      !existing?.solutions.some(entry => entry.method.includes('作答耗时校准'))) {
    const calibration = calibrateAttemptDurations(durations)!;
    timeCalibration = pushSolution({
      method: '作答耗时校准', source_ref: promptSourceRef,
      explanation: `基于 ${calibration.sampleCount} 次真实作答，中位耗时 ${calibration.medianSeconds} 秒（P75 ${calibration.p75Seconds} 秒）。`,
    });
  }

  let hintLadder = false;
  let ladder: unknown;
  if (suggestion.hint_ladder !== undefined) {
    if (sticky && existing?.hint_ladder) skipped.add('hint_ladder');
    else if (!sticky && existing?.hint_ladder && deepEqual(existing.hint_ladder, suggestion.hint_ladder)) {
      // An identical ladder is already confirmed; repeating it is a no-op.
    } else {
      ladder = suggestion.hint_ladder;
      hintLadder = true;
    }
  }

  if (!tags.length && !solutions.length && !hintLadder) return null;

  const basis = [...new Map([
    { id: candidate.id, rev: candidate.rev, epoch: candidate.accessEpoch, type: assetType },
    ...(suggestion.extraBasis ?? []),
  ].map(witness => [`${witness.id}:${witness.rev}`, witness])).values()];
  const expectedMetaRev = options.expectedMetaRev ?? candidate.metaRev;
  const append_metadata = {
    tags, solutions,
    ...(hintLadder ? { hint_ladder: ladder } : {}),
  };
  const parsed = parseQuestionMetaProposal({
    id: candidate.id, expectedRev: candidate.rev,
    ...(expectedMetaRev === undefined ? {} : { expectedMetaRev }),
    append_metadata, basis,
  });
  validateQuestionMetaReferences({ ...parsed, sticky: true });
  const input = {
    id: candidate.id, expectedRev: candidate.rev,
    ...(parsed.expectedMetaRev === undefined ? {} : { expectedMetaRev: parsed.expectedMetaRev }),
    append_metadata: parsed.append_metadata, basis: parsed.basis,
  };
  return {
    key: `meta-${candidate.id}-${candidate.rev}`,
    type: 'content.proposeQuestionMeta',
    input: input as unknown as JsonObject,
    added: { tags: tags.length, solutions: solutions.length, hintLadder, timeCalibration },
    skippedStickyFields: [...skipped],
  };
}
