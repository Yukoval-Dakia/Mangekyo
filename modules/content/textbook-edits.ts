import type { CommandContext, FactId, FactWrite, Revision } from '@mangekyo/kernel';
import { editSequence, fields, key, list, optionalKey, pageId, record, revision, text } from './parse.ts';
import {
  checkTextbookTree,
  checkTextbookBasis,
  locateTextbookBlock,
  mergeTextbookBasis,
  parseTextbookBasis,
  parseTextbookBlockBody,
  parseTextbookPage,
  requireTextbookBodyBasis,
  textbookPageFrom,
  verifyTextbookBodyReference,
  type TextbookBlock,
  type TextbookBlockBody,
  type TextbookBasis,
  type TextbookPage,
  type TextbookReadContext,
} from './textbook-page.ts';

type BlockPlacement = { readonly parentId: string | null; readonly beforeId: string | null };

export type TextbookEdit = { readonly blockId: string } & (
  | { readonly kind: 'rewrite'; readonly body: TextbookBlockBody }
  | ({ readonly kind: 'insert'; readonly body: TextbookBlockBody } & BlockPlacement)
  | ({ readonly kind: 'move' } & BlockPlacement)
  | { readonly kind: 'insert_after'; readonly afterId: string; readonly body: TextbookBlockBody }
  | { readonly kind: 'replace_anchor'; readonly anchor: string; readonly replacement: string }
  | { readonly kind: 'delete_block' }
);

export type TextbookRevision = {
  readonly id: FactId;
  readonly expectedRev: Revision;
  readonly clientEditSeq: number;
  readonly edits: readonly TextbookEdit[];
  readonly basis?: readonly TextbookBasis[];
};

function parseEdit(input: unknown): TextbookEdit {
  const value = record(input);
  const blockId = key(value.blockId);
  const { kind } = value;
  switch (kind) {
    case 'rewrite':
      fields(value, 'kind', 'blockId', 'body');
      return { kind, blockId, body: parseTextbookBlockBody(value.body) };
    case 'insert':
      fields(value, 'kind', 'blockId', 'parentId', 'beforeId', 'body');
      return {
        kind, blockId, parentId: optionalKey(value.parentId), beforeId: optionalKey(value.beforeId),
        body: parseTextbookBlockBody(value.body),
      };
    case 'move':
      fields(value, 'kind', 'blockId', 'parentId', 'beforeId');
      return { kind, blockId, parentId: optionalKey(value.parentId), beforeId: optionalKey(value.beforeId) };
    case 'insert_after':
      fields(value, 'kind', 'blockId', 'afterId', 'body');
      return { kind, blockId, afterId: key(value.afterId), body: parseTextbookBlockBody(value.body) };
    case 'replace_anchor':
      fields(value, 'kind', 'blockId', 'anchor', 'replacement');
      return { kind, blockId, anchor: text(value.anchor, '教材锚点'), replacement: text(value.replacement, '教材替换正文', true) };
    case 'delete_block':
      fields(value, 'kind', 'blockId');
      return { kind, blockId };
    default:
      throw new Error('教材编辑类型无效。');
  }
}

export function parseTextbookRevision(input: unknown): TextbookRevision {
  const value = record(input);
  fields(value, 'id', 'expectedRev', 'clientEditSeq', 'edits', 'basis');
  const edits = list(value.edits).map(parseEdit);
  if (!edits.length) throw new Error('教材修订必须包含编辑。');
  if (new Set(edits.map(edit => edit.blockId)).size !== edits.length) {
    throw new Error('同一教材修订内每个块只能编辑一次。');
  }
  return {
    id: pageId(value.id),
    expectedRev: revision(value.expectedRev),
    clientEditSeq: editSequence(value.clientEditSeq),
    edits,
    ...(value.basis === undefined ? {} : {basis:parseTextbookBasis(value.basis)}),
  };
}

