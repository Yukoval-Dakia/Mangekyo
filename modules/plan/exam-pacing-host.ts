import type { Json, ReadTransaction } from '@mangekyo/kernel';
import { projectExamPacingReview, type ExamPacingResultLike, type ExamPacingReview } from './exam-pacing-and-reentry.ts';

/**
 * Pure host scan for the exam-pacing review: reads only authorized (storage/all), non-retracted,
 * non-tombstoned workbook attempts through caller-provided SQL, derives `plan/exam-pacing@1` through the
 * injected deriver and projects an honest review. Missing evidence stays `unknown`, never fabricated.
 */

export type ExamPacingDeriver = (deriver: string, input: unknown) => Promise<
  { readonly kind: 'failed'; readonly reason: string } |
  { readonly kind: string; readonly outcome: { readonly kind: string; readonly value?: unknown } }
>;

type AttemptRow = { id: string; data: unknown };

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Scan recent authorized workbook attempts, optionally narrowed to one paper. */
export async function scanExamPacingAttempts(
  tx: ReadTransaction, attemptType: string, paperId?: string, limit = 8,
): Promise<readonly AttemptRow[]> {
  const { rows } = await tx.query<AttemptRow>(
    `SELECT f.id, r.data FROM facts f
       JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
        AND (f.purpose && ARRAY['storage','all']::text[])
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
        AND ($3::text IS NULL OR r.data->>'paperId'=$3)
      ORDER BY f.created_tick DESC LIMIT $4`,
    [tx.learner, attemptType, paperId ?? null, limit]);
  return rows;
}

/** Read the frozen formal score for one attempt from settled, non-shadow assessment derivations. */
export async function readAttemptFormalScore(
  tx: ReadTransaction, slotType: string, attemptId: string,
): Promise<{ readonly earned: number; readonly maximum: number } | undefined> {
  const { rows } = await tx.query<{ value: unknown }>(
    `SELECT d.value FROM slot_state s
       JOIN derivations d ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,COALESCE(s.current_id,s.last_id))
      WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.scope_keys->'submissionRef'->>'id'=$3
        AND NOT d.is_shadow AND d.lifecycle='effective' AND d.invalidated_tick IS NULL AND d.value IS NOT NULL
      ORDER BY (s.scope_keys->'submissionRef'->>'rev')::int DESC LIMIT 1`,
    [tx.learner, slotType, attemptId]);
  for (const { value } of rows) {
    const score = objectOf(objectOf(value).result).score ?? objectOf(value).score;
    const row = objectOf(score);
    if (typeof row.earned === 'number' && typeof row.maximum === 'number' && Number.isFinite(row.earned) && Number.isFinite(row.maximum) && row.maximum > 0)
      return { earned: row.earned, maximum: row.maximum };
  }
  return undefined;
}

const emptyResult: ExamPacingResultLike = {
  method_version: 'plan/exam-pacing@1',
  attempts: [],
  strategy: { kind: 'unknown', reason: 'insufficient-comparable-attempts' },
};

/**
 * Project the exam-pacing review for the learner's recent authorized attempts. Deriver failures or absent
 * python hosts degrade to the honest empty projection instead of invented pacing advice.
 */
export async function projectExamPacingHostReview(
  tx: ReadTransaction,
  deps: {
    readonly attemptType: string;
    readonly assessmentSlotType: string;
    readonly derive?: ExamPacingDeriver;
  },
  paperId?: string,
): Promise<ExamPacingReview> {
  const rows = await scanExamPacingAttempts(tx, deps.attemptType, paperId);
  const attempts = [];
  for (const row of rows) {
    const data = objectOf(row.data);
    const duration = data.effectiveDurationMs;
    const score = await readAttemptFormalScore(tx, deps.assessmentSlotType, row.id);
    attempts.push({
      id: row.id,
      ...(typeof duration === 'number' && Number.isFinite(duration) ? { effective_duration_ms: duration } : {}),
      ...(score === undefined ? {} : { score }),
    });
  }
  let result: ExamPacingResultLike = emptyResult;
  if (attempts.length && deps.derive) {
    try {
      const derived = await deps.derive('plan/exam-pacing@1', { attempts });
      const value = derived.kind !== 'failed' && 'outcome' in derived ? derived.outcome?.value : undefined;
      if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
          (value as Record<string, unknown>).method_version === 'plan/exam-pacing@1')
        result = value as ExamPacingResultLike;
    } catch {
      result = emptyResult;
    }
  }
  return projectExamPacingReview(result);
}

export type { ExamPacingReview };
