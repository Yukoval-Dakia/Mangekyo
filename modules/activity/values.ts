import { factId } from '@mangekyo/kernel';

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('记录格式无效');
  return input as Record<string, unknown>;
}
function field(input: Record<string, unknown>, key: string, limit = 4000): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('记录字段无效');
  return value;
}
export function studyTurn(input: unknown) {
  const value = object(input);
  const answer = value.answer === null ? null : field(value, 'answer');
  return {
    sessionId: factId(field(value, 'sessionId')),
    caseId: field(value, 'caseId', 120),
    parentId: value.parentId === null ? null : factId(field(value, 'parentId')),
    answer,
    ...(value.attachment === undefined ? {} : { attachment: studyAttachment(value.attachment) }),
    model: field(value, 'model', 200),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: field(value, 'reasoningEffort', 40) }),
    baseUrl: field(value, 'baseUrl', 2000),
  };
}
export function studyAttachment(input: unknown) {
  const value = object(input);
  if (value.mode !== 'ask' && value.mode !== 'prepare') throw new Error('材料使用方式无效');
  return {
    id: factId(field(value, 'id')),
    title: field(value, 'title', 240),
    text: field(value, 'text', 3000),
    mode: value.mode as 'ask' | 'prepare',
  };
}
export function studyRecord(input: unknown) {
  const value = object(input);
  return { title: field(value, 'title', 240), text: field(value, 'text') };
}
export function creation<T>(value: (data: unknown) => T) {
  return {
    parse(input: unknown) {
      const record = object(input);
      return { id: factId(field(record, 'id')), data: value(record.data) };
    },
  };
}
