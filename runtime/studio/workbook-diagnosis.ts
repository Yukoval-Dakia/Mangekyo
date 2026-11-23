import { revisionsOnlyChangeGrants } from '../../kernel/src/commands/fact-collection.ts';
import { factId, type FactId, type FactSnapshot, type ReadContext, type ReadTransaction, type Revision, type Tick } from '../../kernel/src/index.ts';
import { mapConceptForecastInputs, readConceptAttemptEvidence, type ConceptEvidenceRow } from '../../modules/activity/concept-evidence.ts';
import { sourceRefV1, type SourceRefV1 } from '../../modules/activity/source-values.ts';
import { openWorkbookDiagnosisSource as openSource, openWorkbookQuestionSources as openQuestions, readReleasedAssessment as readReleased, readWorkbookDiagnosis as readDiagnosis, studioDiagnosisSourceUnavailable, type StudioDiagnosisDeps } from '../../modules/activity/studio-diagnosis-host.ts';
import type { WorkbookAttempt } from '../../modules/activity/workbook-values.ts';
import type { WorkbookDiagnosisContext } from '../../modules/activity/workbook-views.ts';
import { intakeTextOf } from '../../modules/activity/workspace-source-projection.ts';
import { verifyWorkspaceEntryBasis, workspaceEntry } from '../../modules/activity/workspace-values.ts';
import { intakeFactType } from '../../modules/capture/intake-values.ts';
import { readAuthorizedKnowledgeGraph, type QuestionConceptLink } from '../../modules/content/knowledge-graph-overview.ts';
import { filterValidDiagnosisSignals, indexLinksByQuestionRev, projectDiagnosisConceptHistory, projectDiagnosisMastery, projectDiagnosisRetention } from '../../modules/learner/diagnosis-slice.ts';
import { extractConceptForecastSignals, projectBatchConceptMastery } from '../../modules/learner/knowledge-mastery.ts';
import { widenedRevOr } from '../../modules/learner/widened-rev.ts';
import { createAuthorizedFactReader, createCommandReadContext, createTrackingReadContext, factReadChecks, isFactUnavailable } from './fact-read-helpers.ts';
import { purpose } from './identity.ts';
import { readAuthorizedRetention } from './learner-radar.ts';
import { checkStudioNotionFact } from './notion.ts';
import { resolveSource } from './source-read.ts';
import { readSavedWorkbookAssessment } from './workbook-assessment.ts';
import { readWorkspaceAttemptAssessments } from './workspace-read.ts';

let cachedDeps: StudioDiagnosisDeps | undefined;
function getDeps(): StudioDiagnosisDeps {
  return cachedDeps ??= {
    purpose, ...factReadChecks,
    revisionsOnlyChangeGrants: revisionsOnlyChangeGrants as StudioDiagnosisDeps['revisionsOnlyChangeGrants'],
    createAuthorizedFactReader: createAuthorizedFactReader as StudioDiagnosisDeps['createAuthorizedFactReader'],
    createCommandReadContext: createCommandReadContext as StudioDiagnosisDeps['createCommandReadContext'],
    resolveSource: resolveSource as StudioDiagnosisDeps['resolveSource'],
    readSavedWorkbookAssessment: readSavedWorkbookAssessment as StudioDiagnosisDeps['readSavedWorkbookAssessment'],
    readWorkspaceAttemptAssessments: readWorkspaceAttemptAssessments as StudioDiagnosisDeps['readWorkspaceAttemptAssessments'],
    diagnosisContext: (tx, input) => diagnosisContext(tx, input),
  };
}

