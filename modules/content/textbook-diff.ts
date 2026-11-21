import {
  commandId, type CommandId, type CommandReceipt, type FactId, type Json, type LearnerId,
} from '@mangekyo/kernel';
import { contentStableId } from './knowledge-entity.ts';
import { applyTextbookRevision, parseTextbookRevision, previewTextbookRevision, selectTextbookEdits } from './textbook-edits.ts';
import {
  checkTextbookBasis, locateTextbookBlock, textbookPageFrom, verifyTextbookBodyReference, type TextbookReadContext,
} from './textbook-page.ts';
import { sameTextbookBlockPosition } from './textbook-undo.ts';
import { undoTextbookReceipt, writtenTextbookPage, type TextbookUndoScope } from './textbook-undo-receipt.ts';

export const textbookDiffCommand = 'content.reviseTextbookPage';

type ProposalDecision = {
  readonly learner: LearnerId;
  readonly id: CommandId;
  readonly type: typeof textbookDiffCommand;
  readonly purpose: 'storage';
  readonly proposalId: CommandId;
  readonly selection: Json;
};
type Reader = TextbookReadContext['read'];
type DiffPurpose = 'storage' | 'teaching';
type DecisionScope = TextbookUndoScope & {
  readonly decideProposal: (
    request: ProposalDecision, select: (proposedInput: Json) => Promise<Json | null>,
  ) => Promise<CommandReceipt>;
};

export type TextbookDiffPorts<Tx> = {
  /** Reopen each purpose using the host's current source and recipient checks, scoped to this transaction. */
  readonly read: (tx: Tx, purpose: DiffPurpose) => Reader | Promise<Reader>;
  readonly recorded: (tx: Tx, id: CommandId) => ReturnType<TextbookUndoScope['recorded']>;
  readonly decideProposal: (
    request: ProposalDecision, select: (tx: Tx, proposedInput: Json) => Promise<Json | null>,
  ) => Promise<CommandReceipt>;
  /** Bind the journal, storage reader and command handler to the same locked learner transaction. */
  readonly withLearnerWrite: <T>(learner: LearnerId, run: (scope: DecisionScope, tx: Tx) => Promise<T>) => Promise<T>;
};

export async function textbookDiffDecisionId(learner: LearnerId, page: FactId, proposalId: CommandId) {
  return commandId(await contentStableId('textbook-diff-decision', learner, page, proposalId));
}

async function storageProposalId(learner: LearnerId, page: FactId, confirmationId: CommandId) {
  return commandId(await contentStableId('textbook-diff-storage', learner, page, confirmationId));
}

/** Submit together in the host's learner transaction. Retries reuse the batch ID and inputs. */
export async function textbookDiffProposals(learner: LearnerId, batchId: CommandId, input: unknown) {
  commandId(batchId);
  const revision = parseTextbookRevision(input);
  return Promise.all(revision.edits.map(async edit => ({
    learner,
    id: commandId(await contentStableId('textbook-diff-item', learner, batchId, edit.blockId)),
    type: textbookDiffCommand,
    actor: 'companion' as const,
    purpose: 'teaching' as const,
    input: { ...revision, edits: [edit] },
  })));
}

function proposalPurpose(input: unknown) {
  if (input === null || typeof input !== 'object' || !('actor' in input) || input.actor !== 'companion' ||
      !('purpose' in input)) throw new Error('教材提议记录无效。');
  return input.purpose;
}

export function readTextbookDiffItem(input: unknown) {
  const revision = parseTextbookRevision(input);
  const [edit] = revision.edits;
  if (!edit || revision.edits.length !== 1) throw new Error('教材提议必须恰好包含一项差异。');
  return { revision, edit };
}

async function openDiffItem(ctx: TextbookReadContext, { revision, edit }: ReturnType<typeof readTextbookDiffItem>) {
  const base = textbookPageFrom(await ctx.read.fact(revision.id, { mode: 'pinned', rev: revision.expectedRev }));
  const head = await ctx.read.fact(revision.id, { mode: 'following' });
  const current = textbookPageFrom(head);
  await checkTextbookBasis(ctx.read, [...base.basis ?? [], ...revision.basis ?? []]);
  if (head.ref.rev !== revision.expectedRev) await checkTextbookBasis(ctx.read, current.basis ?? []);
  const before = locateTextbookBlock(base.blocks, edit.blockId);
  if (before) await verifyTextbookBodyReference(ctx, before.block.body);
  if ('body' in edit) await verifyTextbookBodyReference(ctx, edit.body);
  return { base, head, preview: await previewTextbookRevision(ctx, revision) };
}

export async function previewTextbookDiffItem(ctx: TextbookReadContext, input: unknown) {
  return (await openDiffItem(ctx, readTextbookDiffItem(input))).preview;
}

