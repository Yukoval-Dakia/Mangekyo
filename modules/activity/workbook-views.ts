import { workbookAttemptUsage, workbookSummary, workbookMistakes } from './workbook-assessment-values.ts';
import { factId, type FactId, type FactSnapshot, type ReadContext, type Revision } from '@mangekyo/kernel';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import {
  workbookAttempt, workbookAttemptType, workbookPaperType,
  type WorkbookAttempt, type WorkbookPaper, type WorkbookRubricAssessmentView,
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

export async function readWorkbookAttempts(
  tx: ActivityEvidenceReadScope,
  read: ReadContext, unavailable: (error: unknown) => boolean,
): Promise<{ id: FactId; rev: Revision; attempt: WorkbookAttempt; fact: FactSnapshot }[]> {
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
      attempts.push({ id: fact.ref.id, rev: fact.ref.rev, attempt: workbookAttempt(fact.value),fact });
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
  const grouped = workbookAttemptUsage(attempts);
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
      summaries.push(workbookSummary(factId(row.id),paper,source,grouped.get(row.id)));
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
    result.push(...workbookMistakes(attempt, assessments.get(id) ?? [], seen));
  }
  return result;
}
