import { factId, type FactId, type FactSnapshot, type ReadContext, type ReadTransaction, type Revision } from '@mangekyo/kernel';
import type { QuestionConceptLink, KnowledgeGraphNodeDraft } from '@mangekyo/module-content/facts/knowledge-graph-overview';
import type { ConceptMasteryView } from '@mangekyo/module-learner/facts/knowledge-mastery';
import { projectWeaknessAndErrorSummary, type ErrorStage, type WeaknessAndErrorSummaryView, type WeaknessConceptInput, type WeaknessErrorSample, type WeaknessEvidenceRef } from '@mangekyo/module-learner/facts/weakness-error-summary';
import type { AssessmentResult } from './assessment-values.ts';
import { workbookMistakes } from './workbook-assessment-values.ts';
import type { ConceptEvidenceRow } from './concept-evidence.ts';
import { allAssessments } from './learning-attempt-read.ts';
import { readWorkbookCorrections, sameWorkbookCorrectionAttempt, workbookCorrectionItems } from './workbook-correction.ts';
import { listWorkbookCorrectionIds } from './workbook-operations.ts';
import { posttestIssuanceType, retentionPaperType } from './retention-posttest.ts';
import { readWorkbookAttempts } from './workbook-views.ts';
import { workbookPaperType, type WorkbookPaper } from './workbook-values.ts';
export type WeaknessOverviewPorts = {
  readonly asOf: string;
  readonly read: ReadContext;
  readonly attemptEvidence: readonly ConceptEvidenceRow[];
  readonly nodes: readonly KnowledgeGraphNodeDraft[];
  readonly links: readonly QuestionConceptLink[];
  readonly mastery: ReadonlyMap<FactId, ConceptMasteryView>;
  readonly isUnavailable: (error: unknown) => boolean;
  readonly formalFor: (paper: WorkbookPaper, ref: { id: FactId; rev: Revision }) => Promise<AssessmentResult | undefined>;
};
/** Wave Next-E: assemble weakness view strictly from authorized evidence. `attemptEvidence` already
 * carries the S11 independent/exposed verdict; this attaches authorized errorStage and red-pen counts. */
export async function gatherWeaknessOverview(tx: ReadTransaction, ports: WeaknessOverviewPorts): Promise<WeaknessAndErrorSummaryView> {
  const attemptFacts = await readWorkbookAttempts(tx, ports.read, ports.isUnavailable);
  const grades = await allAssessments(tx);
  const stageByKey = new Map<string, { readonly errorStage: ErrorStage; readonly itemId: string }>();
  const uncorrectedByConcept = new Map<FactId, number>();
  const seen = new Set<string>();
  const conceptByQuestion = new Map<string, FactId[]>();
  for (const { questionId, questionRev, conceptId } of ports.links) {
    const key = `${questionId}:${questionRev}`, list = conceptByQuestion.get(key) ?? [];
    list.push(conceptId); conceptByQuestion.set(key, list);
  }
  for (const { id, rev, attempt, fact } of attemptFacts) {
    const formal = attempt.paper.assessmentRelease
      ? await ports.formalFor(attempt.paper, { id, rev }).catch(error => {
          if (ports.isUnavailable(error)) return undefined;
          throw error;
        }) : undefined;
    const byItem = new Map(attempt.paper.questions.map(q => [q.id, q.sourceQuestionRef] as const));
    for (const entry of workbookMistakes(attempt, grades.get(id) ?? [], seen, formal)) {
      const source = byItem.get(entry.questionId);
      if (source && entry.errorStage) stageByKey.set(`${id}:${source.id}:${source.rev}`, { errorStage: entry.errorStage, itemId: entry.questionId });
    }
    const eligible = workbookCorrectionItems(attempt, grades.get(id) ?? [], formal).filter(itemId => byItem.get(itemId));
    if (!eligible.length) continue;
    const correctionIds = await listWorkbookCorrectionIds(tx, factId(attempt.paperId), id);
    const corrected = new Set((correctionIds.length ? (await readWorkbookCorrections(correctionIds, ports.read, ports.isUnavailable)).get(id) ?? [] : [])
      .filter(saved => sameWorkbookCorrectionAttempt(saved, fact as FactSnapshot)).map(saved => saved.itemId));
    const counted = new Set<FactId>();
    for (const itemId of eligible) if (!corrected.has(itemId)) {
      const source = byItem.get(itemId)!;
      for (const conceptId of conceptByQuestion.get(`${source.id}:${source.rev}`) ?? []) {
        if (!counted.has(conceptId)) { counted.add(conceptId); uncorrectedByConcept.set(conceptId, (uncorrectedByConcept.get(conceptId) ?? 0) + 1); }
      }
    }
  }
  const errorSamples: WeaknessErrorSample[] = ports.attemptEvidence.map(row => {
    const staged = stageByKey.get(`${row.submission.id}:${row.questionId}:${row.questionRev}`);
    const paper = row.basisRefs.find(ref => ref.type === workbookPaperType || ref.type === retentionPaperType || ref.type === posttestIssuanceType);
    const evidenceRef: WeaknessEvidenceRef = { id: row.submission.id, rev: row.submission.rev,
      ...(staged?.itemId === undefined ? {} : { itemId: staged.itemId }), href: `/papers/${paper?.id ?? row.submission.id}` };
    return { evidenceRef, occurredAt: row.occurredAt, outcome: row.outcome,
      helpLevel: row.exposure === 'independent' ? 'independent' : row.exposure === 'exposed' ? 'hinted' : 'unknown',
      ...(staged?.errorStage === undefined ? {} : { errorStage: staged.errorStage }), conceptId: row.conceptId };
  });
  const concepts: WeaknessConceptInput[] = ports.nodes.map(node => {
    const mastery = ports.mastery.get(node.id);
    return { conceptId: node.id, title: node.title, status: mastery?.status ?? 'unknown', retrievability: mastery?.retrievability ?? null,
      independentAttempts: mastery?.independentCount ?? 0, uncorrectedErrorCount: uncorrectedByConcept.get(node.id) ?? 0,
      hasPracticeQuestions: node.counts.questions > 0, evidenceRefs: (mastery?.basisRefs ?? []).map(ref => ({ id: ref.id, rev: ref.rev })) };
  });
  return projectWeaknessAndErrorSummary({ asOf: ports.asOf, errorSamples, concepts });
}
