import { defineCommand } from '@mangekyo/kernel';
import { undoHypothesisCommand } from '../belief.ts';
import { claimId, claimRecord, ClaimInputError } from '../claim.ts';
import { memoryAssertionType } from '../memory-assertion.ts';
import { extractedUnderstanding } from '../understanding.ts';

export default defineCommand({
  type: undoHypothesisCommand,
  destructive: true,
  schema: {parse(value: unknown) {
    const {id, token} = claimRecord(value);
    return {id: claimId(id), token: claimId(token)};
  }},
  async write(ctx, {id, token}) {
    const fact = await ctx.read.fact(id, {mode: 'following'});
    if (fact.type !== memoryAssertionType) throw new ClaimInputError('假设类型已变更。');
    const current = extractedUnderstanding(fact.value);
    if (!current.belief || current.sticky || current.undo_token !== token)
      throw new ClaimInputError('假设已由本人变更。');
    return [{kind: 'retract', id, expectedRev: fact.ref.rev}];
  },
});
