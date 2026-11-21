import { factId, type FactId, type FactSnapshot, type ReadContext, type Tick } from '@mangekyo/kernel';
import type { AssessmentResult } from './assessment-values.ts';
import { helpRef, sameHelpRef } from './help-exposure-values.ts';
import { materialType } from './library-values.ts';
import { retentionDeadline } from './retention-posttest.ts';
import { object } from './values.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import { withWorkbookWorkspaceBasis } from './workbook-context-read.ts';
import { workbookAttempt, workbookAttemptType, WorkbookSourceMismatch,
  type WorkbookAttempt, type WorkbookQuestion, type WorkbookRubricAssessmentView } from './workbook-values.ts';
import { WorkspaceInputError } from './workspace-values.ts';

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

type SavedCorrection = ReturnType<typeof workbookCorrection> & { id: FactId };

export async function readWorkbookCorrections(
  ids: readonly FactId[], read: ReadContext, unavailable: (error: unknown) => boolean,
) {
  const byAttempt = new Map<FactId, SavedCorrection[]>();
  for (const id of ids) {
    try {
      const fact = await read.fact(id, { mode: 'following' });
      const data = workbookCorrection(fact.value);
      const current = byAttempt.get(data.attempt.id);
      if (current) current.push({ ...data, id });
      else byAttempt.set(data.attempt.id, [{ ...data, id }]);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  return byAttempt;
}

export function sameWorkbookCorrectionAttempt(saved: SavedCorrection, original: FactSnapshot) {
  return sameHelpRef(saved.attempt, original.ref) && saved.accessEpoch === original.accessEpoch;
}

export function workbookCorrectionItems(
  attempt: WorkbookAttempt, assessments: readonly WorkbookRubricAssessmentView[], formal?: AssessmentResult,
): string[] {
  return attempt.feedback.filter(({ questionId, answer, result }) => {
    if (answer === null) return false;
    const item = attempt.paper.assessmentRelease?.items.find(({ itemId }) => itemId === questionId);
    if (!item) {
      const verdict = assessments.findLast(grade => grade.questionId === questionId)?.verdict ?? result;
      return verdict === 'incorrect' || verdict === 'partial';
    }
    let underMaximum = false;
    for (const { criterionId, maximum } of item.criteria) {
      const outcome = formal?.outcomes.find(grade => grade.itemId === questionId && grade.criterionId === criterionId);
      if (maximum === null && outcome?.state === 'qualitative') continue;
      if (maximum === null || outcome?.state !== 'scored') return false;
      if (outcome.earned < maximum) underMaximum = true;
    }
    return underMaximum;
  }).map(({ questionId }) => questionId);
}

export async function openWorkbookCorrectionSource(
  read: Pick<ReadContext, 'fact'>, materialId: string | null, question: WorkbookQuestion,
) {
  if (materialId !== null) {
    const material = await read.fact(factId(materialId), { mode: 'following' });
    if (material.type !== materialType) throw new WorkbookSourceMismatch('原作答的来源材料无效。');
  }
  // Bank sources are checked together with the frozen paper and its witness set.
  if (question.kind !== 'bank' && question.sourceQuestionRef) {
    const { id, rev } = question.sourceQuestionRef;
    try { await read.fact(factId(id), { mode: 'pinned', rev }); }
    catch (error) {
      if (error instanceof WorkspaceInputError) throw new WorkbookSourceMismatch(error.message);
      throw error;
    }
  }
}

export async function openWorkbookCorrectionTarget(read: ReadContext, target: ReturnType<typeof workbookCorrectionTarget>) {
  const fact = await read.fact(target.attempt.id, { mode: 'following' });
  if (fact.type !== workbookAttemptType || fact.ref.rev !== target.attempt.rev)
    throw new WorkbookSourceMismatch('作答已变化，请重新打开原作答。');
  const attempt = workbookAttempt(fact.value);
  const question = attempt.paper.questions.find(item => item.id === target.itemId);
  if (attempt.paperId !== target.paperId || !question ||
      !attempt.feedback.some(item => item.questionId === target.itemId && item.answer !== null))
    throw new WorkbookSourceMismatch('在这份作答中找不到已提交的题位。');
  await openWorkbookCorrectionSource(withWorkbookWorkspaceBasis(read), attempt.paper.materialId, question);
  await readFrozenWorkbookBank(read, attempt.paper);
  return { fact, attempt };
}
