import { defineDeriver, type FactId, type GatherContext, type Revision } from '@mangekyo/kernel';
import { assetType, checkTextbookBasis, questionAsset } from '../asset.ts';
import {
  parseQuestionMetaDraft, questionMetaDraftId, questionMetaDraftType, questionMetaType,
  type QuestionMetaDraft,
} from '../question-state.ts';

export default defineDeriver({
  name: 'content/question-meta',
  version: '1',
  slot: questionMetaType,
  async gather(ctx: GatherContext, { id, rev }: { id: FactId; rev: Revision }) {
    const fact = await ctx.read.fact(id, { mode: 'pinned', rev });
    if (fact.type !== assetType) throw new Error('目标不是题目资产。');
    await checkTextbookBasis(ctx.read, questionAsset(fact.value).basis ?? []);
    const metadata = await ctx.read.fact(await questionMetaDraftId(fact.ref), { mode: 'following' });
    if (metadata.type !== questionMetaDraftType) throw new Error('活元信息记录类型不匹配。');
    const draft = parseQuestionMetaDraft(metadata.value);
    if (draft.id !== id || draft.expectedRev !== rev) throw new Error('活元信息与题版不匹配。');
    await checkTextbookBasis(ctx.read, draft.basis);
    return { kind: 'input' as const, data: draft, effects: [] };
  },
  derive(draft: QuestionMetaDraft) {
    return { kind: 'value' as const, value: {
      sticky: draft.sticky, basis: draft.basis,
      tags: (draft.append_metadata?.tags ?? []).map(tag => ({ ...tag, verification: 'learner-reviewed' })),
      solutions: draft.append_metadata?.solutions ?? [],
    } };
  },
});
