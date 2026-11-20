import {studyObjectBasisDigest} from '@mangekyo/module-activity/facts/current-object';
import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { beliefInput, originalHypothesisObject, matchesBeliefEvidence, saveBeliefCommand } from '../belief.ts';
import { claimRef, ClaimInputError, matchesClaimEvidence, writeTurnClaims } from '../claim.ts';
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
      const basis = data.belief.objectBasis;
      if (data.scope.kind === 'object') {
        const objectId = data.scope.object;
        if (!basis?.some(w => w.id === objectId)) throw new ClaimInputError('对象假设缺少原始范围。');
        const bound = await originalHypothesisObject(ctx.read, data);
        if (!bound || !basis.some(w => w.id === objectId && w.rev === bound.rev) ||
            bound.basisDigest !== await studyObjectBasisDigest(basis)) throw new ClaimInputError('假设范围与原始回合不符。');
        for (const w of basis) {
          const ref = claimRef({id:w.id, rev:w.rev, accessEpoch:w.epoch});
          const fact = await ctx.read.fact(ref.id, w.mode === 'pinned' ? {mode:'pinned',rev:ref.rev} : {mode:'following'});
          if (fact.ref.rev !== w.rev || fact.accessEpoch !== w.epoch || fact.type !== w.type)
            throw new ClaimInputError('对象假设依据已变化。');
        }
      } else if (basis) throw new ClaimInputError('通用假设不能携带对象范围。');
      if (supersedes) {
        const prior = await ctx.read.fact(supersedes.id, {mode: 'following'});
        if (prior.type !== memoryAssertionType || prior.ref.rev !== supersedes.rev || prior.accessEpoch !== supersedes.accessEpoch)
          throw new ClaimInputError('假设版本已变更。');
        const previous = extractedUnderstanding(prior.value);
        if (!previous.belief || previous.belief.forgotten || previous.sticky || !sameUnderstanding(previous, data) ||
            (previous.belief.objectBasis && JSON.stringify(previous.belief.objectBasis) !== JSON.stringify(basis)) ||
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
