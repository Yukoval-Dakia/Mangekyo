import type { CommandContext, FactId, FactWrite, Revision } from '@mangekyo/kernel';
import { assetBodyReference } from './asset.ts';
import {
  checkTextbookBasis, parseTextbookPage, textbookPageFrom, verifyTextbookBodyReference,
  type TextbookBasis, type TextbookBlock, type TextbookPage,
} from './textbook-page.ts';
import { readTextbookHead } from './textbook-structure.ts';

function restoreBlockOrder(blocks: TextbookBlock[], previous: readonly TextbookBlock[], block: TextbookBlock) {
  const previousIndex = previous.indexOf(block);
  const nextSibling = previous.slice(previousIndex + 1).find(sibling => sibling.parentId === block.parentId &&
    blocks.some(current => current.id === sibling.id && current.parentId === sibling.parentId));
  const index = nextSibling ? blocks.findIndex(current => current.id === nextSibling.id) : blocks.length;
  blocks.splice(index, 0, block);
}

function restoreSelectedBlocks(
  page: TextbookPage, previous: TextbookPage, blockIds: readonly string[], moveBlockIds: readonly string[],
) {
  const selected = new Set(blockIds);
  const before = new Map(previous.blocks.map(block => [block.id, block]));
  const after = new Map(page.blocks.map(block => [block.id, block]));
  for (const id of selected) {
    if (!before.has(id) && !after.has(id)) throw new Error(`教材块不存在：${id}`);
  }
  const reorder = new Set(moveBlockIds);
  const blocks = page.blocks.flatMap(block => {
    if (!selected.has(block.id)) return [block];
    const original = before.get(block.id);
    if (!original) return [];
    if (original.parentId !== block.parentId || reorder.has(block.id)) {
      reorder.add(block.id);
      return [];
    }
    return [original];
  });
  for (const block of previous.blocks) {
    if (selected.has(block.id) && (!after.has(block.id) || reorder.has(block.id))) {
      restoreBlockOrder(blocks, previous.blocks, block);
    }
  }
  return { ...page, blocks };
}

function sameBlock(a: TextbookBlock | undefined, b: TextbookBlock | undefined) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sameTextbookBlockPosition(before: TextbookPage, after: TextbookPage, id: string) {
  const parentId = before.blocks.find(block => block.id === id)?.parentId;
  const siblings = (page: TextbookPage) => page.blocks.filter(block => block.parentId === parentId).map(block => block.id);
  const previous = siblings(before);
  const current = siblings(after);
  const oldIndex = previous.indexOf(id);
  const newIndex = current.indexOf(id);
  if (oldIndex === -1 || newIndex === -1) return oldIndex === newIndex;
  const oldPredecessors = new Set(previous.slice(0, oldIndex));
  const newPredecessors = new Set(current.slice(0, newIndex));
  const retained = new Set(current);
  return previous.every(blockId => !retained.has(blockId) ||
    oldPredecessors.has(blockId) === newPredecessors.has(blockId));
}

export function textbookBasisKey({ id, rev }: Pick<TextbookBasis, 'id' | 'rev'>) {
  return `${id}:${rev}`;
}

function withoutBasis(
  page: TextbookPage, previous: TextbookPage, applied: TextbookPage,
  blockIds: readonly string[], removed: readonly TextbookBasis[],
): TextbookPage {
  if (!removed.length) return page;
  const before = new Set(previous.blocks.map(block => block.id));
  const inserted = applied.blocks.filter(block => !before.has(block.id));
  if (inserted.length < 2 || inserted.length !== blockIds.length || inserted.some(block => !blockIds.includes(block.id))) {
    throw new Error('只有完整撤回教材插入组才能移除其来源。');
  }
  const oldKeys = new Set(previous.basis?.map(textbookBasisKey));
  const appliedKeys = new Set(applied.basis?.map(textbookBasisKey));
  const liveRefs = new Set(page.blocks.flatMap(({ body }) => {
    const ref = assetBodyReference(body);
    return ref ? [textbookBasisKey(ref.fact)] : [];
  }));
  const remove = new Set(removed.map(textbookBasisKey));
  for (const id of remove) {
    if (oldKeys.has(id) || !appliedKeys.has(id) || liveRefs.has(id)) throw new Error('教材来源仍有其他依赖。');
  }
  const { basis, ...rest } = page;
  const retained = basis?.filter(entry => !remove.has(textbookBasisKey(entry)));
  return retained?.length ? { ...rest, basis: retained } : rest;
}

