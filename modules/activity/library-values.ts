import { studyRecord } from './values.ts';

export const materialType = 'activity.textMaterial';
export const goalType = 'activity.studyGoal';
export const captureMaterial = 'activity.captureTextMaterial';
export const setStudyGoal = 'activity.setStudyGoal';
export const storagePurpose = 'storage';

function canStore(text: string) {
  return text.isWellFormed() && !text.includes('\u0000');
}

export function textMaterial(input: unknown) {
  const value = studyRecord(input);
  if (!canStore(value.title) || !canStore(value.text)) throw new Error('材料包含无效字符');
  return value;
}

export function studyGoal(input: unknown) {
  if (typeof input !== 'object' || input === null || !('text' in input)) {
    throw new Error('目标格式无效');
  }
  const { text } = input;
  if (text === null) return { text };
  if (typeof text !== 'string' || text.length > 4000 || !canStore(text)) {
    throw new Error('目标内容无效');
  }
  return { text: text.trim() ? text : null };
}
