import {
  commandId, isJson, type CommandId, type CommandReceipt, type FactId, type Json, type LearnerId, type ReadContext, type Revision,
} from '@mangekyo/kernel';
import { parseTextbookRevision, type TextbookEdit } from './textbook-edits.ts';
import { textbookPageFrom, type TextbookReadContext } from './textbook-page.ts';
import { bindGroupUndoJournal, type UndoJournal } from './textbook-undo-basis.ts';

const undoWrite = 'content.undoTextbookWrite';

export type TextbookUndoScope = UndoJournal & {
  readonly read: TextbookReadContext['read'];
  readonly send: (request: {
    learner: LearnerId; id: CommandId; purpose: 'storage'; input: Json;
  } & (
    { type: typeof undoWrite; actor: 'learner' } | { type: 'content.reviseTextbookPage'; actor: 'companion' }
  ), bindRead?: (read: ReadContext) => ReadContext) => Promise<CommandReceipt>;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function writtenTextbookPage(receipt: CommandReceipt, learner: LearnerId, page: FactId) {
  const [ref] = receipt.wrote;
  if (receipt.state !== 'done' || receipt.wrote.length !== 1 || ref?.learner !== learner || ref.id !== page) {
    throw new Error('找不到可撤回的教材变更。');
  }
  return ref;
}

async function undoCommandId(token: CommandId) {
  // Preserve the ID already used by the existing textbook undo entry point.
  const input = new TextEncoder().encode(JSON.stringify(['undo-textbook-write', token]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return commandId(Array.from(digest.subarray(0, 13), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase());
}

export async function undoTextbookReceipt(scope: TextbookUndoScope, {
  learner, page, token, decisionId, storageProposalId,
}: {
  learner: LearnerId; page: FactId; token: CommandId;
  decisionId: (learner: LearnerId, page: FactId, proposalId: CommandId) => Promise<CommandId>;
  storageProposalId: (learner: LearnerId, page: FactId, confirmationId: CommandId) => Promise<CommandId>;
}) {
  const { read, recorded, send } = scope;
  const original = await recorded(token);
  const envelope = object(original?.input);
  const change = object(envelope?.input);
  const receipt = original?.receipt as CommandReceipt | undefined;
  if (original?.state !== 'done' || receipt?.commandId !== token || !change) {
    throw new Error('找不到可撤回的教材变更。');
  }
  const applied = writtenTextbookPage(receipt, learner, page);
  let edits: readonly TextbookEdit[] | undefined;
  let confirmedGroup = false;
  if (original.type === 'content.reviseTextbookPage' && envelope?.actor === 'learner' &&
      envelope.purpose === 'storage' && typeof change.proposalId === 'string') {
    const proposalId = commandId(change.proposalId);
    const selection = object(change.selection);
    if (selection?.page !== page || selection.action !== 'accept' || token !== await decisionId(learner, page, proposalId)) {
      throw new Error('教材采纳记录无效。');
    }
    const proposal = await recorded(proposalId);
    const source = object(proposal?.input);
    if (proposal?.type !== original.type || proposal.state !== 'proposed' || source?.actor !== 'companion') {
      throw new Error('教材采纳记录无效。');
    }
    const revision = parseTextbookRevision(source.input);
    confirmedGroup = typeof selection.confirmationId === 'string' && source.purpose === 'storage' &&
      proposalId === await storageProposalId(learner, page, commandId(selection.confirmationId));
    if (revision.id !== page || (confirmedGroup ? revision.edits.length < 2 :
      source.purpose !== 'teaching' || revision.edits.length !== 1)) throw new Error('教材采纳记录无效。');
    edits = revision.edits;
  } else if (envelope?.actor !== 'companion' || change.id !== page ||
      !((original.type === 'content.createTextbookPage' && applied.rev === 1) ||
        (original.type === 'content.reviseTextbookDraft' && change.expectedRev === applied.rev - 1))) {
    throw new Error('找不到可撤回的教材变更。');
  }

  const id = await undoCommandId(token);
  const priorRev = applied.rev === 1 ? null : (applied.rev - 1) as Revision;
  let bindRead: ((read: ReadContext) => ReadContext) | undefined;
  let input: Json = { id: page, expectedRev: applied.rev, priorRev };
  const previousUndo = await recorded(id);
  if (previousUndo) {
    const stored = object(object(previousUndo.input)?.input);
    if (previousUndo.type !== undoWrite || stored?.id !== page || !isJson(stored)) {
      throw new Error('教材撤回记录无效。');
    }
    input = stored;
  } else if (edits && priorRev !== null) {
    const head = await read.fact(page, { mode: 'following' });
    if (head.ref.rev > applied.rev) {
      const blockIds = edits.map(edit => edit.blockId);
      if (confirmedGroup) {
        bindRead = bindGroupUndoJournal({ learner, id: page, expectedRev: head.ref.rev, appliedRev: applied.rev, blockIds }, scope);
      } else {
        const before = textbookPageFrom(await read.fact(page, { mode: 'pinned', rev: priorRev }));
        const saved = textbookPageFrom(await read.fact(page, { mode: 'pinned', rev: applied.rev }));
        if (JSON.stringify(before.basis) !== JSON.stringify(saved.basis)) throw new Error('教材差异的依据已合入后续版本。');
      }
      input = { id: page, expectedRev: head.ref.rev, priorRev, appliedRev: applied.rev,
        blockIds, ...(confirmedGroup ? { pruneGroupBasis: true } : {}),
        moveBlockIds: edits.filter(edit => edit.kind === 'move' || edit.kind === 'insert' || edit.kind === 'insert_after')
          .map(edit => edit.blockId) };
    }
  }

  const result = await send({ learner, id, type: undoWrite, actor: 'learner', purpose: 'storage', input }, bindRead);
  return { status: priorRev === null ? 'withdrawn' as const : 'reverted' as const,
    ref: writtenTextbookPage(result, learner, page) };
}
