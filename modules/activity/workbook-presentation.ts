import { factId, type FactId, type ReadContext } from '@mangekyo/kernel';
import { helpRef } from './help-exposure-values.ts';
import { object } from './values.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import { sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType } from './workbook-values.ts';

export const workbookPresentationType = 'activity.workbookPresentation';
export const recordWorkbookPresentationCommand = 'activity.recordWorkbookPresentation';
export class WorkbookPresentationError extends Error {}

export function workbookPresentation(value: unknown) {
  try { return parsePresentation(value); }
  catch { throw new WorkbookPresentationError('卷面呈现见证格式无效。'); }
}

function parsePresentation(value: unknown) {
  const row = object(value);
  const { kind, items } = row;
  if ((kind !== 'question' && kind !== 'solution') || !Array.isArray(items) || !items.length || items.length > 100 ||
      !items.every((id): id is string => typeof id === 'string' && /^[\w.-]{1,128}$/.test(id)) ||
      new Set(items).size !== items.length) throw new Error('卷面呈现见证格式无效。');
  const paper = helpRef(row.paper);
  const phase = row.phase;
  let gate: { phase?: 'permit' | 'displayed'; permit?: FactId } = {};
  if (phase === 'permit' && row.permit === undefined) gate = { phase };
  else if (phase === 'displayed' && typeof row.permit === 'string') gate = { phase, permit: factId(row.permit) };
  else if (phase !== undefined || row.permit !== undefined) throw new Error('无效的卷面呈现许可。');
  return kind === 'solution'
    ? { kind: 'solution' as const, paper, items: [...items].sort(), submission: helpRef(row.submission), ...gate }
    : { kind: 'question' as const, paper, items: [...items].sort(), ...gate };
}

export async function authorizeWorkbookPresentation(read: Pick<ReadContext, 'fact'>, data: ReturnType<typeof workbookPresentation>) {
  if (data.phase === 'displayed') {
    const { phase, permit, ...scope } = data;
    if (!permit) throw new WorkbookPresentationError('缺少呈现许可。');
    const reservation = await read.fact(permit, { mode: 'following' });
    if (reservation.type !== workbookPresentationType ||
        !sameWorkbookJson(reservation.value, { ...scope, phase: 'permit' })) {
      throw new WorkbookPresentationError('许可与题面或反馈版本不匹配。');
    }
  }
  const shown = await read.fact(data.paper.id, { mode: 'pinned', rev: data.paper.rev });
  if (shown.type !== workbookPaperType) throw new WorkbookPresentationError('需要已送达的普通试卷。');
  const paper = workbookPaper(shown.value);
  await readFrozenWorkbookBank(read, paper);
  if (!data.items.every(id => paper.questions.some(question => question.id === id))) {
    throw new WorkbookPresentationError('呈现题项与卷面不匹配。');
  }
  if (data.kind === 'solution') {
    const submission = await read.fact(data.submission.id, { mode: 'pinned', rev: data.submission.rev });
    if (submission.type !== workbookAttemptType) throw new WorkbookPresentationError('需要已送达的作答反馈。');
    const attempt = workbookAttempt(submission.value);
    if (attempt.paperId !== shown.ref.id || !sameWorkbookJson(attempt.paper, paper) ||
        !data.items.every(id => attempt.feedback.some(item => item.questionId === id &&
          item.result !== 'unanswered' && item.expected !== null && item.expected.kind !== 'rubric'))) {
      throw new WorkbookPresentationError('参考答案与实际反馈不匹配。');
    }
  }
}