type Access = Parameters<typeof openSource>[3];
export type { Access as WorkbookDiagnosisAccess };
export function openWorkbookDiagnosisSource(tx: ReadTransaction, reference: string | SourceRefV1, access: Access) { return openSource(getDeps(), tx, reference, access); }
export function openWorkbookQuestionSources(tx: ReadTransaction, submission: FactSnapshot, access: Access, itemId?: string) { return openQuestions(getDeps(), tx, submission, access, itemId); }
export function readReleasedAssessment(tx: ReadTransaction, attempt: WorkbookAttempt, submission: FactSnapshot, access: Access, cutoff?: Tick) { return readReleased(getDeps(), tx, attempt, submission, access, cutoff); }
export function readWorkbookDiagnosis(tx: ReadTransaction, reference: string | SourceRefV1, access: Access) { return readDiagnosis(getDeps(), tx, reference, access); }
export function sourceUnavailable(error: unknown) { return studioDiagnosisSourceUnavailable(getDeps(), error); }

function trackingReader(tx: ReadTransaction, access: Access, use = purpose): ReadContext {
  const base = createCommandReadContext(tx, use);
  const tracked = createTrackingReadContext(tx, use, access.maySend, (opened, mode) => access.track(opened, mode ?? 'following'));
  return { ...base, fact: tracked.fact as ReadContext['fact'] };
}

async function trackEvidence(reader: ReadContext, rows: readonly ConceptEvidenceRow[]) {
  const verified: ConceptEvidenceRow[] = [];
  for (const row of rows) {
    try {
      for (const ref of [row.submission, ...row.basisRefs]) await reader.fact(factId(ref.id), { mode: 'pinned', rev: ref.rev as Revision });
      verified.push(row);
    } catch (error) { if (!isFactUnavailable(error)) throw error; }
  }
  return verified;
}

async function imageCrop(tx: ReadTransaction, attempt: WorkbookAttempt, access: Access): Promise<WorkbookDiagnosisContext['imageCrop']> {
  if (attempt.paper.materialId === null) return { state: 'unavailable', reason: 'no-source-image' };
  const source = await resolveSource(tx, attempt.paper.materialId, { ...access, recipient: 'workspace' });
  const document = sourceRefV1(source?.sourceRef)?.textFact;
  if (!source || !document || document.type !== intakeFactType) return { state: 'unavailable', reason: 'no-source-image' };
  const fact = await trackingReader(tx, access, access.purpose ?? purpose).fact(factId(document.id), { mode: 'pinned', rev: document.rev as Revision });
  const mediaType = intakeTextOf(fact).original.mediaType;
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') return { state: 'unavailable', reason: 'no-source-image' };
  return { state: 'available', sourceRef: source.sourceRef, mediaType, next: { tool: 'open_learning', args: { refs: [JSON.stringify(source.sourceRef)], part: 'image_crop' } } };
}

async function linkedConcepts(tx: ReadTransaction, access: Access, attempt: WorkbookAttempt) {
  const use = access.purpose ?? purpose, reader = trackingReader(tx, access, use);
  const graph = await readAuthorizedKnowledgeGraph(tx, {
    learner: tx.learner, purpose: use, recipient: tx.learner, read: reader, isUnavailable: isFactUnavailable,
    reopenLegacyQuestion: async ref => {
      const fact = await reader.fact(factId(ref.id), { mode: 'pinned', rev: ref.rev as Revision });
      if (fact.accessEpoch !== ref.accessEpoch || fact.type !== 'activity.workspaceEntry') return false;
      await verifyWorkspaceEntryBasis(reader, fact.ref.id, workspaceEntry(fact.value).basis);
      return true;
    },
    openNotionSource: fact => checkStudioNotionFact(tx, fact, use, 'learner'),
  });
  const byQuestion = indexLinksByQuestionRev(graph.questionConceptLinks), links: QuestionConceptLink[] = [], concepts = new Map<FactId, string>();
  for (const { sourceQuestionRef } of attempt.paper.questions) {
    const revisions = sourceQuestionRef && byQuestion.get(sourceQuestionRef.id);
    if (!sourceQuestionRef || !revisions) continue;
    const matched = revisions.get(sourceQuestionRef.rev) ?? [];
    if (matched.length) links.push(...matched);
    else for (const [revision, candidates] of revisions)
      if (revision > sourceQuestionRef.rev && await widenedRevOr(reader, factId(sourceQuestionRef.id), sourceQuestionRef.rev, revision, isFactUnavailable)) links.push(...candidates);
  }
  for (const link of links) { const node = graph.nodes.find(item => item.id === link.conceptId); if (node) concepts.set(link.conceptId, node.title); }
  return { reader, links, concepts, graph };
}

