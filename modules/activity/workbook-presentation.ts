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
  if (row.issuanceId !== undefined && (row.attemptRef !== undefined || kind !== 'question' || phase === undefined || typeof row.issuanceId !== 'string'))
    throw new Error('无效的纸面发放标识。');
  const print = row.issuanceId === undefined ? {} : { issuanceId: factId(row.issuanceId) };
  return kind === 'solution'
    ? { kind: 'solution' as const, paper, items: [...items].sort(), submission: helpRef(row.submission), ...gate }
    : { kind: 'question' as const, paper, items: [...items].sort(), ...gate, ...print,
      ...(row.attemptRef === undefined ? {} : {attemptRef:helpRef(row.attemptRef)}) };
}

export function workbookReadingContext(value: unknown) {
  const {paperRev, itemId, ref, phase, permit, displayRef, attemptRef} = object(value);
  if (typeof paperRev !== 'number' || !Number.isInteger(paperRev) || paperRev < 1 || paperRev > 2147483647 ||
      typeof itemId !== 'string' || !/^[\w.-]{1,128}$/.test(itemId) ||
      typeof ref !== 'string' || !/^[\w-]{43}$/.test(ref))
    throw new WorkbookPresentationError('帮助引用格式无效。');
  const attempt = attemptRef === undefined ? undefined : helpRef(attemptRef);
  if (attempt && attempt.rev > 2147483647) throw new WorkbookPresentationError('作答版本无效。');
  const mount = {paperRev, itemId, ref, attemptRef:attempt};
  if (phase === 'opened' && typeof permit === 'string') return {...mount, phase: 'opened' as const, permit:factId(permit)};
  if (phase === 'displayed' && typeof displayRef === 'string' && /^[\w-]{43}$/.test(displayRef))
    return {...mount,phase:'displayed' as const,displayRef};
  throw new WorkbookPresentationError('缺少帮助呈现许可。');
}

export function printedWorkbookPresentation(
  paper: ReturnType<typeof helpRef>,
  issued: { issuanceId: FactId; pages: readonly { pieces: readonly { itemId: string | null }[] }[] },
  permit?: FactId,
) {
  const items = [...new Set(issued.pages.flatMap(page => page.pieces.flatMap(piece => piece.itemId ? [piece.itemId] : [])))];
  return workbookPresentation({
    kind: 'question', paper, items, issuanceId: issued.issuanceId,
    ...(permit ? { phase: 'displayed', permit } : { phase: 'permit' }),
  });
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
  if ('issuanceId' in data && data.issuanceId) {
    const issue = await read.fact(data.issuanceId, { mode: 'following' });
    if (issue.type !== 'capture.paperIssuance' || issue.ref.rev !== 1 ||
        !sameWorkbookJson(helpRef(object(issue.value).source), data.paper))
      throw new WorkbookPresentationError('纸面发放与固定卷面不匹配。');
  }
  const submitted = data.kind === 'solution' ? data.submission : data.attemptRef;
  if (submitted) {
    const submission = await read.fact(submitted.id, { mode: 'pinned', rev: submitted.rev });
    if (submission.type !== workbookAttemptType) throw new WorkbookPresentationError('需要已送达的作答反馈。');
    const attempt = workbookAttempt(submission.value);
    if (attempt.paperId !== shown.ref.id || !sameWorkbookJson(attempt.paper, paper) ||
        (data.kind === 'solution' && !data.items.every(id => attempt.feedback.some(item => item.questionId === id &&
          item.result !== 'unanswered' && item.expected !== null && item.expected.kind !== 'rubric')))) {
      throw new WorkbookPresentationError('参考答案与实际反馈不匹配。');
    }
  }
}
