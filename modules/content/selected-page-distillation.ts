import { textbookPageType } from './textbook-page.ts';
import { writtenTextbookPage } from './textbook-undo-receipt.ts';
import { textbookDiffDecisionId, textbookDiffCommand, storageProposalId } from './textbook-diff.ts';
import type { UndoJournal } from './textbook-undo-basis.ts';
import { parseTextbookRevision } from './textbook-edits.ts';
import { commandId, factId, type BusWitness, type CommandId, type CommandReceipt, type FactId,
  type FactSnapshot, type LearnerId, type Revision, type Tick } from '@mangekyo/kernel';
import { previewTextbookDistillation, type TextbookDistillationAccess } from './textbook-distillation.ts';

export async function previewSelectedPage(access: Pick<TextbookDistillationAccess, 'read' | 'isUnavailable'>,
  turn: FactSnapshot, answer: string, selected: {id:string;rev:number},
  basis: readonly {id:string;rev:number;epoch:string;type:string;mode:BusWitness['mode']}[]) {
  const witnesses = basis.map(w => ({learner:turn.ref.learner, id:factId(w.id), rev:w.rev as Revision,
    type:w.type, accessEpoch:w.epoch as Tick, mode:w.mode}));
  const page = witnesses.find(w => w.id === selected.id && w.rev === selected.rev && w.type === textbookPageType);
  if (!page) return {status:'missing_witness'} as const;
  // A learner selected one exact page when submitting this answer. There are no graph candidates to rank.
  return previewTextbookDistillation({
    ...access, learner: turn.ref.learner, openDiscussion: async () => ({
      text: answer, complete: true, witnesses,
      refs: [{fact: {learner: page.learner, id: page.id, rev: page.rev}, type: page.type, anchor: {kind:'whole'}}],
    }),
  }, {
    speaker: 'learner', selection: page, candidates: {complete: true, edgeIds: []},
    turn: {ref: {fact: turn.ref, type: turn.type, anchor: {kind:'path', path:['answer']}},
      witness: {...turn.ref, type: turn.type, accessEpoch: turn.accessEpoch, mode:'pinned'}},
  });
}

export type ReadyPage = Extract<Awaited<ReturnType<typeof previewSelectedPage>>, {status:'ready'}> & {answer:string};
export function selectedPagePreview({target, answer, confirmationId}: ReadyPage) {
  return {page:target.page.id, rev:target.page.rev, title:target.title, answer, confirmationId};
}

export function parsePageConfirmation(request: Record<string,unknown>) {
  const {page, confirmationId} = request;
  if (request.action !== 'confirm' || typeof page !== 'string' || typeof confirmationId !== 'string' ||
      ![page,confirmationId].every(value => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value))) return;
  return {page:factId(page), confirmationId:commandId(confirmationId)};
}

/** Replaying a decision exposes only its receipt. Bind it back to this turn's saved answer. */
export async function recordedPageConfirmation(learner: LearnerId, turn: FactId,
  {page, confirmationId}: {page:FactId; confirmationId:CommandId}, recorded: UndoJournal['recorded']) {
  const proposalId = await storageProposalId(learner, page, confirmationId);
  const token = await textbookDiffDecisionId(learner, page, proposalId);
  const decision = await recorded(token);
  if (decision?.state !== 'done' || decision.type !== textbookDiffCommand) return;
  const proposal = await recorded(proposalId);
  const envelope = proposal?.input;
  if (!envelope || typeof envelope !== 'object' || !('input' in envelope)) return;
  const revision = parseTextbookRevision(envelope.input);
  if (!revision.edits.some(edit => 'body' in edit && edit.body.kind === 'reference' &&
      edit.body.target.type === 'activity.studyTurn' && edit.body.target.fact.id === turn &&
      edit.body.target.anchor.kind === 'path' && edit.body.target.anchor.path.join('.') === 'answer')) return;
  return {status:'applied' as const, ref:writtenTextbookPage(decision.receipt as CommandReceipt,learner,page), undo_token:token};
}
