import { workbookAttemptUsage, workbookSummary, workbookMistakes } from './workbook-assessment-values.ts';
import { factId, type FactId, type FactRef, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import { projectHelpExposure, type AdmittedHelpEvent } from './help-exposure.ts';
import type { HelpTarget } from './help-exposure-values.ts';
import type { SourceRefV1 } from './source-values.ts';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import {
  workbookAttempt, workbookAttemptType,
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
  read: ReadContext, unavailable: (error: unknown) => boolean, paperId?: FactId,
): Promise<{ id: FactId; rev: Revision; attempt: WorkbookAttempt; fact: FactSnapshot }[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT f.id FROM facts f
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
       AND ($3::text IS NULL OR EXISTS (
         SELECT FROM fact_revs r WHERE (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
           AND r.data->>'paperId'=$3
       ))
     ORDER BY f.created_tick DESC, f.id`,
    [tx.learner, workbookAttemptType, paperId ?? null],
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

export async function readWorkbookSummaries(paperIds: readonly FactId[],
  attempts: readonly {attempt: WorkbookAttempt}[], openPaper: (id: FactId) => Promise<WorkbookPaper>,
  openSource: (id: string) => Promise<WorkbookSourceView>, unavailable: (error: unknown) => boolean,
): Promise<WorkbookSummary[]> {
  const grouped = workbookAttemptUsage(attempts);
  const summaries: WorkbookSummary[] = [];
  for (const id of paperIds) {
    try {
      const paper = await openPaper(id);
      const source = paper.materialId === null
        ? null
        : await openSource(paper.materialId);
      summaries.push(workbookSummary(id,paper,source,grouped.get(id)));
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

type DiagnosisSource = { id: string; rev: number; title: string; sourceRef: SourceRefV1 };
type DiagnosisHelp = { ref: FactRef; cutoff: Tick; targets: readonly HelpTarget[]; events: readonly AdmittedHelpEvent[] };

export function workbookDiagnosisView<Formal>(
  source: DiagnosisSource, attempt: WorkbookAttempt, paper: { id: FactId; rev: Revision },
  { ref, cutoff, targets, events }: DiagnosisHelp,
  assessments: readonly Pick<WorkbookRubricAssessmentView, 'questionId' | 'verdict' | 'score'>[],
  formalAssessment: Formal | undefined,
  feedback: readonly {result: string}[] = attempt.feedback,
) {
  const unavailable = { state: 'unavailable' } as const;
  const byQuestion = new Map(assessments.map(({ questionId, verdict, score }) => [questionId, { verdict, ...(score ? { score } : {}) }]));
  const questions = attempt.paper.questions.map((question, index) => {
    const { id, prompt, kind } = question;
    const observed = projectHelpExposure({ submission: { ref, target: targets[index]!, cutoff }, events, coverage: null });
    const { result } = feedback[index]!;
    const assessment = byQuestion.get(id) ?? { verdict: result };
    return { id, prompt, answer: attempt.answers[id], kind, assessment,
      ...(kind === 'numeric' ? { unit: question.unit } : {}),
      independence: observed.kind === 'exposed' ? 'exposed' : 'unknown',
      help_exposure: observed.kind === 'exposed'
        ? { state: 'exposed', evidenceRefs: observed.evidenceRefs.map(({ id, rev }) => ({ id, rev })) }
        : { state: 'unknown', reason: observed.kind === 'unknown' ? observed.reason : 'incomplete-observation' } };
  });
  return { id: source.id, rev: source.rev, title: source.title, kind: 'attempt', lens: 'diagnose',
    sourceRef: source.sourceRef, frozenPaper: paper, questions, ...(formalAssessment ? { formalAssessment } : {}),
    image_crop: unavailable,
    effective_duration_ms: attempt.effectiveDurationMs === undefined ? unavailable
      : { state: 'observed', value: attempt.effectiveDurationMs, source: 'browser-focus-v1' },
    concept_history: unavailable, mastery: unavailable, retention: unavailable };
}
