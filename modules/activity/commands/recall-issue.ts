import { defineCommand } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { issueRecallCommand, recallIssuance, recallIssuanceType } from '../recall-values.ts';
import { creation } from '../values.ts';

// The Studio host resolves and seals the successful derivation in the write transaction.
export default defineCommand({
  type: issueRecallCommand, destructive: false, schema: creation(recallIssuance),
  write: async (ctx, { id, data }) => {
    const turn = await ctx.read.fact(data.turn.id, { mode: 'pinned', rev: data.turn.rev });
    if (turn.type !== 'activity.studyTurn') throw new Error('回忆题必须出自教学回合。');
    return [{ kind: 'create', id, factType: recallIssuanceType, data, purpose: [storagePurpose] }];
  },
});
