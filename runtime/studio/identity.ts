import { createHash } from 'node:crypto';
import { commandId, factId, learnerId } from '../../kernel/src/declarations/ids.ts';

export function stableId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 26).toUpperCase();
}
export const studioLearner = learnerId(stableId('studio', 'synthetic-histories-v1'));
export const requestCommand = (request: string) => commandId(stableId('submission', request));
export const textbookUndoId = (token: string) => commandId(stableId('undo-textbook-write', token));
export const firstTurn = (request: string) => factId(stableId('session', request));
export const nextTurn = (session: string, parent: string) => factId(stableId('answer', session, parent));
export const sourceId = (studyCase: string, id: string) =>
  factId(stableId('learning-history-v1', studyCase, id));
export const slotType = 'activity.teachingFeedback';
export const methodName = 'activity/evidence-tutor';
export const confirmedTeachingMethod = 'activity/evidence-tutor-confirmed-v1';
export const purpose = 'teaching';
