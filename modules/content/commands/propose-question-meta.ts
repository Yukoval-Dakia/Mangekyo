import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { assetType, checkTextbookBasis, mergeTextbookBasis, questionAsset } from '../asset.ts';
import { parseQuestionMetaProposal, proposeQuestionMetaCommand } from '../question-writes.ts';
import { parseQuestionMetaDraft, questionMetaDraftId, questionMetaDraftType, questionSolutionKey, questionTagKey, validateQuestionMetaReferences } from '../question-state.ts';

export default defineCommand({
  type: proposeQuestionMetaCommand, destructive: true, schema: { parse: parseQuestionMetaProposal },
  async write(ctx, { id, expectedRev, append_metadata, basis }): Promise<readonly FactWrite[]> {
    const target = await ctx.read.fact(id, { mode: 'following' });
    if (target.ref.rev !== expectedRev) throw new Error(`Fact revision conflict: ${id}`);
    if (target.type !== assetType) throw new Error('请选择题目资产。');
    await checkTextbookBasis(ctx.read, [...questionAsset(target.value).basis ?? [], ...basis]);
    validateQuestionMetaReferences({ id, expectedRev, append_metadata, basis, sticky: true });
    const draft = await ctx.read.fact(await questionMetaDraftId(target.ref), { mode: 'following' });
    if (draft.type !== questionMetaDraftType) throw new Error('活元信息记录类型不匹配。');
    const previous = parseQuestionMetaDraft(draft.value);
    if (previous.id !== id || previous.expectedRev !== expectedRev) throw new Error('活元信息与题版不匹配。');
    await checkTextbookBasis(ctx.read, previous.basis);
    const tags = new Map([...previous.append_metadata?.tags ?? [], ...append_metadata.tags].map(tag => [
      questionTagKey(tag), tag,
    ]));
    const solutions = new Map([...previous.append_metadata?.solutions ?? [], ...append_metadata.solutions].map(solution => [
      questionSolutionKey(solution), solution,
    ]));
    return [{
      kind: 'correct', id: draft.ref.id, expectedRev: draft.ref.rev,
      data: { id, expectedRev, basis: mergeTextbookBasis(previous.basis, basis), sticky: true,
        append_metadata: { tags: [...tags.values()], solutions: [...solutions.values()] },
      },
    }];
  },
});