export function parseSavePage(input: Record<string, unknown>) {
  if (input.ref === undefined) {
    fields(input, 'title', 'content', 'blocks', 'tags', 'links');
    if ((input.content === undefined) === (input.blocks === undefined)) throw new Error('新建时请选正文或结构块。');
    const blocks = input.blocks ?? [{id:'intro', parentId:null, body:{kind:'text', text:input.content}}];
    if (!Array.isArray(blocks) || !blocks.length || blocks.length > 64) throw new Error('请提供 1–64 个教材块。');
    return {kind:'create' as const, page:parseTextbookPage({title:input.title, blocks,
      ...(input.tags === undefined ? {} : {tags:input.tags})})};
  }
  fields(input, 'ref', 'expected_rev', 'patch', 'links');
  const patch = list(input.patch);
  if (!patch.length || patch.length > 24) throw new Error('每次修改请提供 1–24 项局部差异。');
  const body = (content: unknown) => typeof content === 'string' ? {kind:'text', text:content} : content;
  const edits = patch.map(item => {
    const value = record(item);
    const target = key(value.target);
    switch (value.op) {
      case 'replace_block':
        fields(value, 'op', 'target', 'content');
        return parseEdit({kind:'rewrite', blockId:target, body:body(value.content)});
      case 'insert_after':
        fields(value, 'op', 'target', 'block_id', 'content');
        return parseEdit({kind:'insert_after', blockId:value.block_id, afterId:target, body:body(value.content)});
      case 'replace_anchor':
        fields(value, 'op', 'target', 'anchor', 'content');
        return parseEdit({kind:'replace_anchor', blockId:target, anchor:value.anchor, replacement:value.content});
      case 'delete_block':
        fields(value, 'op', 'target');
        return parseEdit({kind:'delete_block', blockId:target});
      case 'move_block':
        fields(value, 'op', 'target', 'parent_id', 'before_id');
        return parseEdit({kind:'move', blockId:target, parentId:value.parent_id, beforeId:value.before_id});
      case 'insert_block':
        fields(value, 'op', 'target', 'parent_id', 'before_id', 'content');
        return parseEdit({kind:'insert', blockId:target, parentId:value.parent_id, beforeId:value.before_id,
          body:body(value.content)});
      default: throw new Error('教材 patch 操作无效。');
    }
  });
  return {kind:'patch' as const, ref:text(input.ref, '页引用'),
    expectedRev:input.expected_rev === undefined ? undefined : revision(input.expected_rev), edits};
}

function applyEdit(blocks: readonly TextbookBlock[], edit: TextbookEdit): readonly TextbookBlock[] {
  const existing = blocks.find(block => block.id === edit.blockId);
  if (edit.kind === 'delete_block') {
    if (!existing) throw new Error(`教材块不存在：${edit.blockId}`);
    if (blocks.some(block => block.parentId === edit.blockId)) throw new Error('教材块仍有子块，请先移出或删除子块。');
    return blocks.filter(block => block !== existing);
  }
  if (edit.kind === 'insert_after') {
    if (existing) throw new Error(`教材块已存在：${edit.blockId}`);
    const index = blocks.findIndex(block => block.id === edit.afterId);
    const anchor = blocks[index];
    if (!anchor) throw new Error(`教材插入锚点不存在：${edit.afterId}`);
    const inserted = { id: edit.blockId, parentId: anchor.parentId, body: edit.body };
    return [...blocks.slice(0, index + 1), inserted, ...blocks.slice(index + 1)];
  }
  if (edit.kind === 'replace_anchor') {
    if (existing?.body.kind !== 'text') throw new Error('教材文本锚点必须位于正文块。');
    const before = existing.body.text;
    const start = before.indexOf(edit.anchor);
    if (start < 0 || before.indexOf(edit.anchor, start + 1) >= 0) throw new Error('教材文本锚点必须恰好匹配一处。');
    const replacement = before.slice(0, start) + edit.replacement + before.slice(start + edit.anchor.length);
    const body = parseTextbookBlockBody({ kind: 'text', text: replacement });
    return blocks.map(block => block === existing ? { ...block, body } : block);
  }
  if (edit.kind === 'rewrite') {
    if (!existing) throw new Error(`教材块不存在：${edit.blockId}`);
    return blocks.map(block => block === existing ? { ...block, body: edit.body } : block);
  }
  if (edit.kind === 'insert' && existing) throw new Error(`教材块已存在：${edit.blockId}`);
  const body = edit.kind === 'insert' ? edit.body : existing?.body;
  if (!body) throw new Error(`教材块不存在：${edit.blockId}`);

  const next = blocks.filter(block => block !== existing);
  const position = edit.beforeId === null ? next.length : next.findIndex(
    block => block.id === edit.beforeId && block.parentId === edit.parentId,
  );
  if (position < 0) throw new Error('插入位置必须是目标父块下的同级块。');
  next.splice(position, 0, { id: edit.blockId, parentId: edit.parentId, body });
  checkTextbookTree(next);
  return next;
}

