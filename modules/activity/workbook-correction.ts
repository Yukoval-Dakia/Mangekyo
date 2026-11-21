import { factId, type FactId, type FactSnapshot, type ReadContext, type Tick } from '@mangekyo/kernel';
import { helpRef } from './help-exposure-values.ts';
import { retentionDeadline } from './retention-posttest.ts';
import { object } from './values.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import { workbookAttempt, workbookAttemptType, WorkbookSourceMismatch } from './workbook-values.ts';

export const workbookCorrectionType = 'activity.workbookCorrection';
export const recordWorkbookCorrection = 'activity.recordWorkbookCorrection';

export function workbookCorrectionTarget(input: unknown) {
  const { paperId, attempt, itemId } = object(input);
  if (typeof paperId !== 'string' || typeof itemId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(itemId))
    throw new Error('订正需要原卷、作答和题位。');
  return { paperId: factId(paperId), attempt: helpRef(attempt), itemId };
}

export function workbookCorrection(input: unknown) {
  const { accessEpoch, correctedAt } = object(input);
  if (typeof accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(accessEpoch))
    throw new Error('订正缺少原作答的授权代次。');
  return { ...workbookCorrectionTarget(input), accessEpoch: accessEpoch as Tick, correctedAt: retentionDeadline(correctedAt) };
}

export async function projectWorkbookCorrections(ids: readonly FactId[], open: (id: FactId) => Promise<FactSnapshot | undefined>) {
  const byAttempt = new Map<FactId, string[]>();
  for (const id of ids) {
    const fact = await open(id);
    if (fact?.type !== workbookCorrectionType) continue;
    const { attempt, itemId } = workbookCorrection(fact.value);
    byAttempt.set(attempt.id, [...(byAttempt.get(attempt.id) ?? []), itemId]);
  }
  return byAttempt;
}

export async function openWorkbookCorrectionTarget(read: ReadContext, target: ReturnType<typeof workbookCorrectionTarget>) {
  const fact = await read.fact(target.attempt.id, { mode: 'following' });
  if (fact.type !== workbookAttemptType || fact.ref.rev !== target.attempt.rev)
    throw new WorkbookSourceMismatch('作答已变化，请重新打开原作答。');
  const attempt = workbookAttempt(fact.value);
  if (attempt.paperId !== target.paperId || !attempt.feedback.some(item => item.questionId === target.itemId && item.answer !== null))
    throw new WorkbookSourceMismatch('在这份作答中找不到已提交的题位。');
  if (attempt.paper.materialId !== null) await read.fact(factId(attempt.paper.materialId), { mode: 'following' });
  await readFrozenWorkbookBank(read, attempt.paper);
  return fact;
}
