export const goalType = 'activity.studyGoal';
export const setStudyGoal = 'activity.setStudyGoal';

export function studyGoal(input: unknown) {
  if (typeof input !== 'object' || input === null || !('text' in input)) {
    throw new Error('目标格式无效');
  }
  const { text } = input;
  if (text === null) return { text };
  if (typeof text !== 'string' || text.length > 4000 || !text.isWellFormed() || text.includes('\u0000')) {
    throw new Error('目标内容无效');
  }
  return { text: text.trim() ? text : null };
}
