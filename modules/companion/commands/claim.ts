import { defineCommand, type FactSnapshot, type FactWrite } from '@mangekyo/kernel';
import {
  applyClaimCommand, claimInput, claimType, ClaimInputError, editableTurnClaim, matchesClaimEvidence,
  readClaimPredecessor, requirePreservedObjectScope,
} from '../claim.ts';

function allowsTeaching(fact: FactSnapshot) {
  return fact.purpose.includes('teaching') || fact.purpose.includes('all');
}

export default defineCommand({
  type: applyClaimCommand,
  destructive: false,
  schema: {parse: claimInput},
  async write(ctx, entries): Promise<readonly FactWrite[]> {
    const writes: FactWrite[] = [];
    for (const {id, data} of entries) {
      const evidence = data.evidence_refs[0]!;
      const source = await ctx.read.fact(evidence.id, {mode: 'following'});
      if (!allowsTeaching(source) || !matchesClaimEvidence(source, evidence, evidence.excerpt, evidence.start))
        throw new ClaimInputError('本轮教学用途或原话已变化。');
      if (data.supersedes) {
        const target = await readClaimPredecessor(ctx, data.supersedes);
        if (!allowsTeaching(target)) throw new ClaimInputError('目标记忆不允许教学用途。');
        const previous = editableTurnClaim(target.value);
        if (previous.authority && data.authority !== previous.authority)
          throw new ClaimInputError('更正须保留学习者主权规则。');
        requirePreservedObjectScope(previous.scope, data.scope);
      }
      if (data.scope.kind === 'object') for (const ref of data.scope.basis) {
        const object = await ctx.read.fact(ref.id, {mode: 'following'});
        if (!allowsTeaching(object) || object.ref.rev !== ref.rev || object.accessEpoch !== ref.accessEpoch)
          throw new ClaimInputError('学习对象范围已变化。');
      }
      writes.push({kind: 'create', id, factType: claimType, data, purpose: ['storage', 'teaching']});
    }
    return writes;
  },
});
