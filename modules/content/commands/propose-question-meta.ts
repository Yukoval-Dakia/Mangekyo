import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { assetType, checkQuestionTeachingSources, checkTextbookBasis, mergeTextbookBasis, type AssetBasis } from '../asset.ts';
import { sameEffectInput } from '../question-effects.ts';
import { pinQuestionHintSource } from '../question-meta-source.ts';
import { parseQuestionMetaProposal, proposeQuestionMetaCommand } from '../question-writes.ts';
import { readQuestionMetaForUpdate, questionSolutionKey, questionTagKey, validateQuestionMetaReferences } from '../question-state.ts';

export default defineCommand({
  type: proposeQuestionMetaCommand, destructive: true, schema: { parse: parseQuestionMetaProposal },
  async write(ctx, { id, expectedRev, expectedMetaRev, append_metadata, basis }): Promise<readonly FactWrite[]> {
    const target = await ctx.read.fact(id, { mode: 'following' });
    if (target.ref.rev !== expectedRev) throw new Error(`Fact revision conflict: ${id}`);
    if (target.type !== assetType) throw new Error('请选择题目资产。');
    await checkTextbookBasis(ctx.read, basis);
    validateQuestionMetaReferences({ id, expectedRev, append_metadata, basis, sticky: true });
    const { snapshot, draft: previous } = await readQuestionMetaForUpdate(ctx.read, target.ref);
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
    if (tags.length > 16) throw new Error('题目术语标签最多保留 16 条。');
    if (solutions.length > 8) throw new Error('题目解法最多保留 8 条。');
    const proposedLadder = append_metadata.hint_ladder;
    const previousLadder = previous.sticky ? previous.append_metadata?.hint_ladder : undefined;
    const pin = async (ladder: NonNullable<typeof proposedLadder>, witnesses: readonly AssetBasis[]) => ({
      ...ladder, source_ref: await pinQuestionHintSource(ctx, ladder.source_ref, witnesses),
    });
    // Resolve retained bare references against their original witnesses before adding new revisions.
    const retained = previousLadder && (!proposedLadder || expectedMetaRev === undefined)
      ? await pin(previousLadder, previous.basis) : undefined;
    let ladder = retained;
    if (proposedLadder) {
      if (!target.purpose.includes('teaching') && !target.purpose.includes('all')) throw new Error('题目未授权教学用途。');
      await checkQuestionTeachingSources(ctx.read, { basis });
      ladder = await pin(proposedLadder, basis);
      if (retained && !sameEffectInput(retained, ladder)) throw new Error(`Fact revision conflict: ${snapshot.ref.id}`);
    }
    return [{
      kind: 'correct', id: snapshot.ref.id, expectedRev: snapshot.ref.rev,
      data: { id, expectedRev, basis: mergeTextbookBasis(previous.basis, basis), sticky: true,
        append_metadata: { tags, solutions, ...(ladder ? { hint_ladder: ladder } : {}) },
      },
    }];
  },
});
