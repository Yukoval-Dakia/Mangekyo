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
      return { id: factId(id), data: studyGoal(data) };
    },
  },
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: goalType, data, purpose: ['storage'] },
  ],
});
