import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { beliefInput, matchesBeliefEvidence, saveBeliefCommand } from '../belief.ts';
import { ClaimInputError, matchesClaimEvidence, writeTurnClaims } from '../claim.ts';
import { memoryAssertionType } from '../memory-assertion.ts';
import { extractedUnderstanding, sameUnderstanding } from '../understanding.ts';

export default defineCommand({
  type: saveBeliefCommand,
  destructive: false,
  schema: {parse: beliefInput},
  async write(ctx, {claims, assertions}): Promise<readonly FactWrite[]> {
    const writes = [...await writeTurnClaims(ctx, claims, true)];
    for (const {id, data, quote} of assertions) {
      const {supersedes, forgotten} = data.belief;
      if (quote) {
        const turn = await ctx.read.fact(quote.id, {mode: 'following'});
        if (!matchesClaimEvidence(turn, quote, quote.excerpt, quote.start))
          throw new ClaimInputError('撤回请求的原话已变更。');
      }
      if (data.scope.kind === 'object') await ctx.read.fact(data.scope.object, {mode: 'following'});
      if (supersedes) {
        const prior = await ctx.read.fact(supersedes.id, {mode: 'following'});
        if (prior.type !== memoryAssertionType || prior.ref.rev !== supersedes.rev || prior.accessEpoch !== supersedes.accessEpoch)
          throw new ClaimInputError('假设版本已变更。');
        const previous = extractedUnderstanding(prior.value);
        if (!previous.belief || previous.belief.forgotten || previous.sticky || !sameUnderstanding(previous, data) ||
            (forgotten ? data.evidence_refs.length !== previous.evidence_refs.length
              : data.evidence_refs.length <= previous.evidence_refs.length) ||
            previous.evidence_refs.some((ref, i) => JSON.stringify(ref) !== JSON.stringify(data.evidence_refs[i])))
          throw new ClaimInputError('假设核验只能追加证据。');
      } else if (!data.evidence_refs.some(ref => ref.direction === 'support')) {
        throw new ClaimInputError('新假设须有支持证据。');
      }
      for (const citation of data.evidence_refs) {
        const fact = await ctx.read.fact(citation.id, {mode: 'following'});
        if (!matchesBeliefEvidence(fact, citation)) throw new ClaimInputError('原始作答或版本已变更。');
      }
      writes.push({kind: 'create', id, factType: memoryAssertionType, data, purpose: ['storage', 'teaching']});
    }
    return writes;
  },
});
