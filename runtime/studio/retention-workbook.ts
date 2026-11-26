import { createCommandReadContext, FactReadDeniedError, isFactUnavailable, type ReadTransaction } from '../../kernel/src/index.ts';
import { reopenControlledHelpBasis } from '../../modules/activity/help-exposure-values.ts';
import { retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import type { SourceRefV1 } from '../../modules/activity/source-values.ts';
import { workbookEvidenceReader } from '../../modules/activity/workbook-evidence-reader.ts';
import type { SelectedNotionAccess } from '../../modules/capture/notion-source.ts';
import { captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { assetType } from '../../modules/content/asset.ts';
import { knowledgeEdgeType, workspaceEntryType } from '../../modules/content/knowledge-edge.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { readStudioNotionSource, type CheckNotionRead } from './notion.ts';
import { readPosttestIssuance, type PosttestFactReader } from './retention-posttest.ts';
import { RequestError } from './sessions.ts';
import { resolveSource, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';
import { readSavedWorkbookAssessment } from './workbook-assessment.ts';

export const retentionPurpose = retentionTeachingPurpose;
export { retentionExposure } from '../../modules/activity/evidence-slice.ts';
export const workbookNotionAccess = (tx: ReadTransaction, purpose: string) =>
  purpose === retentionPurpose ? { purpose: 'learning', recipientId: 'studio:learning-reader' } : { purpose, recipientId: tx.learner };
export const isWorkbookNotionSource = (fact: { type: string; value: unknown }) =>
  fact.type === captureSourceType && sourceEnvelope(fact.value).kind === 'notion';
export function selectedWorkbookRead(tx: ReadTransaction, purpose: string, sourceRead: SelectedNotionAccess['sourceRead'], check?: CheckNotionRead) {
  const access = { ...workbookNotionAccess(tx, purpose), maySend: (fact: { ref: { learner: string } }) => fact.ref.learner === tx.learner };
  return { async fact(...args: Parameters<typeof sourceRead.fact>) {
    const fact = await sourceRead.fact(...args);
    if (!isWorkbookNotionSource(fact)) return fact;
    try { const authorized = await readStudioNotionSource(tx, ...args, access); await check?.(authorized); return authorized; }
    catch (error) {
      if ((error instanceof RequestError && error.status === 403) || (error instanceof Error && error.message === 'Notion 选源不可用。'))
        throw new FactReadDeniedError('recipient', '本卷未获准读取此 Notion 页。');
      throw error;
    }
  } };
}
async function trackSource(tx: ReadTransaction, read: PosttestFactReader, reference: string | SourceRefV1, as: string, maySend: WorkspaceSourceRecipient) {
  const opened: Parameters<SourceTrack>[] = [], source = await resolveSource(tx, reference, { recipient: 'workspace', purpose: as, maySend, track: (...w) => opened.push(w) });
  if (!source) throw new FactReadDeniedError('changed', '冻结题项的来源当前不可用。');
  for (const [fact, mode] of opened) await read.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
  return source;
}
export function studioWorkbookEvidence(as: string, maySend: WorkspaceSourceRecipient,
  readIssuance: typeof readPosttestIssuance = (...args) => readPosttestIssuance(...args),
  questionType: string | readonly string[] = [workspaceEntryType, assetType]) {
  return workbookEvidenceReader<ReadTransaction>({
    trackSource: (tx, read, ref) => trackSource(tx, read, ref, as, maySend),
    async reopenCapsule(tx, read, basis) {
      const teaching = selectedWorkbookRead(tx, retentionPurpose, createCommandReadContext(tx, retentionPurpose));
      if (!await reopenControlledHelpBasis(teaching, tx.learner, basis) || !await reopenControlledHelpBasis(read, tx.learner, basis))
        throw new FactReadDeniedError('changed', '受控帮助见证已变化。');
    },
    openEdge: (tx, id) => openKnowledgeEdge(tx, id, { recipient: 'workspace', purpose: as, maySend }),
    readPosttestIssuance: readIssuance, readFormalAssessment: readSavedWorkbookAssessment,
    createRead: tx => createCommandReadContext(tx, as), unavailable: isFactUnavailable,
    unavailableRelease: error => error instanceof RequestError || isFactUnavailable(error),
    reject: (status, message) => new RequestError(status, message), edgeType: knowledgeEdgeType, questionType,
  });
}
export function retentionWorkbookEvidence(readIssuance: typeof readPosttestIssuance = (...args) => readPosttestIssuance(...args)) {
  return studioWorkbookEvidence(retentionPurpose, () => true, readIssuance);
}
export const {
  openRetentionTarget, openControlledSubmission, readWorkbookObservation, readWorkbookEvidence,
  readComparableWorkbookEvidence, readItemDimensions, readItemConceptLinks,
} = retentionWorkbookEvidence();
