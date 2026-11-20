import { oneOf } from './validation.ts';

export const goalStatus = (value: unknown) => oneOf(value, ['active', 'paused', 'completed', 'exited']);
export type GoalStatus = ReturnType<typeof goalStatus>;

export const goalType = 'activity.studyGoal';
export const setStudyGoal = 'activity.setStudyGoal';

export function studyGoal(input: unknown) {
  if (typeof input !== 'object' || input === null || !('text' in input)) {
    throw new Error('目标格式无效');
  }
  const { text } = input;
  const status = 'status' in input ? goalStatus(input.status) : 'active';
  if (text === null) return { text, status: 'exited' as const };
  if (typeof text !== 'string' || text.length > 4000 || !text.isWellFormed() || text.includes('\u0000')) {
    throw new Error('目标内容无效');
  }
  return { text: text.trim() ? text : null, status: text.trim() ? status : ('exited' as const) };
}
