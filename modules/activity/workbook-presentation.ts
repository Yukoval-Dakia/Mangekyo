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
    : { kind: 'question' as const, paper, items: [...items].sort(), ...gate };
}
