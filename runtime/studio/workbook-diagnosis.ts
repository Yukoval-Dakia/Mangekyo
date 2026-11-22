import { revisionsOnlyChangeGrants } from '../../kernel/src/commands/fact-collection.ts';
import {
  createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactReadOptions, FactSnapshot, ReadContext } from '../../kernel/src/declarations/types.ts';
import { readConceptAttemptEvidence, type ConceptEvidenceRow } from '../../modules/activity/concept-evidence.ts';
import { mapConceptForecastInputs } from '../../modules/activity/concept-evidence.ts';
import { verifyWorkspaceEntryBasis, workspaceEntry } from '../../modules/activity/workspace-values.ts';
import { intakeTextOf } from '../../modules/activity/workspace-source-projection.ts';
import { intakeFactType } from '../../modules/capture/intake-values.ts';
import { readAuthorizedKnowledgeGraph, type QuestionConceptLink } from '../../modules/content/knowledge-graph-overview.ts';
import { widenedRevOr } from '../../modules/learner/widened-rev.ts';
import { extractConceptForecastSignals, projectBatchConceptMastery } from '../../modules/learner/knowledge-mastery.ts';
import type { SourceRefV1 } from '../../modules/activity/source-values.ts';
import type { WorkbookAttempt } from '../../modules/activity/workbook-values.ts';
import type { WorkbookDiagnosisContext } from '../../modules/activity/workbook-views.ts';
import { readAuthorizedRetention } from './learner-radar.ts';
import { checkStudioNotionFact } from './notion.ts';
import { sourceRefV1 } from '../../modules/activity/source-values.ts';
import {
  openWorkbookDiagnosisSource as openSource, openWorkbookQuestionSources as openQuestions,
  readReleasedAssessment as readReleased, readWorkbookDiagnosis as readDiagnosis,
  studioDiagnosisSourceUnavailable, type StudioDiagnosisDeps,
} from '../../modules/activity/studio-diagnosis-host.ts';
import { purpose } from './identity.ts';
import { resolveSource } from './source-read.ts';
import { readSavedWorkbookAssessment } from './workbook-assessment.ts';
import { readWorkspaceAttemptAssessments } from './workspace-read.ts';

const deps: StudioDiagnosisDeps = {
  purpose,
  isFactNotFound: error => error instanceof FactNotFoundError,
  isFactReadDenied: error => error instanceof FactReadDeniedError,
  revisionsOnlyChangeGrants: revisionsOnlyChangeGrants as StudioDiagnosisDeps['revisionsOnlyChangeGrants'],
  createAuthorizedFactReader: createAuthorizedFactReader as StudioDiagnosisDeps['createAuthorizedFactReader'],
  createCommandReadContext: createCommandReadContext as StudioDiagnosisDeps['createCommandReadContext'],
  resolveSource: resolveSource as StudioDiagnosisDeps['resolveSource'],
  readSavedWorkbookAssessment: readSavedWorkbookAssessment as StudioDiagnosisDeps['readSavedWorkbookAssessment'],
  readWorkspaceAttemptAssessments: readWorkspaceAttemptAssessments as StudioDiagnosisDeps['readWorkspaceAttemptAssessments'],
  diagnosisContext,
};

type Access = Parameters<typeof openSource>[3];
export type { Access as WorkbookDiagnosisAccess };

export const openWorkbookDiagnosisSource = (tx: ReadTransaction, reference: string | SourceRefV1, access: Access) =>
  openSource(deps, tx, reference, access);
export const openWorkbookQuestionSources = (tx: ReadTransaction, submission: FactSnapshot, access: Access, itemId?: string) =>
  openQuestions(deps, tx, submission, access, itemId);
export const readReleasedAssessment = (tx: ReadTransaction, attempt: WorkbookAttempt, submission: FactSnapshot,
  access: Access, cutoff?: Tick) => readReleased(deps, tx, attempt, submission, access, cutoff);
export const readWorkbookDiagnosis = (tx: ReadTransaction, reference: string | SourceRefV1, access: Access) =>
  readDiagnosis(deps, tx, reference, access);
export const sourceUnavailable = (error: unknown) => studioDiagnosisSourceUnavailable(deps, error);

const unavailable = (error: unknown) => error instanceof FactNotFoundError || error instanceof FactReadDeniedError;

function trackingReader(tx: ReadTransaction, access: Access, use = purpose): ReadContext {
  const base = createCommandReadContext(tx, purpose);
  const authorized = createAuthorizedFactReader(tx, use, access.maySend);
  const fact: ReadContext['fact'] = async <Value>(id: FactId, options: FactReadOptions) => {
    const opened = await authorized.fact(id, options);
    if (!access.maySend(opened)) return undefined as never;
    access.track(opened, options?.mode ?? 'following');
    return opened as FactSnapshot<Value>;
  };
  return {
    ...base,
    fact,
  };
}

