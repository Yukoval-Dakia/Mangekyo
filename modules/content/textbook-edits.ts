import type { CommandContext, FactId, FactWrite, Revision } from '@mangekyo/kernel';
import { editSequence, fields, key, list, optionalKey, pageId, record, revision } from './parse.ts';
import {
  checkTextbookTree,
  locateTextbookBlock,
  parseTextbookBlockBody,
  textbookPageFrom,
  verifyTextbookBodyReference,
  type TextbookBlock,
  type TextbookBlockBody,
} from './textbook-page.ts';

type BlockPlacement = { readonly parentId: string | null; readonly beforeId: string | null };

export type TextbookEdit = { readonly blockId: string } & (
  | { readonly kind: 'rewrite'; readonly body: TextbookBlockBody }
  | ({ readonly kind: 'insert'; readonly body: TextbookBlockBody } & BlockPlacement)
  | ({ readonly kind: 'move' } & BlockPlacement)
);

export type TextbookRevision = {
  readonly id: FactId;
  readonly expectedRev: Revision;
  readonly clientEditSeq: number;
  readonly edits: readonly TextbookEdit[];
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
    default:
      throw new Error('教材编辑类型无效。');
  }
}

export function parseTextbookRevision(input: unknown): TextbookRevision {
  const value = record(input);
  fields(value, 'id', 'expectedRev', 'clientEditSeq', 'edits');
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
  };
}

function applyEdit(blocks: readonly TextbookBlock[], edit: TextbookEdit): readonly TextbookBlock[] {
  const existing = blocks.find(block => block.id === edit.blockId);
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

export async function writeTextbookRevision(
  ctx: CommandContext,
  input: TextbookRevision,
  kind: 'correct' | 'revise',
): Promise<readonly FactWrite[]> {
  const current = await ctx.read.fact(input.id, { mode: 'following' });
  if (current.ref.rev !== input.expectedRev) throw new Error(`Fact revision conflict: ${input.id}`);
  const page = textbookPageFrom(current);
  let blocks = page.blocks;
  for (const edit of input.edits) {
    blocks = applyEdit(blocks, edit);
    if (edit.kind !== 'move') await verifyTextbookBodyReference(ctx, edit.body);
  }
  return [{ kind, id: input.id, expectedRev: input.expectedRev, data: { ...page, blocks } }];
}

type EditReview = {
  readonly edit: TextbookEdit;
  readonly before: ReturnType<typeof locateTextbookBlock>;
} & (
  | { readonly state: 'ready'; readonly source: Awaited<ReturnType<typeof verifyTextbookBodyReference>> }
  | { readonly state: 'invalid'; readonly reason: string }
);

export async function previewTextbookRevision(ctx: CommandContext, input: unknown) {
  const revision = parseTextbookRevision(input);
  const snapshot = await ctx.read.fact(revision.id, { mode: 'pinned', rev: revision.expectedRev });
  const page = textbookPageFrom(snapshot);
  let blocks = page.blocks;
  const items: EditReview[] = [];
  for (const edit of revision.edits) {
    const before = locateTextbookBlock(page.blocks, edit.blockId);
    try {
      const next = applyEdit(blocks, edit);
      const source = edit.kind === 'move' ? null : await verifyTextbookBodyReference(ctx, edit.body);
      items.push({ edit, before, state: 'ready', source });
      blocks = next;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      items.push({ edit, before, state: 'invalid', reason: error.message });
    }
  }
  return { base: snapshot.ref, accessEpoch: snapshot.accessEpoch, clientEditSeq: revision.clientEditSeq, items };
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
  };
}
