import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import {
  allowRetentionReview, researchPurpose, researchRevision, retentionReviewPermission, retentionReviewPermissionType,
} from '../research.ts';

export default defineCommand({
  type: allowRetentionReview,
  destructive: true,
  schema: { parse(value: unknown) {
    const input = value as Record<string, unknown>;
    return { id: factId(String(input.id)), revision: researchRevision(input.revision, 0),
      permission: retentionReviewPermission(input.permission) };
  } },
  async write(ctx, { id, revision, permission }): Promise<readonly FactWrite[]> {
    if (revision === 0) {
      if (!permission.allowed) return [];
      return [{ kind: 'create', id, factType: retentionReviewPermissionType, purpose: [researchPurpose], data: permission }];
    }
    const current = await ctx.read.fact(id, { mode: 'following' });
    if (current.type !== retentionReviewPermissionType || current.ref.rev !== revision)
      throw new Error('Fact revision conflict');
    const prior = retentionReviewPermission(current.value);
    if (prior.key !== permission.key) throw new Error('教研授权与后测不匹配。');
    if (prior.allowed === permission.allowed && prior.resultId === permission.resultId) return [];
    return [{ kind: 'correct', id, expectedRev: revision, data: permission }];
  },
});