export function applyTextbookEdit(page: TextbookPage, edit: TextbookEdit): TextbookPage {
  if (page.archived) throw new Error('教材已归档。');
  if ((edit.kind === 'insert' || edit.kind === 'insert_after') &&
    (page.retiredBlockIds?.includes(edit.blockId) || page.movedBlocks?.some(move => move.blockId === edit.blockId))) {
    throw new Error('教材块标识已经使用。');
  }
  const blocks = applyEdit(page.blocks, edit);
  return { ...page, blocks, ...(edit.kind === 'delete_block'
    ? { retiredBlockIds: [...(page.retiredBlockIds ?? []), edit.blockId] } : {}) };
}

export async function applyTextbookRevision(
  ctx: TextbookReadContext,
  page: TextbookPage,
  input: TextbookRevision,
  checkBasis: boolean,
): Promise<TextbookPage> {
  const basis = input.basis && mergeTextbookBasis(page.basis, input.basis);
  if (basis && checkBasis) await checkTextbookBasis(ctx.read, basis);
  let next = page;
  for (const edit of input.edits) {
    next = applyTextbookEdit(next, edit);
    if ('body' in edit) {
      if (basis) requireTextbookBodyBasis(edit.body, basis);
      await verifyTextbookBodyReference(ctx, edit.body);
    }
  }
  return { ...next, ...(basis ? { basis } : {}) };
}

export async function writeTextbookRevision(
  ctx: CommandContext,
  input: TextbookRevision,
  kind: 'correct' | 'revise',
): Promise<readonly FactWrite[]> {
  const current = await ctx.read.fact(input.id, { mode: 'following' });
  if (current.ref.rev !== input.expectedRev) throw new Error(`Fact revision conflict: ${input.id}`);
  const data = await applyTextbookRevision(ctx, textbookPageFrom(current), input, kind === 'revise');
  return [{ kind, id: input.id, expectedRev: input.expectedRev, data }];
}

type EditReview = {
  readonly edit: TextbookEdit;
  readonly before: ReturnType<typeof locateTextbookBlock>;
} & (
  | {
    readonly state: 'ready';
    readonly after: ReturnType<typeof locateTextbookBlock>;
    readonly source: Awaited<ReturnType<typeof verifyTextbookBodyReference>>;
  }
  | { readonly state: 'invalid'; readonly reason: string }
);

export async function previewTextbookRevision(ctx: TextbookReadContext, input: unknown) {
  const revision = parseTextbookRevision(input);
  const snapshot = await ctx.read.fact(revision.id, { mode: 'pinned', rev: revision.expectedRev });
  const page = textbookPageFrom(snapshot);
  const basis = revision.basis && mergeTextbookBasis(page.basis, revision.basis);
  const items: EditReview[] = [];
  for (const edit of revision.edits) {
    const before = locateTextbookBlock(page.blocks, edit.blockId);
    try {
      const next = applyTextbookEdit(page, edit);
      if (basis && 'body' in edit) requireTextbookBodyBasis(edit.body, basis);
      const source = 'body' in edit ? await verifyTextbookBodyReference(ctx, edit.body) : null;
      items.push({ edit, before, state: 'ready', after: locateTextbookBlock(next.blocks, edit.blockId), source });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      items.push({ edit, before, state: 'invalid', reason: error.message });
    }
  }
  return { base: snapshot.ref, accessEpoch: snapshot.accessEpoch, clientEditSeq: revision.clientEditSeq, items,
    ...(revision.basis ? {basis: revision.basis} : {}) };
}

export function selectTextbookEdits(
  preview: Awaited<ReturnType<typeof previewTextbookRevision>>,
  blockIds: readonly string[],
): TextbookRevision {
  const selected = new Set(blockIds);
  const items = preview.items.filter(item => selected.has(item.edit.blockId));
  if (!items.length || items.length !== blockIds.length || items.some(item => item.state !== 'ready')) {
    throw new Error('请选择有效且不重复的教材块差异。');
  }
  return {
    id: preview.base.id,
    expectedRev: preview.base.rev,
    clientEditSeq: preview.clientEditSeq,
    edits: items.map(item => item.edit),
    ...(preview.basis ? {basis:preview.basis} : {}),
  };
}
