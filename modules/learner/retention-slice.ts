import type { CanonicalEvidenceSliceV1, EvidenceEventV1, Tick } from '@mangekyo/kernel';
import type { RetentionForecast, RetentionObservation, RetentionTarget } from './retention.ts';

export type ComparableRetentionRow = {
  readonly observation: RetentionObservation;
  readonly helpLevel: EvidenceEventV1['help_level'] | 'unknown';
  readonly novelty: EvidenceEventV1['item_novelty'];
  readonly concepts: readonly string[];
  readonly recordedAt: Tick;
  readonly duration?: number | undefined;
};

export type FreezeScopeLike = {
  readonly target: { readonly itemId: string; readonly condition: string };
  readonly window: { readonly through: string };
  readonly priorAttemptIds: readonly string[];
};

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function matchesRetentionFreezeScope(
  stored: FreezeScopeLike,
  expected: { readonly itemId: string; readonly condition: string; readonly through: string; readonly priorAttemptIds: readonly string[] },
): boolean {
  return stored.target.itemId === expected.itemId && stored.target.condition === expected.condition &&
    stored.window.through === expected.through && stored.priorAttemptIds.length === expected.priorAttemptIds.length &&
    stored.priorAttemptIds.every((id, index) => id === expected.priorAttemptIds[index]);
}

export function checkRetentionFreezeEligibility(input: {
  readonly condition: string;
  readonly sealed: boolean;
  readonly witnessedVariant: boolean;
  readonly supportsVariant: boolean;
}): string | null {
  if (input.condition === 'variant' && (!input.sealed || !input.witnessedVariant || !input.supportsVariant)) {
    return '变式保持预测需要受控题、有依据的变式交卷及支持变式的方法。';
  }
  return null;
}

export function buildRetentionForecastPayload(input: {
  readonly snapshotTick: Tick;
  readonly cutoff: Tick;
  readonly target: RetentionTarget;
  readonly window: RetentionForecast['input']['window'];
  readonly targetDimensions: readonly string[];
  readonly rows: readonly ComparableRetentionRow[];
  readonly method: string;
}): { readonly ok: true; readonly value: {
  readonly target: RetentionTarget;
  readonly window: RetentionForecast['input']['window'];
  readonly observations: RetentionObservation[];
  readonly canonicalEvidence: CanonicalEvidenceSliceV1;
  readonly method: string;
} } | { readonly ok: false; readonly status: 409; readonly message: string } {
  const observations: RetentionObservation[] = [];
  const events: EvidenceEventV1[] = [];
  const omissions: NonNullable<CanonicalEvidenceSliceV1['omissions']>[number][] = [];
  for (const { observation, helpLevel, novelty, concepts, recordedAt, duration } of input.rows) {
    if (observation.submittedAt > input.window.requestedAt || BigInt(recordedAt) > BigInt(input.cutoff))
      return { ok: false, status: 409, message: '交卷在预测发起时尚未登记。' };
    if (novelty === 'same') observations.push(observation);
    if (helpLevel === 'unknown') { omissions.push({ ref: observation.submission, reason: 'unwitnessed-independence' }); continue; }
    const score = observation.result === 'unknown' ? undefined : (observation.scoreNorm ?? (observation.result === 'correct' ? 1 : 0));
    events.push({
      ref: observation.submission.id, rev: observation.submission.rev, occurred_at: observation.submittedAt,
      concept_ids: concepts, item_novelty: novelty, help_level: helpLevel, outcome: observation.result, claim_ids: [],
      ...(observation.result === 'incorrect' && observation.errorStage !== undefined ? { error_stage: observation.errorStage } : {}),
      ...(score === undefined ? {} : { score_norm: score }),
      ...(duration === undefined ? {} : { effective_duration_ms: duration }),
    });
  }
  observations.sort((a, b) => BigInt(a.admittedAt) < BigInt(b.admittedAt) ? -1 : 1);
  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.ref.localeCompare(b.ref));
  const canonicalEvidence: CanonicalEvidenceSliceV1 = {
    clock_watermark: input.snapshotTick, as_of_at: input.window.requestedAt, events, omissions,
    constraints: { budget_min: null, locks: [], deadlines: [{ ref: input.target.paper.id, at: input.window.through }] },
    candidate_pool: [],
  };
  const [kcId] = input.targetDimensions;
  const target = kcId && input.targetDimensions.length === 1 ? { ...input.target, dimensions: { kcId } } : input.target;
  return { ok: true, value: { target, window: input.window, observations, canonicalEvidence, method: input.method } };
}