function checkUndoHead(
  page: TextbookPage, applied: TextbookPage, blockIds: readonly string[], moveBlockIds: readonly string[],
) {
  const blocks = new Map(page.blocks.map(block => [block.id, block]));
  for (const id of blockIds) {
    if (!sameBlock(blocks.get(id), applied.blocks.find(block => block.id === id)) ||
      page.movedBlocks?.some(move => move.blockId === id)) {
      throw new Error(`教材块自采纳后已变更：${id}`);
    }
  }
  for (const id of moveBlockIds) {
    if (!sameTextbookBlockPosition(applied, page, id)) {
      throw new Error(`教材块位置自采纳后已变更：${id}`);
    }
  }
}

export async function undoTextbookWrite(ctx: CommandContext, {
  id, expectedRev, priorRev, appliedRev = expectedRev, blockIds, moveBlockIds = [], removeBasis = [],
}: {
  id: FactId; expectedRev: Revision; priorRev: Revision | null;
  appliedRev?: Revision;
  blockIds?: readonly string[]; moveBlockIds?: readonly string[]; removeBasis?: readonly TextbookBasis[];
}): Promise<readonly FactWrite[]> {
  const { snapshot, page } = await readTextbookHead(ctx, { id, expectedRev });
  if (priorRev === null && expectedRev === 1 && appliedRev === expectedRev && !blockIds) {
    if (page.parentPageId) {
      const parent = textbookPageFrom(await ctx.read.fact(page.parentPageId, { mode: 'following' }));
      if (parent.movedBlocks?.some(move => move.pageId === id)) throw new Error('教材拆分页不能单独撤回。');
    }
    return [{ kind: 'retract', id, expectedRev }];
  }
  if (priorRev === null || priorRev !== appliedRev - 1 || appliedRev > expectedRev ||
    (appliedRev !== expectedRev && !blockIds)) throw new Error('教材撤回版本无效。');
  const previous = textbookPageFrom(await ctx.read.fact(id, { mode: 'pinned', rev: priorRev }));
  const applied = appliedRev === expectedRev ? page
    : textbookPageFrom(await ctx.read.fact(id, { mode: 'pinned', rev: appliedRev }));
  if (JSON.stringify(applied.movedBlocks) !== JSON.stringify(previous.movedBlocks) ||
    JSON.stringify(applied.mergedFrom) !== JSON.stringify(previous.mergedFrom)) {
    throw new Error('教材跨页移动不能单独撤回。');
  }
  if (blockIds) {
    for (let rev = appliedRev + 1; rev <= expectedRev; rev++) {
      const later = rev === expectedRev ? page
        : textbookPageFrom(await ctx.read.fact(id, { mode: 'pinned', rev: rev as Revision }));
      checkUndoHead(later, applied, blockIds, moveBlockIds);
    }
  }
  const restored = blockIds
    ? withoutBasis(restoreSelectedBlocks(page, previous, blockIds, moveBlockIds), previous, applied, blockIds, removeBasis)
    : previous;
  await checkTextbookBasis(ctx.read, restored.basis ?? []);
  const active = new Set(restored.blocks.map(block => block.id));
  const retiredBlockIds = [...new Set([
    ...(restored.retiredBlockIds ?? []),
    ...(page.retiredBlockIds ?? []),
    ...page.blocks.map(block => block.id),
  ])].filter(id => !active.has(id));
  for (const block of restored.blocks) {
    if (!blockIds || blockIds.includes(block.id)) await verifyTextbookBodyReference(ctx, block.body);
  }
  return [{ kind: 'correct', id, expectedRev: snapshot.ref.rev, data: parseTextbookPage({ ...restored, retiredBlockIds }) }];
}
