import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import { reopenControlledHelpBasis } from '../../modules/activity/help-exposure-values.ts';
import { withSelectedNotionSources, type SelectedNotionAccess } from '../../modules/capture/notion-source.ts';
import { workbookEvidenceReader } from '../../modules/activity/workbook-evidence-reader.ts';
import type { SourceRefV1 } from '../../modules/activity/source-values.ts';
import { knowledgeEdgeType, workspaceEntryType } from '../../modules/content/knowledge-edge.ts';
import { readPosttestIssuance, type PosttestFactReader } from './retention-posttest.ts';
import { RequestError } from './sessions.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { resolveSource, type SourceTrack } from './source-read.ts';

export const retentionPurpose = retentionTeachingPurpose;

export function workbookNotionAccess(tx: ReadTransaction, purpose: string) {
  return purpose === retentionPurpose ? {purpose:'learning',recipientId:'studio:learning-reader'} : {purpose,recipientId:tx.learner};
}

export function selectedWorkbookRead(tx: ReadTransaction, purpose: string, sourceRead: SelectedNotionAccess['sourceRead']) {
  const read = withSelectedNotionSources({sourceRead, selectionRead:createCommandReadContext(tx,'storage'),
    learner:tx.learner, ...workbookNotionAccess(tx,purpose)});
  return {async fact(...args: Parameters<typeof read.fact>) {
    try { return await read.fact(...args); }
    catch (error) {
      if (error instanceof Error && error.message === 'Notion 选源不可用。')
        throw new FactReadDeniedError('recipient','本卷未授权此 Notion 选源。');
      throw error;
    }
  }};
}

async function trackSource(tx: ReadTransaction, read: PosttestFactReader, reference: string | SourceRefV1) {
  const opened: Parameters<SourceTrack>[] = [];
  const source = await resolveSource(tx, reference, {
    recipient: 'workspace', purpose: retentionPurpose, maySend: () => true, track: (...witness) => opened.push(witness),
  });
  if (!source) throw new FactReadDeniedError('changed', '冻结题项的来源当前不可用。');
  for (const [fact, mode] of opened) {
    await read.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
  }
  return source;
}

export const {
  openRetentionTarget, openControlledSubmission, readWorkbookObservation, readWorkbookEvidence,
  readComparableWorkbookEvidence, readItemDimensions,
} = workbookEvidenceReader<ReadTransaction>({
  trackSource,
  async reopenCapsule(tx, read, basis) {
    const teaching = selectedWorkbookRead(tx,retentionPurpose,createCommandReadContext(tx,retentionPurpose));
    if (!await reopenControlledHelpBasis(teaching,tx.learner,basis) || !await reopenControlledHelpBasis(read,tx.learner,basis))
      throw new FactReadDeniedError('changed','受控帮助见证已变化。');
  },
  openEdge: (tx,id) => openKnowledgeEdge(tx,id,{recipient:'workspace',purpose:retentionPurpose,maySend:() => true}),
  readPosttestIssuance,
  createRead: tx => createCommandReadContext(tx,retentionPurpose),
  unavailable: error => error instanceof FactNotFoundError || error instanceof FactReadDeniedError,
  unavailableRelease: error => error instanceof RequestError || error instanceof FactNotFoundError || error instanceof FactReadDeniedError,
  reject: (status,message) => new RequestError(status,message),
  edgeType: knowledgeEdgeType,
  questionType: workspaceEntryType,
});

export { retentionExposure } from '../../modules/activity/evidence-slice.ts';
