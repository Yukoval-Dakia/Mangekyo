import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { assetType, checkTextbookBasis, mergeTextbookBasis } from '../asset.ts';
import { sameEffectInput } from '../question-effects.ts';
import { parseQuestionMetaProposal, proposeQuestionMetaCommand } from '../question-writes.ts';
import { openQuestionMetaDraft, questionSolutionKey, questionTagKey, validateQuestionMetaReferences } from '../question-state.ts';

export default defineCommand({
  type: proposeQuestionMetaCommand, destructive: true, schema: { parse: parseQuestionMetaProposal },
  async write(ctx, { id, expectedRev, expectedMetaRev, append_metadata, basis }): Promise<readonly FactWrite[]> {
    const target = await ctx.read.fact(id, { mode: 'following' });
    if (target.ref.rev !== expectedRev) throw new Error(`Fact revision conflict: ${id}`);
    if (target.type !== assetType) throw new Error('请选择题目资产。');
    await checkTextbookBasis(ctx.read, basis);
    validateQuestionMetaReferences({ id, expectedRev, append_metadata, basis, sticky: true });
    const { snapshot, draft: previous } = await openQuestionMetaDraft(ctx.read, target.ref);
    if (expectedMetaRev !== undefined && snapshot.ref.rev !== expectedMetaRev) {
      throw new Error(`Fact revision conflict: ${snapshot.ref.id}`);
    }
    function apply<Entry extends Parameters<typeof sameEffectInput>[0]>(
      existing: readonly Entry[], proposed: readonly Entry[], key: (entry: Entry) => string,
    ) {
      const merged = new Map(existing.map(entry => [key(entry), entry]));
      for (const entry of proposed) {
        const before = merged.get(key(entry));
        if (expectedMetaRev === undefined && before !== undefined && !sameEffectInput(before, entry)) {
          throw new Error(`Fact revision conflict: ${snapshot.ref.id}`);
        }
        merged.set(key(entry), entry);
      }
      return [...merged.values()];
    }
    const tags = apply(previous.append_metadata?.tags ?? [], append_metadata.tags, questionTagKey);
    const solutions = apply(previous.append_metadata?.solutions ?? [], append_metadata.solutions, questionSolutionKey);
    return [{
      kind: 'correct', id: snapshot.ref.id, expectedRev: snapshot.ref.rev,
      data: { id, expectedRev, basis: mergeTextbookBasis(previous.basis, basis), sticky: true,
        append_metadata: { tags, solutions },
      },
    }];
  },
});
