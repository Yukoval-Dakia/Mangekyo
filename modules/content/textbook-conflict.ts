import { FactNotFoundError, type CommandContext, type FactSnapshot, type FactWrite } from '@mangekyo/kernel';
import { fields, pageId, record, revision } from './parse.ts';
import { applyTextbookRevision, parseTextbookRevision, type TextbookRevision } from './textbook-edits.ts';
import {
  checkTextbookBasis, textbookPageFrom, verifyTextbookBodyReference, type TextbookReadContext,
} from './textbook-page.ts';

export const textbookConflictType = 'content.textbookConflict';

export function parseTextbookDraft(input: unknown) {
  const value = record(input);
  fields(value, 'id', 'draftId', 'base_rev', 'clientEditSeq', 'edits');
  const draft = parseTextbookRevision({
    id: value.id, expectedRev: value.base_rev, clientEditSeq: value.clientEditSeq, edits: value.edits,
  });
  const draftId = pageId(value.draftId);
  if (draftId === draft.id) throw new Error('教材草稿需要独立标识。');
  return { draftId, draft };
}

export function parseTextbookConflict(input: unknown) {
  const value = record(input);
  fields(value, 'headRev', 'draft');
  const headRev = revision(value.headRev);
  const draft = parseTextbookRevision(value.draft);
  if (headRev <= draft.expectedRev) throw new Error('教材冲突需要一个更新的当前版本。');
  return { headRev, draft };
}

export async function saveTextbookDraft(
  ctx: CommandContext,
  { draftId, draft }: ReturnType<typeof parseTextbookDraft>,
): Promise<readonly FactWrite[]> {
  const current = await ctx.read.fact(draft.id, { mode: 'following' });
  const currentPage = textbookPageFrom(current);
  const existing = await ctx.read.fact(draftId, { mode: 'following' }).catch(error => {
    if (error instanceof FactNotFoundError) return null;
    throw error;
  });
  if (!existing && current.ref.rev === draft.expectedRev) {
    const data = await applyTextbookRevision(ctx, currentPage, draft, false);
    return [{ kind: 'correct', id: draft.id, expectedRev: draft.expectedRev, data }];
  }

  // Conflict copies are private working drafts and can only be opened alongside their source page.
  if (!current.purpose.includes('storage') && !current.purpose.includes('all')) {
    throw new Error('教材冲突稿要求当前页允许私人存储用途。');
  }
  let headRev = current.ref.rev;
  if (existing) {
    if (existing.type !== textbookConflictType) throw new Error('教材草稿标识已被使用。');
    const saved = parseTextbookConflict(existing.value);
    if (saved.draft.id !== draft.id || saved.draft.expectedRev !== draft.expectedRev) {
      throw new Error('教材草稿所属页或基版本不符。');
    }
    if (draft.clientEditSeq <= saved.draft.clientEditSeq) throw new Error('教材草稿编辑序号已过时。');
    // Every edit set is relative to the same base. Keep the original competing version for comparison.
    headRev = saved.headRev;
  }
  const base = await ctx.read.fact(draft.id, { mode: 'pinned', rev: draft.expectedRev });
  await rebuildTextbookDraft(ctx, base, draft);
  const data = parseTextbookConflict({ headRev, draft });
  return existing
    ? [{ kind: 'correct', id: draftId, expectedRev: existing.ref.rev, data }]
    : [{ kind: 'create', id: draftId, factType: textbookConflictType, data, purpose: ['storage'] }];
}

async function readCopy(ctx: TextbookReadContext, fact: FactSnapshot) {
  const page = textbookPageFrom(fact);
  await checkTextbookBasis(ctx.read, page.basis ?? []);
  for (const block of page.blocks) await verifyTextbookBodyReference(ctx, block.body);
  return page;
}

async function rebuildTextbookDraft(ctx: TextbookReadContext, base: FactSnapshot, draft: TextbookRevision) {
  const page = await readCopy(ctx, base);
  return applyTextbookRevision(ctx, page, draft, true);
}

export async function openTextbookConflict(ctx: TextbookReadContext, id: FactSnapshot['ref']['id']) {
  const conflict = await ctx.read.fact(id, { mode: 'following' });
  if (conflict.type !== textbookConflictType) throw new Error('目标事实不是教材冲突稿。');
  const { headRev, draft } = parseTextbookConflict(conflict.value);
  const base = await ctx.read.fact(draft.id, { mode: 'pinned', rev: draft.expectedRev });
  const saved = await ctx.read.fact(draft.id, { mode: 'pinned', rev: headRev });
  const [savedPage, draftPage] = await Promise.all([readCopy(ctx, saved), rebuildTextbookDraft(ctx, base, draft)]);
  return {
    ref: conflict.ref, base: base.ref, saved: { ref: saved.ref, page: savedPage },
    draft: { page: draftPage, clientEditSeq: draft.clientEditSeq, edits: draft.edits },
  };
}
