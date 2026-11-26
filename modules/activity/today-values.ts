import type { FactSnapshot } from '@mangekyo/kernel';
import { studyRecordFact, studyTurn, studyTurnType } from './values.ts';
import { materialType, textMaterial } from './library-values.ts';
import { intakeDocument, intakeFactType } from '@mangekyo/module-capture/facts/intake-document';
import { workbookCorrection, workbookCorrectionType } from './workbook-correction.ts';
import {
  workbookAttempt,
  workbookPaper,
  workbookAttemptType,
  workbookPaperType,
  workbookRubricAssessment,
  workbookRubricAssessmentType,
  type WorkbookRubricAssessmentView,
} from './workbook-values.ts';

function todayMode(mode: string): 'any' | 'one-hand' | 'voice' {
  if (mode !== 'any' && mode !== 'one-hand' && mode !== 'voice') throw new Error('学习模式无效。');
  return mode;
}

export function todaySettings(params: URLSearchParams, now: string) {
  const mode = todayMode(params.get('mode') ?? 'any');
  const timeZone = params.get('timeZone') ?? 'Asia/Tokyo';
  const clock = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' });
  const previous = params.get('lastOpenedAt');
  const lastOpenedAt = previous === null ? undefined : new Date(previous).toISOString();
  if (lastOpenedAt && lastOpenedAt > now) throw new Error('上次打开时间无效。');
  return { mode, timeZone, now, ...(lastOpenedAt ? { lastOpenedAt } : {}), dayOf: (at: string) => clock.format(new Date(at)) };
}

/** Best-effort ISO submittedAt shared by workbook attempts and study records. */
export function factSubmittedAt(value: unknown): string | undefined {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).submittedAt : undefined;
  if (typeof raw !== 'string') return undefined;
  try { return new Date(raw).toISOString(); } catch { return undefined; }
}

export function todayCompletion(fact: FactSnapshot, today: string, dayOf: (at: string) => string) {
  if (fact.type === workbookAttemptType) {
    const attempt = workbookAttempt(fact.value);
    return dayOf(attempt.submittedAt) === today ? attempt.paperId + '/' + attempt.paper.savedAt : null;
  }
  const record = studyRecordFact(fact.value);
  return record.offlinePack && record.submittedAt && dayOf(record.submittedAt) === today
    ? record.offlinePack.id + '@' + record.offlinePack.rev : null;
}

export function todayPaper(fact: FactSnapshot, completed: ReadonlySet<string | null>, day: string) {
  const paper = workbookPaper(fact.value);
  // The ordinary workbook route can reopen a learner-authored fixed paper. It
  // does not attest that an external question release still meets its policy.
  if (paper.materialId || paper.assessmentRelease || paper.questions.some(q => q.sourceQuestionRef)) return;
  const { id, rev } = fact.ref;
  return {
    id: id + '@' + rev, title: paper.title, topic: paper.title, kind: 'review' as const,
    minutes: Math.min(1440, paper.questions.length * 3), durationBasis: '按每题约 3 分钟估算。',
    input: 'write' as const, open: { kind: 'activity' as const, id, rev }, reason: '这份自编练习已经保存，可以直接作答。',
    evidence: [id + '@' + rev], delayImpact: '推迟后，这份练习的本次作答结果仍未知。',
    ...(completed.has(id + '/' + paper.savedAt) ? { state: 'completed' as const, date: day } : {}),
  };
}

// One host-side projection row for plan/pending-corrections. The structural
// contract is enforced by `projectPendingCorrectionCandidates` at the call
// site; modules must not import non-facts/slots exports across packages.
type PendingCorrectionRow = {
  paperId: string; paperRev: number; attemptId: string; attemptRev: number; title: string; submittedAt: string;
  items: readonly {
    itemId: string; outcome: 'incorrect' | 'partial'; source: 'attempt' | 'rubric'; corrected: boolean;
    evidenceRef: string;
  }[];
};