function checkTargets(
  base: ReturnType<typeof textbookPageFrom>, current: ReturnType<typeof textbookPageFrom>,
  edit: ReturnType<typeof readTextbookDiffItem>['edit'],
) {
  const before = base.blocks.find(block => block.id === edit.blockId);
  const after = current.blocks.find(block => block.id === edit.blockId);
  if (JSON.stringify(before) !== JSON.stringify(after) ||
      (edit.kind === 'move' && !sameTextbookBlockPosition(base, current, edit.blockId))) {
    throw new Error(`教材差异的目标已变更：${edit.blockId}`);
  }
  const anchors = edit.kind === 'insert_after' ? [edit.afterId] :
    edit.kind === 'insert' || edit.kind === 'move' ? [edit.parentId, edit.beforeId] : [];
  for (const id of anchors) {
    if (id === null) continue;
    const original = base.blocks.find(block => block.id === id);
    const latest = current.blocks.find(block => block.id === id);
    if (!original || !latest || original.parentId !== latest.parentId) {
      throw new Error(`教材差异的位置已变更：${id}`);
    }
  }
}

export function textbookDiffReview<Tx>(ports: TextbookDiffPorts<Tx>) {
  return {
    async decide({ learner, page, proposalId, action }: {
      learner: LearnerId; page: FactId; proposalId: CommandId; action: 'accept' | 'reject';
    }) {
      if (action !== 'accept' && action !== 'reject') throw new Error('教材差异决定无效。');
      const id = await textbookDiffDecisionId(learner, page, proposalId);
      const receipt = await ports.decideProposal({
        learner, id, type: textbookDiffCommand, purpose: 'storage', proposalId, selection: { page, action },
      }, async (tx, input) => {
        const { revision, edit } = readTextbookDiffItem(input);
        if (revision.id !== page) throw new Error('教材提议不属于此页。');
        const storage = await ports.read(tx, 'storage');
        const head = await storage.fact(page, { mode: 'following' });
        const current = textbookPageFrom(head);
        if (action === 'reject') return null;

        const journal = await ports.recorded(tx, proposalId);
        if (journal?.type !== textbookDiffCommand || journal.state !== 'proposed') throw new Error('教材提议记录无效。');
        if (proposalPurpose(journal.input) !== 'teaching') throw new Error('教材提议用途无效。');
        const teaching = await ports.read(tx, 'teaching');
        const { base, head: authorized, preview } = await openDiffItem({ learner, read: teaching }, { revision, edit });
        if (authorized.ref.rev !== head.ref.rev || authorized.accessEpoch !== head.accessEpoch) {
          throw new Error('教材当前版本已变更。');
        }
        await checkTextbookBasis(storage, [...current.basis ?? [], ...revision.basis ?? []]);
        if (head.ref.rev !== revision.expectedRev) checkTargets(base, current, edit);
        return { ...selectTextbookEdits(preview, [edit.blockId]), expectedRev: head.ref.rev };
      });
      if (receipt.state === 'rejected') return { status: 'rejected' as const };
      return { status: 'applied' as const, ref: writtenTextbookPage(receipt, learner, page), undo_token: id };
    },

    /** The host invokes this only after the learner confirms a storage preview. */
    async confirmStorage({ learner, page, confirmationId }: {
      learner: LearnerId; page: FactId; confirmationId: CommandId;
    }, repreview: (tx: Tx) => Promise<{ confirmationId: CommandId; revision: unknown }>) {
      commandId(confirmationId);
      const proposalId = await storageProposalId(learner, page, confirmationId);
      const id = await textbookDiffDecisionId(learner, page, proposalId);
      const decision = {
        learner, id, type: textbookDiffCommand, purpose: 'storage', proposalId,
        selection: { page, action: 'accept', confirmationId },
      } as const;
      return ports.withLearnerWrite(learner, async (scope, tx) => {
        if (!await scope.recorded(id)) {
          const fresh = await repreview(tx);
          if (fresh.confirmationId !== confirmationId) throw new Error('教材确认内容已变更，请重新预览。');
          const revision = parseTextbookRevision(fresh.revision);
          if (revision.id !== page || !revision.basis?.length || revision.edits.length < 2 ||
              revision.edits.some(edit => edit.kind !== 'insert' && edit.kind !== 'insert_after')) {
            throw new Error('教材整组存储需要同页的插入项及来源依据。');
          }
          const head = await scope.read.fact(page, { mode: 'following' });
          if (head.ref.rev !== revision.expectedRev) throw new Error(`Fact revision conflict: ${page}`);
          const current = textbookPageFrom(head);
          await checkTextbookBasis(scope.read, current.basis ?? []);
          await applyTextbookRevision({ learner, read: scope.read }, current, revision, true);
          const proposed = await scope.send({
            learner, id: proposalId, type: textbookDiffCommand, actor: 'companion', purpose: 'storage', input: revision,
          });
          if (proposed.state !== 'proposed') throw new Error('教材整组提议记录无效。');
        }
        const receipt = await scope.decideProposal(decision, async input => parseTextbookRevision(input));
        return { status: 'applied' as const, ref: writtenTextbookPage(receipt, learner, page), undo_token: id };
      });
    },

    undo({ learner, page, token }: { learner: LearnerId; page: FactId; token: CommandId }) {
      commandId(token);
      return ports.withLearnerWrite(learner, scope =>
        undoTextbookReceipt(scope, { learner, page, token, decisionId: textbookDiffDecisionId, storageProposalId }));
    },
  };
}
