import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { goalStatus, goalType, studyGoal, type GoalStatus } from '../goal-values.ts';
import { object, target } from '../validation.ts';

// 目标状态机只允许本人向前推进或暂停/恢复；completed 与 exited 是终态，
// 不能让已结束的目标重新驱动自动备课。
const transitions: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ['active', 'paused', 'completed', 'exited'],
  paused: ['paused', 'active', 'completed', 'exited'],
  completed: ['completed', 'exited'],
  exited: ['exited'],
};

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
    if (!transitions[goal.status].includes(status))
      throw new Error(`目标当前状态不支持变更为 ${status}。`);
    return [{ kind: 'correct', id, expectedRev, data: { ...goal, status } }];
  },
});
