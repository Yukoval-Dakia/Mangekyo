import type { FactId, FactSnapshot, ReadContext, Revision } from '@mangekyo/kernel';
import { findPoolVariant, poolCandidatePrompt, type VariantPoolCandidate } from '@mangekyo/module-content/facts/near-miss-pool';
import type { FlowGraphSnapshot } from '@mangekyo/module-learner/facts/record-flow';
import { latestItemErrorStage, readPaperItem } from './backtrace-evidence.ts';
import { workbookPaperType } from './workbook-values.ts';

export type NearMissReplay = {
  readonly questionId: string;
  readonly paperId: string;
};

export type NearMissScan =
  | { readonly replay: NearMissReplay; readonly errorStage: string | undefined }
  | {
    readonly hit: VariantPoolCandidate | undefined;
    readonly candidate: { readonly id: FactId; readonly rev: Revision; readonly prompt: string } | undefined;
    readonly sourceQuestionId: string | undefined;
    readonly errorStage: string | undefined;
  };

/** Scan the 0-LLM near-miss verification pool inside the authorized boundary, replay-first for idempotence. */
export async function scanNearMissVerify(input: {
  readonly read: Pick<ReadContext, 'fact'>;
  readonly paperId: FactId;
  readonly itemId: string;
  readonly requestId: string;
  readonly snap: FlowGraphSnapshot;
  readonly snapshots: ReadonlyMap<string, FactSnapshot>;
  readonly replayStableId: (requestId: string) => string;
  readonly exposed: () => Promise<ReadonlySet<string>>;
  readonly isPoolQuestion: (questionId: FactId) => Promise<boolean>;
}): Promise<NearMissScan> {
  // Idempotent replay: a repeated requestId returns the original hit before any new pool scan,
  // because the issued variant is already exposure-locked by the paper it now sits in.
  const replayId = input.replayStableId(input.requestId);
  const replayFact = await input.read.fact(replayId as FactId, { mode: 'following' }).catch(() => undefined);
  if (replayFact?.type === workbookPaperType) {
    const paperData = replayFact.value as { questions?: { sourceQuestionRef?: { id?: unknown } }[] };
    const replaySource = paperData.questions?.[0]?.sourceQuestionRef?.id;
    if (typeof replaySource === 'string') {
      return { replay: { questionId: replaySource, paperId: replayId }, errorStage: latestItemErrorStage(input.snap, input.paperId, input.itemId) };
    }
  }
  const opened = await readPaperItem(input.read, input.paperId, input.itemId);
  const sourceRef = opened.sourceQuestionRef;
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
