import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { planRule, planRuleType } from '../rules.ts';
import { object, target, text } from '../validation.ts';

export default defineCommand({
  type: 'plan.saveRule',
  destructive: true,
  schema: {
    parse(input: unknown) {
      const raw = object(input);
      const ref = raw.expectedRev === null ? { id: factId(text(raw.id)), expectedRev: null } : target(raw);
      const data = raw.data === null ? null : planRule(raw.data);
      if (!data && ref.expectedRev === null) throw new Error('请提供要撤销的约束版本。');
      return { ...ref, data };
    },
  },
  async write(ctx, { id, expectedRev, data }): Promise<FactWrite[]> {
    if (expectedRev === null && data)
      return [{ kind: 'create', id, factType: planRuleType, data, purpose: ['storage'] }];
    if (expectedRev === null || (await ctx.read.fact(id, { mode: 'following' })).type !== planRuleType)
      throw new Error('规划约束不存在。');
    return [data ? { kind: 'correct', id, expectedRev, data } : { kind: 'retract', id, expectedRev }];
  },
});
