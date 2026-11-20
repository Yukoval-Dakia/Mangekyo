import { defineCommand } from '@mangekyo/kernel';
import { readClaimPredecessor, claimId, claimRecord, claimType, ClaimInputError, manageClaimCommand, structuredClaim } from '../claim.ts';

export default defineCommand({
  type: manageClaimCommand,
  destructive: true,
  schema: {parse(input: unknown) {
    const {id, data} = claimRecord(input);
    const value = structuredClaim(data);
    if (value.origin !== 'learner' || !value.supersedes) throw new ClaimInputError('需要本人操作及目标记忆。');
    return {id: claimId(id), data: {...value, supersedes: value.supersedes}};
  }},
  async write(ctx, {id, data}) {
    await readClaimPredecessor(ctx, data.supersedes);
    return [{kind: 'create', id, factType: claimType, data, purpose: ['storage']}];
  },
});