export function unwrapPythonRetentionOutcome(
  response: { readonly kind: 'failed'; readonly reason: string } | { readonly kind: string; readonly outcome: { readonly kind: string; readonly value?: unknown } },
): unknown {
  if (response.kind === 'failed') throw new Error((response as { readonly reason: string }).reason);
  const outcome = 'outcome' in response ? response.outcome : undefined;
  if (outcome?.kind !== 'value') throw new Error('Python 保持力方法未返回计算结果。');
  return outcome.value;
}

export function parseRetentionComparisonStart(
  input: Record<string, unknown>,
  isRegisteredMethod: (method: string) => boolean,
): { readonly method: string; readonly keys: string[] } | null {
  const { method, reconciliationKeys } = input;
  if (typeof method !== 'string' || !isRegisteredMethod(method) ||
      !Array.isArray(reconciliationKeys) || !reconciliationKeys.length || reconciliationKeys.length > 32 ||
      reconciliationKeys.some(key => typeof key !== 'string' || !ulidPattern.test(key)) ||
      new Set(reconciliationKeys).size !== reconciliationKeys.length) return null;
  return { method, keys: [...reconciliationKeys].sort() as string[] };
}

export function matchesRetentionComparisonPlan(
  stored: { readonly method: string; readonly pairs: readonly { readonly reconciliationKey: string }[] },
  method: string,
  keys: readonly string[],
): boolean {
  return stored.method === method && stored.pairs.length === keys.length &&
    stored.pairs.every((pair, index) => pair.reconciliationKey === keys[index]);
}

export function projectRetentionComparisonState(
  key: string,
  jobState: string,
  valid: boolean,
  shadowRow?: { readonly value: unknown },
) {
  if (!valid) return { key, state: 'stale' as const };
  if (jobState === 'blocked') return { key, state: 'blocked' as const };
  if (jobState !== 'satisfied') return { key, state: 'pending' as const };
  return shadowRow ? { key, state: 'complete' as const, ...shadowRow } : { key, state: 'stale' as const };
}

export function checkPythonAttemptMeta(
  controlled: boolean,
  scopePaperId: string | undefined,
  attemptPaperId: string,
  requestedRev: number | undefined,
  actualRev: number,
): 'not_found' | 'basis_stale' | null {
  if (!controlled && scopePaperId && attemptPaperId !== scopePaperId) return 'not_found';
  if (requestedRev !== undefined && requestedRev !== actualRev) return 'basis_stale';
  return null;
}

export function projectPythonAttemptRow<TResult extends string>(input: {
  readonly id: string;
  readonly paperId: string;
  readonly submittedAt: string;
  readonly controlled: boolean;
  readonly feedback: readonly { readonly questionId: string; readonly result: TResult }[];
  readonly effectiveDurationMs?: number | undefined;
  readonly formalScore?: { readonly earned: number; readonly maximum: number } | null | undefined;
}) {
  return {
    id: input.id, paper_id: input.paperId, submitted_at: input.submittedAt,
    ...(input.controlled ? { activity_kind: 'controlled_posttest' as const } : {}),
    results: input.feedback.map(({ questionId, result }) => ({ question_id: questionId, result })),
    ...(input.effectiveDurationMs === undefined ? {} : { effective_duration_ms: input.effectiveDurationMs }),
    ...(input.formalScore ? { formal_score: input.formalScore } : {}),
  };
}

export function buildPythonAttemptsResult<TRow, TCode extends string>(
  rows: TRow[],
  issues: { index: number; code: TCode }[],
) {
  return rows.length
    ? { ok: true as const, rows, issues }
    : { ok: false as const, code: issues[0]!.code, field: 'refs' as const, message: '本次选择没有可用于计算的作答。', issues };
}
