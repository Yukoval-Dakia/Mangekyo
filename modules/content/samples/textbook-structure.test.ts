import { expect, it } from 'vitest';
import { factId, learnerId, type FactRef, type FactSnapshot, type FactWrite, type ReadContext, type Tick } from '@mangekyo/kernel';
import { revision } from '../parse.ts';
import { openTextbookConflict, parseTextbookDraft, saveTextbookDraft, textbookConflictType } from '../textbook-conflict.ts';
import { parseTextbookRevision, previewTextbookRevision, selectTextbookEdits, writeTextbookRevision } from '../textbook-edits.ts';
import { openTextbookBlock, textbookPageType } from '../textbook-page.ts';
import {
  archiveTextbookPage, mergeTextbookPages, parseMergeTextbookPages, parseSplitTextbookPage, splitTextbookPage,
} from '../textbook-structure.ts';
import { undoTextbookWrite } from '../textbook-undo.ts';

const learner = learnerId('01KFS4AAA00000000000000000');
const target = factId('01KFS4AAA00000000000000010');
const source = factId('01KFS4AAA00000000000000011');
const child = factId('01KFS4AAA00000000000000012');
const conflictId = factId('01KFS4AAA00000000000000013');
const v1 = revision(1);
const v2 = revision(2);
const v3 = revision(3);
const body = (text: string) => ({ kind: 'text', text } as const);
const block = (id: string, value: string, parentId: string | null = null) => ({ id, parentId, body: body(value) });
const rewrite = (blockId: string, value: string) => ({ kind: 'rewrite', blockId, body: body(value) } as const);

function textbookFixture() {
  const facts = new Map<string, FactSnapshot[]>();
  const denied = new Set<string>();
  const put = (id: FactRef['id'], value: FactSnapshot['value'], type = textbookPageType, purpose = ['storage']) => {
    const history = facts.get(id) ?? [];
    const fact = {
      type, ref: { learner, id, rev: revision(history.length + 1) }, accessEpoch: '0' as Tick,
      purpose, value,
    };
    facts.set(id, [...history, fact]);
    return fact;
  };
  const commit = (writes: readonly FactWrite[]) => {
    for (const write of writes) {
      if (write.kind === 'create') put(write.id, write.data, write.factType, [...(write.purpose ?? ['storage'])]);
      else if (write.kind === 'correct') put(write.id, write.data);
      else throw new Error(`Unexpected write ${write.kind}`);
    }
  };
  const read: ReadContext = {
    async fact<Value>(id: FactRef['id'], options: Parameters<ReadContext['fact']>[1]) {
      if (denied.has(id)) throw new Error('purpose denied');
      const history = facts.get(id);
      const fact = options.mode === 'following' ? history?.at(-1) : history?.[options.rev - 1];
      if (!fact) throw new Error('missing fact');
      return fact as FactSnapshot<Value>;
    },
    slot: async () => { throw new Error('Only fact reads are expected'); },
    range: async () => { throw new Error('Only fact reads are expected'); },
  };
  return { ctx: { learner, read }, denied, put, commit };
}

it('keeps pinned history while following a block through a merge collision and a subtree split', async () => {
  const { ctx, denied, put, commit } = textbookFixture();
  put(target, { title: '主笔记', blocks: [block('intro', '目标块')] });
  const initial = put(source, { title: '碎页', blocks: [block('intro', '来源块'), block('proof', '子块', 'intro')] });
  const merge = parseMergeTextbookPages({ target: { id: target, expectedRev: v1 }, sources: [{ id: source, expectedRev: v1 }] });
  commit(await mergeTextbookPages(ctx, merge));
  const moved = await openTextbookBlock(ctx.read, initial.ref, 'intro', 'following');
  expect(moved).toMatchObject({ ref: { id: target, rev: v2 }, block: { body: body('来源块') } });
  expect(moved.block.id).not.toBe('intro');
  expect(await openTextbookBlock(ctx.read, initial.ref, 'intro')).toMatchObject({ ref: initial.ref, block: { id: 'intro' } });

  commit(await splitTextbookPage(ctx, parseSplitTextbookPage({
    source: { id: target, expectedRev: v2 }, newId: child, title: '子页', blockIds: [moved.block.id],
  })));
  expect(await openTextbookBlock(ctx.read, initial.ref, 'proof', 'following')).toMatchObject({
    ref: { id: child, rev: v1 }, block: block('proof', '子块', moved.block.id),
  });
  expect((await ctx.read.fact(target, { mode: 'following' })).value).toMatchObject({ blocks: [block('intro', '目标块')] });
  commit(await archiveTextbookPage(ctx, { id: child, expectedRev: v1 }));
  await expect(writeTextbookRevision(ctx, parseTextbookRevision({
    id: child, expectedRev: v2, clientEditSeq: 1, edits: [rewrite('proof', '归档后再改')],
  }), 'correct')).rejects.toThrow('教材已归档');

  denied.add(target);
  await expect(openTextbookBlock(ctx.read, initial.ref, 'proof', 'following')).rejects.toThrow('purpose denied');
});