async function diagnosisContext(tx: ReadTransaction, { attempt, access }: { readonly attempt: WorkbookAttempt; readonly access: Access }): Promise<WorkbookDiagnosisContext> {
  const noImage = { state: 'unavailable', reason: 'no-source-image' } as const, noLinks = { state: 'unknown', reason: 'no-linked-concepts' } as const;
  let image: WorkbookDiagnosisContext['imageCrop'] = noImage;
  try { image = await imageCrop(tx, attempt, access); } catch (error) { if (!isFactUnavailable(error)) throw error; }
  try {
    const linked = await linkedConcepts(tx, access, attempt), conceptIds = [...linked.concepts.keys()].sort();
    if (!conceptIds.length) return { imageCrop: image, conceptHistory: noLinks, mastery: noLinks, retention: noLinks };
    const evidence = await readConceptAttemptEvidence(tx, linked.reader, linked.links, isFactUnavailable);
    const attempts = await trackEvidence(linked.reader, evidence.attempts);
    const conceptHistory = projectDiagnosisConceptHistory(conceptIds, linked.concepts, attempts);
    const retentionRows = await readAuthorizedRetention(tx, { callerPurpose: access.purpose ?? purpose, maySend: access.maySend },
      async fact => { if (!access.maySend(fact)) return false; access.track(fact, 'following'); return true; });
    const mapped = mapConceptForecastInputs(retentionRows.forecasts.flatMap(({ view, forecast, facts }) =>
      view.kind === 'forecast' && forecast.estimate.kind === 'probabilistic' ? [{
        effectiveTick: view.effectiveTick, observedThrough: forecast.input.observedThrough, probability: forecast.estimate.probability,
        ...(forecast.estimate.crossingAt ? { crossingAt: forecast.estimate.crossingAt } : {}),
        ...(forecast.estimate.bucket.kcId ? { kcId: forecast.estimate.bucket.kcId } : {}),
        paperId: forecast.input.target.paper.id, itemId: forecast.input.target.itemId, facts,
      }] : []), linked.graph.questionConceptLinks);
    const signals = filterValidDiagnosisSignals(extractConceptForecastSignals(mapped.rows, new Set(conceptIds), mapped.conceptsByQuestion), linked.concepts);
    const retention = projectDiagnosisRetention(conceptIds, linked.concepts, signals);
    const masteryValues = projectBatchConceptMastery({ asOf: new Date().toISOString(), conceptIds, attempts, forecasts: signals, incompleteConceptIds: evidence.incompleteConceptIds });
    const masteryConcepts = [];
    for (const id of conceptIds) {
      const value = masteryValues.get(factId(id))!;
      let verified = true;
      try { for (const ref of value.basisRefs) await linked.reader.fact(factId(ref.id), { mode: 'pinned', rev: ref.rev as Revision }); }
      catch (error) { if (!isFactUnavailable(error)) throw error; verified = false; }
      masteryConcepts.push(verified
        ? { conceptId: id, title: linked.concepts.get(id), status: value.status, retrievability: value.retrievability, independentCount: value.independentCount }
        : { conceptId: id, title: linked.concepts.get(id), status: 'unknown' as const, retrievability: null, independentCount: 0 });
    }
    return { imageCrop: image, conceptHistory, mastery: projectDiagnosisMastery(conceptIds, masteryConcepts), retention };
  } catch (error) {
    if (isFactUnavailable(error)) return { imageCrop: image, conceptHistory: noLinks, mastery: noLinks, retention: noLinks };
    throw error;
  }
}
