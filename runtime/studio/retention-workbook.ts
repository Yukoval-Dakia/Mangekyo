import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import { workbookEvidenceReader } from '../../modules/activity/workbook-evidence-reader.ts';
import type { SourceRefV1 } from '../../modules/activity/source-values.ts';
import type { RetentionObservation } from '../../modules/learner/retention.ts';
import { knowledgeEdgeType, workspaceEntryType } from '../../modules/content/knowledge-edge.ts';
import { readPosttestIssuance, type PosttestFactReader } from './retention-posttest.ts';
import { RequestError } from './sessions.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { resolveSource, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';

export const retentionPurpose = retentionTeachingPurpose;

async function trackSource(tx: ReadTransaction, read: PosttestFactReader, reference: string | SourceRefV1, as: string, maySend: WorkspaceSourceRecipient) {
  const opened: Parameters<SourceTrack>[] = [];
  const source = await resolveSource(tx, reference, {
    recipient: 'workspace', purpose: as, maySend, track: (...witness) => opened.push(witness),
  });
  if (!source) throw new FactReadDeniedError('changed', '冻结题项的来源当前不可用。');
  for (const [fact, mode] of opened) {
    await read.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
  }
  return source;
}

export const studioWorkbookEvidence = (as: string, maySend: WorkspaceSourceRecipient) => workbookEvidenceReader<ReadTransaction>({
  trackSource: (tx,read,ref) => trackSource(tx,read,ref,as,maySend),
  openEdge: (tx,id) => openKnowledgeEdge(tx,id,{recipient:'workspace',purpose:as,maySend}),
  readPosttestIssuance,
  createRead: tx => createCommandReadContext(tx,as),
  unavailable: error => error instanceof FactNotFoundError || error instanceof FactReadDeniedError,
  unavailableRelease: error => error instanceof RequestError || error instanceof FactNotFoundError || error instanceof FactReadDeniedError,
  reject: (status,message) => new RequestError(status,message),
  edgeType: knowledgeEdgeType,
  questionType: workspaceEntryType,
});

const evidence = studioWorkbookEvidence(retentionPurpose, () => true);

export const { openRetentionTarget, openControlledSubmission, readWorkbookEvidence,
  readComparableWorkbookEvidence, readItemDimensions } = evidence;
export const readWorkbookObservation: (...args: Parameters<typeof evidence.readWorkbookObservation>) =>
  Promise<RetentionObservation> = evidence.readWorkbookObservation;

export { retentionExposure } from '../../modules/activity/evidence-slice.ts';
