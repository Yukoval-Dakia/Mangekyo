import type { CommandContext, FactId, FactWrite, Revision } from '@mangekyo/kernel';
import {
  parseTextbookPage, textbookPageFrom, verifyTextbookBodyReference, type TextbookBlock, type TextbookPage,
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
  const appliedIds = new Set(applied.blocks.map(block => block.id));
  for (const id of moveBlockIds) {
    const parentId = blocks.get(id)?.parentId;
    const was = applied.blocks.filter(block => block.parentId === parentId && blocks.has(block.id)).map(block => block.id);
    const now = page.blocks.filter(block => block.parentId === parentId && appliedIds.has(block.id)).map(block => block.id);
    if (was.indexOf(id) !== now.indexOf(id) || was.some((blockId, index) => blockId !== now[index])) {
      throw new Error(`教材块位置自采纳后已变更：${id}`);
    }
  }
}

export async function undoTextbookWrite(ctx: CommandContext, {
  id, expectedRev, priorRev, appliedRev = expectedRev, blockIds, moveBlockIds = [],
}: {
  id: FactId; expectedRev: Revision; priorRev: Revision | null;
  appliedRev?: Revision;
  blockIds?: readonly string[]; moveBlockIds?: readonly string[];
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
  if (blockIds && appliedRev !== expectedRev) checkUndoHead(page, applied, blockIds, moveBlockIds);
  const restored = blockIds ? restoreSelectedBlocks(page, previous, blockIds, moveBlockIds) : previous;
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
