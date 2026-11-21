import { defineCommand, factId } from '@mangekyo/kernel';
import { goalType, setStudyGoal, studyGoal } from '../goal-values.ts';

export default defineCommand({
  type: setStudyGoal,
  destructive: true,
  schema: {
    parse(input: unknown) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('记录格式无效');
      const { id, data } = input as Record<string, unknown>;
      if (typeof id !== 'string' || !id.trim() || id.length > 4000) throw new Error('记录字段无效');
      const goal = studyGoal(data);
      // 新目标只能以 active 开始（清空为 exited）；生命周期迁移走 plan.setGoalStatus。
      if (goal.text !== null && goal.status !== 'active') throw new Error('新目标只能保存为进行中。');
      return { id: factId(id), data: goal };
    },
  },
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: goalType, data, purpose: ['storage'] },
  ],
});
