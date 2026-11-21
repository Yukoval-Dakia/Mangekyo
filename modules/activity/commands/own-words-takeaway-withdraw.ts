import { defineCommand } from '@mangekyo/kernel';
import {
  isOwnWordsClaim, ownWordsClaimType, withdrawOwnWordsTakeawayCommand, withdrawOwnWordsTakeawayInput,
} from '../takeaway-values.ts';

export default defineCommand({
  type: withdrawOwnWordsTakeawayCommand,
  destructive: true,
  schema: {parse: withdrawOwnWordsTakeawayInput},
  async write(ctx, {id}) {
    const current = await ctx.read.fact(id, {mode: 'following'});
    if (current.type !== ownWordsClaimType || !isOwnWordsClaim(current.value)) {
      throw new Error('撤回凭据与口诀不匹配。');
    }
    return [{kind: 'retract', id, expectedRev: current.ref.rev}];
  },
});
