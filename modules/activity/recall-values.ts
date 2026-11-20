import { derivationId, factId, type Revision, type Tick } from '@mangekyo/kernel';
import type { HelpRef, HelpTarget } from './help-exposure-values.ts';
import { gradeWorkbook, type WorkbookQuestion } from './workbook-values.ts';

export const recallIssuanceType = 'activity.recallIssuance';
export const recallSubmissionType = 'activity.recallSubmission';
export const issueRecallCommand = 'activity.issueRecall';
export const submitRecallCommand = 'activity.submitRecall';
export const recallResponseId = 'answer';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('回忆题记录格式无效。');
  return value as Record<string, unknown>;
}

function id(value: unknown) {
  if (typeof value !== 'string') throw new Error('回忆题缺少标识。');
  return factId(value);
}

function ref(value: unknown): HelpRef {
  const row = record(value);
  if (typeof row.rev !== 'number' || !Number.isSafeInteger(row.rev) || row.rev < 1) {
    throw new Error('回忆题引用版本无效。');
  }
  return { id: id(row.id), rev: row.rev as Revision };
}

export function recallText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit ||
      !value.isWellFormed() || value.includes('\0')) throw new Error('回忆题文本无效。');
  return value;
}

export function recallIssuance(value: unknown) {
  const { turn, version, materials, items } = record(value);
  if (!Array.isArray(materials) || materials.length > 2 || !Array.isArray(items) ||
      items.length < 2 || items.length > 4 || typeof version !== 'string') {
    throw new Error('回忆题发放记录无效。');
  }
  const questions = items.map((item: unknown) => {
    const row = record(item);
    return {
      itemId: id(row.itemId),
      prompt: recallText(row.prompt, 500),
      answer: recallText(row.answer, 600),
      ...(row.rubric === undefined ? {} : { rubric: recallText(row.rubric, 2000) }),
    };
  });
  if (new Set(questions.map(item => item.itemId)).size !== questions.length) {
    throw new Error('回忆题题项重复。');
  }
  return {
    turn: ref(turn),
    version: derivationId(version),
    materials: materials.map((material: unknown) => {
      const row = record(material);
      if (typeof row.accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.accessEpoch)) {
        throw new Error('回忆题授权见证无效。');
      }
      return { ref: ref(row.ref), accessEpoch: row.accessEpoch as Tick };
    }),
    items: questions,
  };
}

export function recallSubmission(value: unknown) {
  const { issuance, itemId, responseId, answer, observation } = record(value);
  if (responseId !== recallResponseId || (observation !== 'complete' && observation !== 'unknown')) {
    throw new Error('回忆题作答位或观测状态无效。');
  }
  return {
    issuance: ref(issuance), itemId: id(itemId), responseId,
    answer: recallText(answer, 4000), observation,
  };
}

export function recallTarget(issuance: HelpRef, itemId: string): HelpTarget {
  return { activityId: issuance.id, issuance, item: { itemId, responseId: recallResponseId } };
}

export function gradeRecallItem(item: ReturnType<typeof recallIssuance>['items'][number], answer: string) {
  const base = { id: item.itemId, prompt: item.prompt, explanation: null };
  const question: WorkbookQuestion = item.rubric
    ? { ...base, kind: 'rubric', rubric: item.rubric, rubricVersion: 'rubric-v1' }
    : { ...base, kind: 'exact', answers: [item.answer], selfCheck: false };
  const { feedback: [feedback] } = gradeWorkbook(
    { title: '回忆题', materialId: null, savedAt: '', questions: [question] },
    { [item.itemId]: answer },
  );
  if (!feedback) throw new Error('Missing Recall result');
  return feedback.result;
}

export function recallFields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error('回忆题请求字段无效。');
  }
  return value as Record<string, unknown>;
}

export function parseRecallMount(value: unknown) {
  const { turnId, derivationId: version, itemId } = recallFields(value, ['turnId', 'derivationId', 'itemId']);
  if (typeof turnId !== 'string' || typeof version !== 'string' || typeof itemId !== 'string') {
    throw new Error('回忆题挂载标识无效。');
  }
  return { turnId: factId(turnId), derivationId: derivationId(version), itemId: factId(itemId) };
}
