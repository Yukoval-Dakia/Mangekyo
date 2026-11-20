import type { CommandContext, FactSnapshot, FactWrite } from '@mangekyo/kernel';
import { fields, key, list, pageId, record, revision, text } from './parse.ts';
import {
  checkTextbookBasis, mergeTextbookBasis, parseTextbookPage, textbookPageFrom, textbookPageType,
  verifyTextbookBodyReference, type TextbookBlock, type TextbookPage,
} from './textbook-page.ts';

export function parseTextbookHead(input: unknown) {
  const value = record(input);
  fields(value, 'id', 'expectedRev');
  return { id: pageId(value.id), expectedRev: revision(value.expectedRev) };
}

export async function readTextbookHead(ctx: CommandContext, head: ReturnType<typeof parseTextbookHead>) {
  const snapshot = await ctx.read.fact(head.id, { mode: 'following' });
  if (snapshot.ref.rev !== head.expectedRev) throw new Error(`Fact revision conflict: ${head.id}`);
  const page = textbookPageFrom(snapshot);
  if (page.archived) throw new Error('教材已归档。');
  return { snapshot, page };
}

function revise(snapshot: FactSnapshot, page: TextbookPage): FactWrite {
  return { kind: 'correct', id: snapshot.ref.id, expectedRev: snapshot.ref.rev, data: parseTextbookPage(page) };
}

export async function archiveTextbookPage(ctx: CommandContext, input: ReturnType<typeof parseTextbookHead>) {
  const { snapshot, page } = await readTextbookHead(ctx, input);
  return [revise(snapshot, { ...page, archived: true })];
}

export function parseMergeTextbookPages(input: unknown) {
  const value = record(input);
  fields(value, 'target', 'sources');
  const target = parseTextbookHead(value.target);
  const sources = list(value.sources).map(parseTextbookHead);
  if (!sources.length || new Set([target.id, ...sources.map(source => source.id)]).size !== sources.length + 1) {
    throw new Error('教材合并需要至少一个不同的来源页。');
  }
  return { target, sources };
}

function reserveMovedBlockIds(page: TextbookPage, sourceId: string, used: Set<string>) {
  const ids = new Map<string, string>();
  for (const { id } of page.blocks) {
    if (!used.has(id)) {
      ids.set(id, id);
      used.add(id);
    }
  }
  for (const { id } of page.blocks) {
    if (ids.has(id)) continue;
    const prefix = `${sourceId}-${id.slice(0, 80)}`;
    let assigned = prefix;
    for (let suffix = 1; used.has(assigned); suffix++) assigned = `${prefix}-${suffix}`;
    ids.set(id, assigned);
    used.add(assigned);
  }
  return ids;
}

async function verifyMovedContent(ctx: CommandContext, page: TextbookPage, blocks = page.blocks) {
  await checkTextbookBasis(ctx.read, page.basis ?? []);
  for (const block of blocks) await verifyTextbookBodyReference(ctx, block.body);
}

export async function mergeTextbookPages(ctx: CommandContext, input: ReturnType<typeof parseMergeTextbookPages>) {
  const target = await readTextbookHead(ctx, input.target);
  await checkTextbookBasis(ctx.read, target.page.basis ?? []);
  let basis = target.page.basis;
  const tags = new Set(target.page.tags);
  const blocks = [...target.page.blocks];
  const used = new Set([
    ...blocks.map(block => block.id), ...(target.page.retiredBlockIds ?? []),
    ...(target.page.movedBlocks ?? []).map(move => move.blockId),
  ]);
  const writes: FactWrite[] = [];
  for (const source of input.sources) {
    const { snapshot, page } = await readTextbookHead(ctx, source);
    if (snapshot.purpose.length !== target.snapshot.purpose.length ||
      snapshot.purpose.some(purpose => !target.snapshot.purpose.includes(purpose))) {
      throw new Error('教材合并要求来源页与目标页的用途一致。');
    }
    await verifyMovedContent(ctx, page);
    if (page.basis) basis = mergeTextbookBasis(basis, page.basis);
    for (const tag of page.tags ?? []) tags.add(tag);
    const ids = reserveMovedBlockIds(page, source.id, used);
    for (const block of page.blocks) {
      blocks.push({ ...block, id: ids.get(block.id)!, parentId: block.parentId === null ? null : ids.get(block.parentId)! });
    }
    const movedBlocks = [...(page.movedBlocks ?? []), ...page.blocks.map(block => ({
      blockId: block.id, pageId: input.target.id,
      ...(ids.get(block.id) === block.id ? {} : { targetBlockId: ids.get(block.id)! }),
    }))];
    writes.push(revise(snapshot, { ...page, blocks: [], archived: true, mergedInto: input.target.id, movedBlocks }));
  }
  return [revise(target.snapshot, { ...target.page, blocks, ...(basis ? { basis } : {}),
    mergedFrom: [...(target.page.mergedFrom ?? []), ...input.sources.map(source => source.id)],
    ...(tags.size ? { tags: [...tags] } : {}) }), ...writes];
}

export function parseSplitTextbookPage(input: unknown) {
  const value = record(input);
  fields(value, 'source', 'newId', 'title', 'blockIds');
  const source = parseTextbookHead(value.source);
  const newId = pageId(value.newId);
  const blockIds = list(value.blockIds).map(key);
  if (newId === source.id || !blockIds.length || new Set(blockIds).size !== blockIds.length) {
    throw new Error('教材拆分需要一个新页与不同的块标识。');
  }
  return { source, newId, title: text(value.title, '标题'), blockIds };
}

function selectSubtrees(blocks: readonly TextbookBlock[], selected: Set<string>) {
  const byId = new Map(blocks.map(block => [block.id, block]));
  for (const id of selected) {
    if (!byId.has(id)) throw new Error(`教材块不存在：${id}`);
  }
  return blocks.filter(block => {
    let id: string | null = block.id;
    while (id !== null) {
      if (selected.has(id)) return true;
      id = byId.get(id)!.parentId;
    }
    return false;
  });
}

export async function splitTextbookPage(ctx: CommandContext, input: ReturnType<typeof parseSplitTextbookPage>) {
  const { snapshot, page } = await readTextbookHead(ctx, input.source);
  const blocks = selectSubtrees(page.blocks, new Set(input.blockIds));
  await verifyMovedContent(ctx, page, blocks);
  const moved = new Set(blocks.map(block => block.id));
  const child = parseTextbookPage({
    title: input.title, parentPageId: input.source.id,
    ...(page.basis ? { basis: page.basis } : {}), ...(page.tags ? { tags: page.tags } : {}),
    blocks: blocks.map(block => block.parentId !== null && !moved.has(block.parentId)
      ? { ...block, parentId: null } : block),
  });
  return [
    revise(snapshot, { ...page, blocks: page.blocks.filter(block => !moved.has(block.id)),
      movedBlocks: [...(page.movedBlocks ?? []), ...blocks.map(block => ({ blockId: block.id, pageId: input.newId }))] }),
    { kind: 'create', id: input.newId, factType: textbookPageType, data: child, purpose: snapshot.purpose } satisfies FactWrite,
  ];
}
