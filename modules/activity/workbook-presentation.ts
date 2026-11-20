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
  return kind === 'solution'
    ? { kind: 'solution' as const, paper, items: [...items].sort(), submission: helpRef(row.submission) }
    : { kind: 'question' as const, paper, items: [...items].sort() };
}
