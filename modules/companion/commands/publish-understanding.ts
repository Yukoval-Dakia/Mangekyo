import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { activityEvidence, hasLinkedAttempt, reopenLinkedCitation } from '../activity-evidence.ts';
import { claimId, claimRecord, claimRef, ClaimInputError } from '../claim.ts';
import { memoryAssertionType } from '../memory-assertion.ts';
import { researchPurpose } from '../research.ts';
import { questionObservation, extractedUnderstanding, opensCitation, publishUnderstandingCommand, sameUnderstanding } from '../understanding.ts';

export default defineCommand({
  type: publishUnderstandingCommand,
  destructive: false,
  schema: { parse(value: unknown) {
    const {entries} = claimRecord(value);
    if (!Array.isArray(entries) || !entries.length || entries.length > 4) throw new ClaimInputError('抽取批次无效。');
    return entries.map(entry => {
      const {id, data, prior} = claimRecord(entry);
      return {id: claimId(id), data: extractedUnderstanding(data), prior: prior === null ? null : claimRef(prior)};
    });
  } },
  async write(ctx, entries): Promise<readonly FactWrite[]> {
    const writes: FactWrite[] = [];
    for (const {id, data, prior} of entries) {
      if (data.sticky || (data.ttl && data.ttl <= new Date().toISOString()))
        throw new ClaimInputError('抽取结果已失效或由本人管理。');
      let teaching = true;
      let quoteOnly = false;
      for (const citation of data.evidence_refs) {
        const fact = await ctx.read.fact(citation.id, {mode: 'following'});
        const linked = hasLinkedAttempt(fact) && citation.basis_digest !== undefined;
        if (citation.question_evidence && !linked) throw new ClaimInputError('题项见证与活动不匹配。');
        if (linked) {
          const proof = await reopenLinkedCitation(ctx.read, citation);
          if (!proof) throw new ClaimInputError('来源题依据已变更。');
          teaching &&= proof.teaching;
        }
        const source = activityEvidence(fact, linked ? citation.anchor : undefined);
        if (!source || !opensCitation({...source, ref: {...fact.ref, accessEpoch: fact.accessEpoch}}, citation))
          throw new ClaimInputError('活动证据已变更。');
        if (source.quoteOnly) {
          if (!citation.span || data.kind !== 'observation' || prior || data.evidence_refs.length !== 1)
            throw new ClaimInputError('本轮原话只支持带精确范围的观察。');
          quoteOnly = true;
        }
        if (citation.question_evidence &&
            questionObservation({...source, ref: {...fact.ref, accessEpoch: fact.accessEpoch}}, citation, data) !== data.text)
          throw new ClaimInputError('题项观察须与实际作答和客观评阅一致。');
        teaching &&= fact.purpose.includes('teaching') || fact.purpose.includes('all');
      }
      if (prior) {
        const current = await ctx.read.fact(id, {mode: 'following'});
        const original = extractedUnderstanding(current.value);
        if (current.type !== memoryAssertionType || prior.id !== id || prior.rev !== current.ref.rev ||
            prior.accessEpoch !== current.accessEpoch || original.sticky ||
            current.purpose.includes('teaching') !== teaching ||
            !sameUnderstanding(original, data) || original.undo_token !== data.undo_token ||
            data.evidence_refs.length !== original.evidence_refs.length + 1 ||
            original.evidence_refs.some((ref, index) => JSON.stringify(ref) !== JSON.stringify(data.evidence_refs[index])))
          throw new ClaimInputError('被核验的理解或用途已变更。');
        writes.push({kind: 'revise', id, expectedRev: prior.rev, data});
      } else {
        writes.push({kind: 'create', id, factType: memoryAssertionType, data,
          purpose: quoteOnly ? ['storage'] : ['storage', researchPurpose, ...(teaching ? ['teaching'] : [])]});
      }
    }
    return writes;
  },
});
