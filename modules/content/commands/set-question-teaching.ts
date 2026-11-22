import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { assetType, checkQuestionTeachingSources, questionAsset, refreshPurposeOnlyTeachingSources } from '../asset.ts';
import { fields, pageId, record, revision } from '../parse.ts';
import { parseQuestionMetaDraft, questionMetaDraftId, questionMetaDraftType, readQuestionState } from '../question-state.ts';

export default defineCommand({
  type: 'content.setQuestionTeaching',
  destructive: true,
  schema: { parse(input: unknown) {
    const value = record(input);
    fields(value, 'id', 'expectedRev', 'allowed');
    if (typeof value.allowed !== 'boolean') throw new Error('请明确题目教学用途。');
    return { id: pageId(value.id), expectedRev: revision(value.expectedRev), allowed: value.allowed };
  } },
  async write(ctx, { id, expectedRev, allowed }): Promise<readonly FactWrite[]> {
    const question = await ctx.read.fact(id, { mode: 'following' });
    if (question.type !== assetType || question.ref.rev !== expectedRev) throw new Error('题目基版已变化。');
    const asset = questionAsset(question.value);
    const teaching = question.purpose.includes('all') || question.purpose.includes('teaching');
    if (teaching === allowed) return [];
    const purpose = allowed ? ['storage', 'teaching'] : ['storage'];
    const { snapshot: state } = await readQuestionState(ctx.read, id);
    const metadata = await ctx.read.fact(await questionMetaDraftId(question.ref), { mode: 'following' });
    if (metadata.type !== questionMetaDraftType) throw new Error('活元信息类型不匹配。');
    const draft = parseQuestionMetaDraft(metadata.value);
    if (draft.id !== id || draft.expectedRev !== expectedRev) throw new Error('活元信息与题版不匹配。');
    let refreshedDraftBasis = draft.basis;
    if (allowed) {
      const assetBasis = await refreshPurposeOnlyTeachingSources(ctx.read, asset.basis ?? []);
      await checkQuestionTeachingSources(ctx.read, { ...asset, basis: assetBasis });
      refreshedDraftBasis = await refreshPurposeOnlyTeachingSources(ctx.read, draft.basis);
      await checkQuestionTeachingSources(ctx.read, { basis: refreshedDraftBasis });
    }
    const nextRev = revision(expectedRev + 1);
    return [
      { kind: 'set_purpose', id, expectedRev, purpose },
      { kind: 'set_purpose', id: state.ref.id, expectedRev: state.ref.rev, purpose },
      { kind: 'set_purpose', id: metadata.ref.id, expectedRev: metadata.ref.rev, purpose: ['storage'] },
      { kind: 'create', id: await questionMetaDraftId({ ...question.ref, rev: nextRev }),
        factType: questionMetaDraftType, purpose, data: { ...draft, expectedRev: nextRev, basis: refreshedDraftBasis },
      },
    ];
  },
});
