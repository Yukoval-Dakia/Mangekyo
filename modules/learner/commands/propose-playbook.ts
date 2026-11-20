import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { openReflection, playbook, playbookType, proposalInput } from '../playbook.ts';

export default defineCommand({
  type: 'learner.proposePlaybook',
  destructive: false,
  schema: {parse: proposalInput},
  async write(ctx, {id, data, expectedRev}): Promise<readonly FactWrite[]> {
    const {teaching} = await openReflection(ctx.read, data);
    if (expectedRev === null) {
      if (data.version !== 1) throw new Error('策略初版必须为 1。');
      return [{kind: 'create', id, factType: playbookType, data,
        purpose: ['storage', 'background-research', ...(teaching ? ['teaching'] : [])]}];
    }
    const current = await ctx.read.fact(id, {mode: 'following'});
    if (current.type !== playbookType || current.ref.rev !== expectedRev) throw new Error('策略版本已变化。');
    const previous = playbook(current.value);
    if (data.strategyId !== previous.strategyId || data.version !== previous.version + 1)
      throw new Error('修订须保留策略并递增版本。');
    if (!teaching && (current.purpose.includes('teaching') || current.purpose.includes('all')))
      throw new Error('新增依据不允许教学。');
    return [{kind: 'revise', id, expectedRev, data}];
  },
});