it('keeps both device submissions and their common base through a later edit', async () => {
  const { ctx, denied, put, commit } = textbookFixture();
  put(target, { title: '教材', blocks: [block('intro', '共同基版')] });
  const first = await saveTextbookDraft(ctx, parseTextbookDraft({
    id: target, draftId: source, base_rev: v1, clientEditSeq: 1, edits: [rewrite('intro', '甲设备')],
  }));
  commit(first);
  const conflict = await saveTextbookDraft(ctx, parseTextbookDraft({
    id: target, draftId: conflictId, base_rev: v1, clientEditSeq: 1, edits: [rewrite('intro', '乙设备')],
  }));
  expect(conflict).toMatchObject([{ kind: 'create', id: conflictId, factType: textbookConflictType, purpose: ['storage'] }]);
  commit(conflict);
  commit(await writeTextbookRevision(ctx, parseTextbookRevision({
    id: target, expectedRev: v2, clientEditSeq: 2, edits: [rewrite('intro', '较晚编辑')],
  }), 'correct'));
  expect(await openTextbookConflict(ctx, conflictId)).toMatchObject({
    base: { id: target, rev: v1 },
    saved: { ref: { rev: v2 }, page: { blocks: [block('intro', '甲设备')] } },
    draft: { clientEditSeq: 1, page: { blocks: [block('intro', '乙设备')] } },
  });
  expect((await ctx.read.fact(target, { mode: 'following' })).value).toMatchObject({ blocks: [block('intro', '较晚编辑')] });
  denied.add(target);
  await expect(openTextbookConflict(ctx, conflictId)).rejects.toThrow('purpose denied');
});

it('adopts two ready diffs and reverts just one of them', async () => {
  const { ctx, put, commit } = textbookFixture();
  put(target, { title: '教材', blocks: [block('a', '原 A'), block('b', '原 B')] });
  const preview = await previewTextbookRevision(ctx, {
    id: target, expectedRev: v1, clientEditSeq: 1,
    edits: [rewrite('a', '新 A'), rewrite('missing', '无效 C'), rewrite('b', '新 B')],
  });
  const chosen = selectTextbookEdits(preview, ['a', 'b']);
  commit(await writeTextbookRevision(ctx, chosen, 'correct'));
  commit(await undoTextbookWrite(ctx, { id: target, expectedRev: v2, priorRev: v1, blockIds: ['a'] }));
  expect((await ctx.read.fact(target, { mode: 'pinned', rev: v3 })).value).toMatchObject({
    blocks: [block('a', '原 A'), block('b', '新 B')],
  });
  await expect(undoTextbookWrite(ctx, { id: target, expectedRev: v3, priorRev: v1, appliedRev: v2, blockIds: ['a'] }))
    .rejects.toThrow('教材块自采纳后已变更');
  const [remaining] = await undoTextbookWrite(ctx, {
    id: target, expectedRev: v3, priorRev: v1, appliedRev: v2, blockIds: ['b'],
  });
  expect(remaining).toMatchObject({ data: { blocks: [block('a', '原 A'), block('b', '原 B')] } });
});
