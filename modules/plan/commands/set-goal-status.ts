import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { goalStatus, goalType, studyGoal } from '../goal-values.ts';
import { object, target } from '../validation.ts';

export default defineCommand({
  type: 'plan.setGoalStatus',
  destructive: true,
  schema: {
    parse(input: unknown) {
      const r = object(input);
      return { ...target(r), status: goalStatus(r.status) };
    },
  },
  async write(ctx, { id, expectedRev, status }): Promise<FactWrite[]> {
    const current = await ctx.read.fact(id, { mode: 'following' });
    if (current.type !== goalType) throw new Error('此记录不是学习目标。');
    const goal = studyGoal(current.value);
    if (!goal.text) throw new Error('请先设置目标。');
    return [{ kind: 'correct', id, expectedRev, data: { ...goal, status } }];
  },
});