async function trackEvidence(reader: ReadContext, rows: readonly ConceptEvidenceRow[]) {
  const verified: ConceptEvidenceRow[] = [];
  for (const row of rows) {
    try {
      for (const ref of [row.submission, ...row.basisRefs]) {
        await reader.fact(factId(ref.id), { mode: 'pinned', rev: ref.rev as Revision });
      }
      verified.push(row);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  return verified;
}

async function imageCrop(tx: ReadTransaction, attempt: WorkbookAttempt, access: Access): Promise<WorkbookDiagnosisContext['imageCrop']> {
  if (attempt.paper.materialId === null) return { state: 'unavailable', reason: 'no-source-image' };
  const source = await resolveSource(tx, attempt.paper.materialId, { ...access, recipient: 'workspace' });
  const sourceReference = sourceRefV1(source?.sourceRef);
  const document = sourceReference?.textFact;
  if (!source || !document || document.type !== intakeFactType) return { state: 'unavailable', reason: 'no-source-image' };
  const reader = trackingReader(tx, access, access.purpose ?? purpose);
  const fact = await reader.fact(factId(document.id), { mode: 'pinned', rev: document.rev as Revision });
  const mediaType = intakeTextOf(fact).original.mediaType;
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') return { state: 'unavailable', reason: 'no-source-image' };
  return { state: 'available', sourceRef: source.sourceRef, mediaType,
    next: { tool: 'open_learning', args: { refs: [JSON.stringify(source.sourceRef)], part: 'image_crop' } } };
}

async function linkedConcepts(tx: ReadTransaction, access: Access, attempt: WorkbookAttempt) {
  const use = access.purpose ?? purpose;
  const reader = trackingReader(tx, access, use);
  const graph = await readAuthorizedKnowledgeGraph(tx, {
    learner: tx.learner, purpose: use, recipient: tx.learner, read: reader, isUnavailable: unavailable,
    reopenLegacyQuestion: async ref => {
      const fact = await reader.fact(factId(ref.id), { mode: 'pinned', rev: ref.rev as Revision });
      if (fact.accessEpoch !== ref.accessEpoch || fact.type !== 'activity.workspaceEntry') return false;
      await verifyWorkspaceEntryBasis(reader, fact.ref.id, workspaceEntry(fact.value).basis);
      return true;
    },
    openNotionSource: fact => checkStudioNotionFact(tx, fact, use, 'learner'),
  });
  const byQuestion = new Map<string, Map<Revision, QuestionConceptLink[]>>();
  for (const link of graph.questionConceptLinks) {
    const revisions = byQuestion.get(link.questionId) ?? new Map<Revision, QuestionConceptLink[]>();
    byQuestion.set(link.questionId, revisions);
    revisions.set(link.questionRev, [...revisions.get(link.questionRev) ?? [], link]);
  }
  const links: QuestionConceptLink[] = [];
  const concepts = new Map<FactId, string>();
  for (const { sourceQuestionRef } of attempt.paper.questions) {
    if (!sourceQuestionRef) continue;
    const revisions = byQuestion.get(sourceQuestionRef.id);
    if (!revisions) continue;
    const matched = revisions.get(sourceQuestionRef.rev) ?? [];
    if (matched.length) links.push(...matched);
    else for (const [revision, candidates] of revisions) {
      if (revision > sourceQuestionRef.rev && await widenedRevOr(reader, factId(sourceQuestionRef.id), sourceQuestionRef.rev, revision, unavailable)) {
        links.push(...candidates);
      }
    }
  }
  for (const link of links) {
    const node = graph.nodes.find(item => item.id === link.conceptId);
    if (node) concepts.set(link.conceptId, node.title);
  }
  return { reader, links, concepts, graph };
}

async function diagnosisContext(tx: ReadTransaction, input: {
  readonly attempt: WorkbookAttempt; readonly access: Access;
}): Promise<WorkbookDiagnosisContext> {
  const { attempt, access } = input;
  const noLinks = { state: 'unknown', reason: 'no-linked-concepts' } as const;
  try {
    const image = await imageCrop(tx, attempt, access);
    const linked = await linkedConcepts(tx, access, attempt);
    const conceptIds = [...linked.concepts.keys()].sort();
    if (!conceptIds.length) return { imageCrop: image, conceptHistory: noLinks, mastery: noLinks, retention: noLinks };
    const evidence = await readConceptAttemptEvidence(tx, linked.reader, linked.links, unavailable);
    const attempts = await trackEvidence(linked.reader, evidence.attempts);
    const historyByConcept = new Map<string, ConceptEvidenceRow[]>();
    for (const row of attempts) historyByConcept.set(row.conceptId, [...historyByConcept.get(row.conceptId) ?? [], row]);
    const recent = (rows: ConceptEvidenceRow[]) => [...rows].sort((left, right) => {
      const timeDiff = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
      if (timeDiff) return timeDiff;
      const tickDiff = BigInt(right.recordedTick) - BigInt(left.recordedTick);
      return tickDiff > 0n ? 1 : tickDiff < 0n ? -1 : 0;
    }).slice(0, 3);
    const conceptHistory = attempts.length ? { state: 'observed' as const, concepts: conceptIds.filter(id => historyByConcept.has(id)).map(id => ({
      conceptId: id, title: linked.concepts.get(id), recentAttempts: recent(historyByConcept.get(id)!).map(row => ({
        submissionId: row.submission.id, rev: row.submission.rev, occurredAt: row.occurredAt, outcome: row.outcome, exposure: row.exposure,
      })),
    })) } : { state: 'unknown' as const, reason: 'no-attempt-history', conceptIds };

    const retentionRows = await readAuthorizedRetention(tx, { callerPurpose: access.purpose ?? purpose, maySend: access.maySend }, async fact => {
      if (!access.maySend(fact)) return false;
      access.track(fact, 'following');
      return true;
    });
    const mapped = mapConceptForecastInputs(retentionRows.forecasts.flatMap(({ view, forecast, facts }) =>
      view.kind === 'forecast' && forecast.estimate.kind === 'probabilistic' ? [{
        effectiveTick: view.effectiveTick, observedThrough: forecast.input.observedThrough, probability: forecast.estimate.probability,
        ...(forecast.estimate.crossingAt ? { crossingAt: forecast.estimate.crossingAt } : {}),
        ...(forecast.estimate.bucket.kcId ? { kcId: forecast.estimate.bucket.kcId } : {}),
        paperId: forecast.input.target.paper.id, itemId: forecast.input.target.itemId, facts,
      }] : []), linked.graph.questionConceptLinks);
    const signals = extractConceptForecastSignals(mapped.rows, new Set(conceptIds), mapped.conceptsByQuestion)
      .filter(signal => Number.isFinite(signal.probability) && signal.probability >= 0 && signal.probability <= 1 &&
        (signal.crossingAt === undefined || Number.isFinite(Date.parse(signal.crossingAt))) && linked.concepts.has(signal.conceptId));
    const latest = new Map<FactId, typeof signals[number]>();
    for (const signal of signals) {
      const existing = latest.get(signal.conceptId);
      if (!existing || BigInt(signal.effectiveTick) > BigInt(existing.effectiveTick)) latest.set(signal.conceptId, signal);
    }
    const retentionConcepts = [...latest.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, signal]) => ({
      conceptId: id, title: linked.concepts.get(id), probability: signal.probability,
      ...(signal.crossingAt ? { crossingAt: signal.crossingAt } : {}), observedThrough: signal.observedThrough,
    }));
    const retention = retentionConcepts.length ? { state: 'observed' as const, concepts: retentionConcepts }
      : { state: 'unknown' as const, reason: 'no-retention-forecast', conceptIds };

    const masteryValues = projectBatchConceptMastery({ asOf: new Date().toISOString(), conceptIds, attempts, forecasts: signals,
      incompleteConceptIds: evidence.incompleteConceptIds });
    for (const mastery of masteryValues.values()) for (const ref of mastery.basisRefs) {
      await linked.reader.fact(factId(ref.id), { mode: 'pinned', rev: ref.rev as Revision });
    }
    const masteryConcepts = conceptIds.map(id => {
      const mastery = masteryValues.get(factId(id))!;
      return { conceptId: id, title: linked.concepts.get(id), status: mastery.status,
        retrievability: mastery.retrievability, independentCount: mastery.independentCount };
    });
    const mastery = masteryConcepts.some(({ status }) => status !== 'unknown') ? { state: 'observed' as const, concepts: masteryConcepts }
      : { state: 'unknown' as const, reason: 'no-independent-evidence', conceptIds };
    return { imageCrop: image, conceptHistory, mastery, retention };
  } catch (error) {
    if (unavailable(error)) return { imageCrop: { state: 'unavailable', reason: 'no-source-image' }, conceptHistory: noLinks, mastery: noLinks, retention: noLinks };
    throw error;
  }
}
