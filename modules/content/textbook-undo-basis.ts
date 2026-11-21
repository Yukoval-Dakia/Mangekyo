import { commandId, type CommandId, type CommandReceipt, type FactRef, type FactId, type LearnerId,
  type ReadContext, type Revision } from '@mangekyo/kernel';
import { assetBodyReference } from './asset.ts';
import { applyTextbookEdit, parseTextbookRevision, type TextbookRevision } from './textbook-edits.ts';
import { mergeTextbookBasis, parseTextbookPage, type TextbookBasis, type TextbookPage } from './textbook-page.ts';

const unverifiedDependencies = '无法核对后续教材修订的来源依赖。';

export type UndoJournal = {
  readonly recorded: (id: CommandId) => Promise<{
    type: string; state: CommandReceipt['state']; input: unknown; receipt: unknown;
  } | undefined>;
  /** Command IDs of every revision in (after, through], read in this learner transaction. */
  readonly revisionCommands?: (page: FactId, after: Revision, through: Revision) => Promise<readonly CommandId[]>;
};

type GroupUndo = {
  readonly learner: LearnerId;
  readonly id: FactId;
  readonly expectedRev: Revision;
  readonly appliedRev: Revision;
  readonly blockIds: readonly string[];
  /** Teaching groups carry their journaled edits for verification against the applied revision. */
  readonly revision?: TextbookRevision;
};
type BoundJournal = { readonly group: GroupUndo; readonly journal: UndoJournal };
const journals = new WeakMap<ReadContext, BoundJournal>();

/** The binder travels through the trusted command invocation, never through the command payload. */
export function bindGroupUndoJournal(group: GroupUndo, journal: UndoJournal) {
  return (read: ReadContext): ReadContext => {
    const scopedRead = { fact: read.fact.bind(read), slot: read.slot.bind(read), range: read.range.bind(read) };
    journals.set(scopedRead, { group, journal });
    return scopedRead;
  };
}

function textbookBasisKey({ id, rev }: Pick<TextbookBasis, 'id' | 'rev'>) {
  return `${id}:${rev}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function exclusiveGroupBasis(scope: UndoJournal, before: TextbookPage, applied: TextbookPage,
  current: TextbookPage, { learner, id: page, rev: expectedRev }: FactRef, appliedRev: Revision,
) {
  const prior = new Set(before.basis?.map(textbookBasisKey));
  const candidates = (applied.basis ?? []).filter(entry => !prior.has(textbookBasisKey(entry)));
  if (!candidates.length) return [];

  const retained = new Set<string>();
  for (const { body } of current.blocks) {
    const ref = assetBodyReference(body);
    if (ref) retained.add(textbookBasisKey(ref.fact));
  }
  const commands = await scope.revisionCommands?.(page, appliedRev, expectedRev);
  if (commands?.length !== expectedRev - appliedRev) throw new Error(unverifiedDependencies);
  for (const [offset, commandIdAtRev] of commands.entries()) {
    const write = await scope.recorded(commandIdAtRev);
    const input = object(object(write?.input)?.input);
    const receipt = write?.receipt as CommandReceipt | undefined;
    if (write?.state !== 'done' || !input || receipt?.commandId !== commandIdAtRev ||
      !receipt.wrote.some(ref => ref.learner === learner && ref.id === page && ref.rev === appliedRev + offset + 1)) {
      throw new Error(unverifiedDependencies);
    }
    switch (write.type) {
      case 'content.reviseTextbookPage':
      case 'content.reviseTextbookDraft': {
        let revision = input;
        if (typeof input.proposalId === 'string') {
          const source = await scope.recorded(commandId(input.proposalId));
          const proposed = object(object(source?.input)?.input);
          if (!proposed || source?.type !== write.type || source.state !== 'proposed') {
            throw new Error(unverifiedDependencies);
          }
          revision = proposed;
        }
        const { basis, id } = parseTextbookRevision(revision);
        if (id !== page) throw new Error(unverifiedDependencies);
        for (const entry of basis ?? []) retained.add(textbookBasisKey(entry));
        break;
      }
      // These commands preserve the page basis and cannot add a declared source to it.
      case 'content.saveTextbookDraft':
      case 'content.setTextbookTeaching':
      case 'content.setTextbookResearch':
        if (input.id !== page) throw new Error(unverifiedDependencies);
        break;
      default:
        throw new Error(unverifiedDependencies);
    }
  }
  return candidates.map(textbookBasisKey).filter(key => !retained.has(key));
}

function verifyStorageInsertion(previous: TextbookPage, applied: TextbookPage, blockIds: readonly string[]) {
  const before = new Set(previous.blocks.map(block => block.id));
  const { blocks: previousBlocks, basis: previousBasis, ...previousMeta } = previous;
  const { blocks: appliedBlocks, basis: appliedBasis, ...appliedMeta } = applied;
  const inserted = appliedBlocks.filter(block => !before.has(block.id));
  const retained = appliedBlocks.filter(block => before.has(block.id));
  const appliedSources = new Map((appliedBasis ?? []).map(entry => [textbookBasisKey(entry), entry]));
  if (inserted.length < 2 || inserted.length !== blockIds.length || inserted.some(block => !blockIds.includes(block.id)) ||
      JSON.stringify(retained) !== JSON.stringify(previousBlocks) || JSON.stringify(appliedMeta) !== JSON.stringify(previousMeta) ||
      previousBasis?.some(entry => JSON.stringify(appliedSources.get(textbookBasisKey(entry))) !== JSON.stringify(entry))) {
    throw new Error('只有完整撤回教材插入组才能移除其来源。');
  }
}

export async function pruneTextbookGroupBasis(read: ReadContext, snapshot: FactRef,
  previous: TextbookPage, applied: TextbookPage, restored: TextbookPage, appliedRev: Revision, blockIds: readonly string[],
): Promise<TextbookPage> {
  const bound = journals.get(read);
  if (!bound || bound.group.learner !== snapshot.learner || bound.group.id !== snapshot.id ||
      bound.group.expectedRev !== snapshot.rev || bound.group.appliedRev !== appliedRev ||
      JSON.stringify(bound.group.blockIds) !== JSON.stringify(blockIds)) {
    throw new Error(unverifiedDependencies);
  }
  const { revision } = bound.group;
  if (revision?.basis) {
    const expected = revision.edits.reduce(applyTextbookEdit, previous);
    const basis = mergeTextbookBasis(previous.basis, revision.basis);
    if (JSON.stringify(parseTextbookPage({ ...expected, basis })) !== JSON.stringify(applied)) {
      throw new Error(unverifiedDependencies);
    }
  } else {
    verifyStorageInsertion(previous, applied, blockIds);
  }

  const remove = new Set(await exclusiveGroupBasis(bound.journal, previous, applied, restored, snapshot, appliedRev));
  if (!remove.size) return restored;
  const { basis, ...rest } = restored;
  const retainedBasis = basis?.filter(entry => !remove.has(textbookBasisKey(entry)));
  return retainedBasis?.length ? { ...rest, basis: retainedBasis } : rest;
}
