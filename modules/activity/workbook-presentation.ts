import { factId, type FactId } from '@mangekyo/kernel';
import { helpRef } from './help-exposure-values.ts';
import { object } from './values.ts';

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
    : { kind: 'question' as const, paper, items: [...items].sort(), ...gate,
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
