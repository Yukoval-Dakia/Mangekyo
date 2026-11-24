import { defineCommand } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { recallIssuance, recallIssuanceType, recallSubmission, recallSubmissionType, submitRecallCommand } from '../recall-values.ts';
import { creation } from '../values.ts';

export default defineCommand({
  type: submitRecallCommand, destructive: false, schema: creation(recallSubmission),
  write: async (ctx, { id, data }) => {
    const issuance = await ctx.read.fact(data.issuance.id, { mode: 'pinned', rev: data.issuance.rev });
    if (issuance.type !== recallIssuanceType || !recallIssuance(issuance.value).items.some(item => item.itemId === data.itemId)) {
      throw new Error('回忆题作答与发放题项不匹配。');
    }
    return [{ kind: 'create', id, factType: recallSubmissionType, data, purpose: [storagePurpose] }];
  },
});
