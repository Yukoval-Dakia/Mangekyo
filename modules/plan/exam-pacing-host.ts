import type { CanonicalEvidenceSliceV1 } from '@mangekyo/kernel';
import { projectExamPacingReview, type ExamPacingResultLike, type ExamPacingReview } from './exam-pacing-and-reentry.ts';

/**
 * Pure 3-phase orchestrator for exam-pacing reviews:
 * 1) Gather authorized `CanonicalEvidenceSliceV1` inside a short read-only snapshot (closed before IPC).
 * 2) Run `plan/exam-pacing@1` outside any open DB transaction.
 * 3) Re-verify authorization after IPC before projecting the final review.
 */

export type ExamPacingDeriver = (deriver: string, input: unknown) => Promise<
  { readonly kind: 'failed'; readonly reason: string } |
  { readonly kind: string; readonly outcome: { readonly kind: string; readonly value?: unknown } }
>;

const emptyResult: ExamPacingResultLike = {
  method_version: 'plan/exam-pacing@1',
  attempts: [],
  strategy: { kind: 'unknown', reason: 'insufficient-comparable-attempts' },
};

export async function runExamPacingHostReview<T extends { readonly slice: CanonicalEvidenceSliceV1 }>(deps: {
  readonly gather: () => Promise<T>;
  readonly verify: (gathered: T) => Promise<boolean>;
  readonly derive?: ExamPacingDeriver;
}): Promise<ExamPacingReview> {
  const gathered = await deps.gather();
  let result: ExamPacingResultLike = emptyResult;
  if (gathered.slice.events.length && deps.derive) {
    try {
      const derived = await deps.derive('plan/exam-pacing@1', gathered.slice);
      const value = derived.kind !== 'failed' && 'outcome' in derived ? derived.outcome?.value : undefined;
      if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
          (value as Record<string, unknown>).method_version === 'plan/exam-pacing@1') {
        if (await deps.verify(gathered)) result = value as ExamPacingResultLike;
      }
    } catch {
      result = emptyResult;
    }
  }
  return projectExamPacingReview(result);
}

export type { ExamPacingReview };
