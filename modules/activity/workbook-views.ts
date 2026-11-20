import { factId, type FactId, type ReadContext, type Revision } from '@mangekyo/kernel';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import {
  workbookAttempt, workbookAttemptType, workbookCorrectCount, workbookPaperType,
  type WorkbookAttempt, type WorkbookAttemptView, type WorkbookPaper, type WorkbookRubricAssessmentView,
  type WorkbookSourceView, type WorkbookSummary,
} from './workbook-values.ts';

export type ReviewEntry = {
  paperId: string;
  title: string;
  questionId: string;
  prompt: string;
  answer: string;
  expected: string;
  explanation: string | null;
};

export function attemptView(
  id: string,
  attempt: WorkbookAttempt,
  assessments: WorkbookRubricAssessmentView[],
): WorkbookAttemptView {
  return {
    id,
    requestId: attempt.requestId,
    submittedAt: attempt.submittedAt,
    ...(attempt.effectiveDurationMs === undefined ? {} : { effectiveDurationMs: attempt.effectiveDurationMs }),
    gradingVersion: attempt.gradingVersion,
    answers: attempt.answers,
    feedback: attempt.feedback.map(item => item.result === 'unanswered' ? {...item, expected: null, explanation: null} : item),
    assessments,
    correctCount: workbookCorrectCount(attempt.feedback),
    total: attempt.paper.questions.filter(
      q => q.kind !== 'rubric' && (q.kind !== 'exact' || !q.selfCheck),
    ).length,
  };
}

export async function readWorkbookAttempts(
  tx: ActivityEvidenceReadScope,
  read: ReadContext, unavailable: (error: unknown) => boolean,
): Promise<{ id: FactId; rev: Revision; attempt: WorkbookAttempt }[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM facts
     WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
     ORDER BY created_tick DESC, id`,
    [tx.learner, workbookAttemptType],
  );
  const attempts: Awaited<ReturnType<typeof readWorkbookAttempts>> = [];
  for (const row of rows) {
    try {
      const fact = await read.fact(factId(row.id), { mode: 'following' });
      attempts.push({ id: fact.ref.id, rev: fact.ref.rev, attempt: workbookAttempt(fact.value) });
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  return attempts;
}

export async function readWorkbookSummaries(tx: ActivityEvidenceReadScope,
  attempts: readonly {attempt: WorkbookAttempt}[], openPaper: (id: FactId) => Promise<WorkbookPaper>,
  openSource: (id: string) => Promise<WorkbookSourceView>, unavailable: (error: unknown) => boolean,
): Promise<WorkbookSummary[]> {
  const grouped = new Map<string, { count: number; last: string | null }>();
  for (const { attempt } of attempts) {
    const current = grouped.get(attempt.paperId) ?? { count: 0, last: null };
    current.count += 1;
    if (current.last === null || attempt.submittedAt > current.last) {
      current.last = attempt.submittedAt;
    }
    grouped.set(attempt.paperId, current);
  }
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM facts
     WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
     ORDER BY created_tick DESC, id`,
    [tx.learner, workbookPaperType],
  );
  const summaries: WorkbookSummary[] = [];
  for (const row of rows) {
    try {
      const paper = await openPaper(factId(row.id));
      const source = paper.materialId === null
        ? null
        : await openSource(paper.materialId);
      const usage = grouped.get(row.id);
      summaries.push({
        id: row.id,
        title: paper.title,
        questionCount: paper.questions.length,
        savedAt: paper.savedAt,
        sourceId: paper.materialId,
        sourceTitle: source?.title ?? null,
        attemptCount: usage?.count ?? 0,
        lastAttemptAt: usage?.last ?? null,
      });
    } catch (error) {
      if (unavailable(error)) continue;
      throw error;
    }
  }
  return summaries;
}

export async function projectWorkbookReview(attempts: readonly {id: FactId; attempt: WorkbookAttempt}[],
  assessments: ReadonlyMap<string, WorkbookRubricAssessmentView[]>, paperAvailable: (id: string) => Promise<boolean>,
): Promise<ReviewEntry[]> {
  const seen = new Set<string>();
  const available = new Map<string, boolean>();
  const result: ReviewEntry[] = [];
  for (const { id, attempt } of attempts) {
    if (!available.has(attempt.paperId)) available.set(attempt.paperId, await paperAvailable(attempt.paperId));
    if (!available.get(attempt.paperId)) continue;
    for (const f of attempt.feedback) {
      const key = attempt.paperId + '/' + f.questionId;
      const grade = assessments.get(id)?.find(result => result.questionId === f.questionId);
      const verdict = grade?.verdict ?? f.result;
      if (verdict === 'pending' || verdict === 'unanswered' || verdict === 'self-check' || seen.has(key)) continue;
      seen.add(key);
      if (verdict !== 'incorrect' && verdict !== 'partial') continue;
      const q = attempt.paper.questions.find(q => q.id === f.questionId);
      if (!q) continue;
      const expected = f.expected.kind === 'exact'
        ? f.expected.values.join(' / ')
        : f.expected.kind === 'rubric'
          ? f.expected.rubric
          : [f.expected.value, f.expected.unit].filter(x => x !== null).join(' ');
      result.push({ paperId: attempt.paperId, title: attempt.paper.title, questionId: q.id,
        prompt: q.prompt, answer: String(f.answer), expected, explanation: grade?.feedback ?? f.explanation });
    }
  }
  return result;
}
