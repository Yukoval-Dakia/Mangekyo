import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { applyClaimCommand, claimInput, claimType, ClaimTargetError, explicitClaimRequest } from '../claim.ts';

export default defineCommand({
  type: applyClaimCommand,
  destructive: true,
  schema: { parse: claimInput },
  async write(ctx, { id, source, quote }): Promise<readonly FactWrite[]> {
    const action = explicitClaimRequest(quote)!;
    const target = action.target ? await ctx.read.fact(action.target, { mode: 'following' }) : undefined;
    if (target && target.type !== claimType) throw new ClaimTargetError('指定的记录不是可管理的 Claim。');
    const supersedes = target ? { id: target.ref.id, rev: target.ref.rev, accessEpoch: target.accessEpoch } : null;
    return [{ kind: 'create', id, factType: claimType, data: { quote, source, supersedes },
      purpose: action.action !== 'forget' && action.teaching ? ['storage', 'teaching'] : ['storage'] },
    ...(target ? [{ kind: 'retract' as const, id: target.ref.id, expectedRev: target.ref.rev }] : [])];
  },
});