// Collects unretired wrong or partially-correct items from every visible
// submitted attempt on a visible workbook paper. Read authorization already
// filters revoked or retracted facts, so this only sees permitted snapshots.
// Corrections are matched per (paper, attempt ref + access epoch, item).
export function collectPendingCorrectionSources(
  facts: readonly FactSnapshot[], settledRubrics?: ReadonlyMap<string, readonly WorkbookRubricAssessmentView[]>,
): PendingCorrectionRow[] {
  const papers = new Map<string, FactSnapshot>();
  const attempts: FactSnapshot[] = [];
  const rubrics: FactSnapshot[] = [];
  const corrections: ReturnType<typeof workbookCorrection>[] = [];
  for (const fact of facts) {
    if (fact.type === workbookPaperType) papers.set(fact.ref.id, fact);
    else if (fact.type === workbookAttemptType) attempts.push(fact);
    else if (fact.type === workbookRubricAssessmentType) rubrics.push(fact);
    else if (fact.type === workbookCorrectionType) corrections.push(workbookCorrection(fact.value));
  }
  const rows: PendingCorrectionRow[] = [];
  for (const attemptFact of attempts) {
    const attempt = workbookAttempt(attemptFact.value);
    const paper = papers.get(attempt.paperId);
    if (!paper) continue;
    const corrected = (itemId: string) =>
      corrections.some(record =>
        record.paperId === attempt.paperId && record.itemId === itemId &&
        record.attempt.id === attemptFact.ref.id && record.attempt.rev === attemptFact.ref.rev &&
        record.accessEpoch === attemptFact.accessEpoch);
    const items: PendingCorrectionRow['items'][number][] = [];
    const evidenceRefs = new Set<string>();
    const addItem = (item: PendingCorrectionRow['items'][number]) => {
      if (evidenceRefs.has(item.evidenceRef)) return;
      evidenceRefs.add(item.evidenceRef);
      items.push(item);
    };
    for (const feedback of attempt.feedback) {
      if (feedback.answer === null || (feedback.result !== 'incorrect' && feedback.result !== 'partial')) continue;
      addItem({
        itemId: feedback.questionId, outcome: feedback.result, source: 'attempt',
        corrected: corrected(feedback.questionId),
        evidenceRef: `${attemptFact.ref.id}@${attemptFact.ref.rev}`,
      });
    }
    for (const rubricFact of rubrics) {
      const assessment = workbookRubricAssessment(rubricFact.value);
      if (assessment.attemptId !== attemptFact.ref.id || assessment.paperId !== attempt.paperId) continue;
      if (assessment.verdict !== 'incorrect' && assessment.verdict !== 'partial') continue;
      addItem({
        itemId: assessment.questionId, outcome: assessment.verdict, source: 'rubric',
        corrected: corrected(assessment.questionId),
        evidenceRef: `${rubricFact.ref.id}@${rubricFact.ref.rev}`,
      });
    }
    for (const assessment of settledRubrics?.get(attemptFact.ref.id) ?? []) {
      if (assessment.paperId !== attempt.paperId || (assessment.verdict !== 'incorrect' && assessment.verdict !== 'partial')) continue;
      addItem({
        itemId: assessment.questionId, outcome: assessment.verdict, source: 'rubric', corrected: corrected(assessment.questionId),
        evidenceRef: `${assessment.id}@1`,
      });
    }
    if (!items.length) continue;
    rows.push({
      paperId: paper.ref.id, paperRev: paper.ref.rev, attemptId: attemptFact.ref.id,
      attemptRev: attemptFact.ref.rev, title: workbookPaper(paper.value).title,
      submittedAt: attempt.submittedAt,
      items,
    });
  }
  return rows;
}

export type FreshMaterialSource = {
  readonly id: string; readonly rev: number; readonly title: string; readonly savedAt: string;
  readonly hasDerivedActivity: boolean;
} & {readonly questionCount?: number; readonly redPenErrorCount?: number};

function freshMaterialHints(document: unknown) {
  const questions = intakeDocument(document).extraction.drafts?.questions;
  if (!questions?.length) return {};
  const redPenErrorCount = questions.filter(question => question.redInk.verdict === 'wrong' || question.redInk.verdict === 'partial' || question.redInk.correction !== null).length;
  return {questionCount: questions.length, redPenErrorCount};
}

export function collectFreshMaterialSources(facts: readonly FactSnapshot[]): FreshMaterialSource[] {
  const sources = new Map<string, Omit<FreshMaterialSource, 'hasDerivedActivity'>>();
  const derived = new Set<string>();
  const intakes = new Map<string, ReturnType<typeof freshMaterialHints>>();
  for (const fact of facts) {
    if (fact.type === materialType) {
      const material = textMaterial(fact.value);
      if (material.savedAt !== undefined)
        sources.set(fact.ref.id, { id: fact.ref.id, rev: fact.ref.rev, title: material.title, savedAt: material.savedAt });
    } else if (fact.type === intakeFactType) {
      const document = intakeDocument(fact.value);
      intakes.set(document.materialId, freshMaterialHints(document));
    } else if (fact.type === workbookPaperType) {
      const paper = workbookPaper(fact.value);
      if (paper.materialId !== null) derived.add(paper.materialId);
      for (const question of paper.questions)
        if (question.sourceQuestionRef?.id !== undefined) derived.add(question.sourceQuestionRef.id);
    } else if (fact.type === studyTurnType) {
      const turn = studyTurn(fact.value);
      if (turn.attachment !== undefined) derived.add(turn.attachment.id);
      if (turn.currentObject !== undefined) derived.add(turn.currentObject.id);
    }
  }
  return [...sources].map(([id, source]) => ({ ...source, ...intakes.get(id), hasDerivedActivity: derived.has(id) }));
}
