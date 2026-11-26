import type { FactId, FactSnapshot, ReadContext, Revision } from '@mangekyo/kernel';
import { findPoolVariant, nearMissPoolEmpty, nearMissPoolHit, poolCandidatePrompt, type VariantPoolCandidate } from '@mangekyo/module-content/facts/near-miss-pool';
import type { FlowGraphSnapshot } from '@mangekyo/module-learner/facts/record-flow';
import { latestItemErrorStage, readPaperItem, verifyFrozenPaperAccess, type PaperReadChecks } from './backtrace-evidence.ts';
import type { workbookPaper } from './workbook-values.ts';

export type NearMissOutcome = ReturnType<typeof nearMissPoolHit> | ReturnType<typeof nearMissPoolEmpty>;
export type NearMissScan = {
  readonly hit: VariantPoolCandidate | undefined;
  readonly candidate: { readonly id: FactId; readonly rev: Revision; readonly prompt: string } | undefined;
  readonly sourceQuestionId: string | undefined;
  readonly errorStage: string | undefined;
};

/** Scan the 0-LLM near-miss verification pool inside the caller's locked transaction. */
export async function scanNearMissVerify(input: {
  readonly opened: ReturnType<typeof workbookPaper>['questions'][number];
  readonly paperId: FactId;
  readonly itemId: string;
  readonly snap: FlowGraphSnapshot;
  readonly snapshots: ReadonlyMap<string, FactSnapshot>;
  readonly exposed: () => Promise<ReadonlySet<string>>;
  readonly isPoolQuestion: (questionId: FactId) => Promise<boolean>;
}): Promise<NearMissScan> {
  const sourceRef = input.opened.sourceQuestionRef;
  const hit = sourceRef ? await findPoolVariant({
    sourceQuestionId: sourceRef.id as FactId, snapshots: input.snapshots, exposed: await input.exposed(),
    isPoolQuestion: input.isPoolQuestion,
  }) : undefined;
  const candidate = hit ? poolCandidatePrompt(input.snapshots, hit.questionId) : undefined;
  return {
    hit, candidate,
    sourceQuestionId: sourceRef?.id, errorStage: latestItemErrorStage(input.snap, input.paperId, input.itemId),
  };
}

/** Validate a stored near-miss receipt before replaying it; fail closed if the issued bank paper was later revoked. */
export async function reopenNearMissReceipt(
  read: Pick<ReadContext, 'fact'>, stored: unknown, checks?: PaperReadChecks,
): Promise<NearMissOutcome> {
  const outcome = stored as NearMissOutcome;
  if (outcome.source === 'variant_pool') await verifyFrozenPaperAccess(read, outcome.paperId as FactId, checks);
  return outcome;
}

export { nearMissPoolEmpty, nearMissPoolHit, readPaperItem };
