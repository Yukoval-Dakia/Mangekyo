import { projectArtifactMountTrace } from '../../executors/teaching/artifact-trace.ts';
import { manifestFactInputs } from '../../kernel/src/derivations/revalidate.ts';
import {
  createCommandReadContext, factId, isFactUnavailable, parseManifest, readable, revalidateManifest, snapshotFactReaders,
  type BusWitness, type Db, type FactSnapshot, type LearnerId, type ReadTransaction, type Revision, type Tick,
} from '../../kernel/src/index.ts';
import { effectBudgetUsage } from '../../kernel/src/work/effects.ts';
import { projectRetentionHandoff, readAiActivity } from '../../modules/activity/ai-activity.ts';
import { mapConceptForecastInputs, readConceptAttemptEvidence } from '../../modules/activity/concept-evidence.ts';
import { projectGraphMastery } from '../../modules/activity/graph-mastery-evidence.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { gatherWeaknessOverview } from '../../modules/activity/weakness-overview.ts';
import { readActiveNotionSelectionSummary } from '../../modules/capture/notion-source.ts';
import { authorizeResearchTodoSpec, readActiveMisconceptionConceptIds, readMemoryOverview } from '../../modules/companion/memory-overview.ts';
import { researchPurpose, researchSettings } from '../../modules/companion/research.ts';
import { composeKnowledgeGraphResponse, openPendingTextbookProposal, readAuthorizedKnowledgeGraph } from '../../modules/content/knowledge-graph-overview.ts';
import { extractProbabilisticForecastInputs } from '../../modules/learner/diagnosis-slice.ts';
import { extractConceptForecastSignals, projectBatchConceptMastery, projectCalibrationSummary, type CalibrationInputRecord } from '../../modules/learner/knowledge-mastery.ts';
import { openObjectiveCitations } from './belief-evidence.ts';
import { openHypothesisObject } from './hypothesis-object.ts';
import { purpose as teachingPurpose, slotType, stableId, studioLearner } from './identity.ts';
import { readCurrentQuestionVerification } from './iqdb-verification.ts';
import { createKnowledgeGraphAccess } from './knowledge-graph.ts';
import { readAuthorizedRetention } from './learner-radar.ts';
import { claimUndoToken } from './memory-claims.ts';
import { createNotionReader, hasRemoteNotion, notionReadScope, savedNotionWitnesses, verifyNotionFact, type CheckNotionRead } from './notion.ts';
import { readWorksheetById, researchReader } from './research-sources.ts';
import { openUnderstandingCitations } from './research-understanding.ts';
import { RequestError } from './sessions.ts';
import type { TextbookPulseHost } from './textbook-pulse.ts';
import { readWorkbookAssessment } from './workbook-assessment.ts';
const gatedReader = (tx: ReadTransaction, readers: ReturnType<typeof snapshotFactReaders>, use: string, check: CheckNotionRead) =>
  createNotionReader(tx, { purpose: use, check, remoteOnly: true, base: readers(use, () => true) });
export function openTransparency(db: Db, pulseHost?: TextbookPulseHost, learner: LearnerId = studioLearner) {
  const settingsId = factId(stableId('research-settings', learner));
  const readScope = <T>(run: (tx: ReadTransaction, check: CheckNotionRead) => Promise<T>) => notionReadScope(db, learner, { readOnly: true }).read(run);
  const notionCheck = (tx: ReadTransaction, use: string, check: CheckNotionRead) => async (fact: FactSnapshot) =>
    Boolean(await readable(() => verifyNotionFact(tx, fact, use, check, true)));
  const hypothesisCheck = (check: CheckNotionRead): CheckNotionRead => async fact => { if (hasRemoteNotion()) await check(fact); };
  const hypothesisReaders = (tx: ReadTransaction, check: CheckNotionRead) => ({
    openHypothesisObject: (data: Parameters<typeof openHypothesisObject>[1]) => openHypothesisObject(tx, data, () => true, hypothesisCheck(check)),
    openObjectiveCitations: (refs: Parameters<typeof openObjectiveCitations>[1]) => openObjectiveCitations(tx, refs, teachingPurpose, () => true),
  });
  const graphAccess = (tx: ReadTransaction, read: ReturnType<typeof gatedReader>, use: string, check: CheckNotionRead) =>
    createKnowledgeGraphAccess(tx, read, use, check, read.preloadFollowing);
  const readRetention = (tx: ReadTransaction, check: CheckNotionRead) =>
    readAuthorizedRetention(tx, { callerPurpose: teachingPurpose, maySend: () => true }, notionCheck(tx, teachingPurpose, check));
  async function readMasterySnapshot(tx: ReadTransaction, use: string, check: CheckNotionRead, asOf: string) {
    const readers = snapshotFactReaders(tx), read = gatedReader(tx, readers, use, check), readCtx = { ...createCommandReadContext(tx, use), fact: read.fact };
    const graph = await readAuthorizedKnowledgeGraph(tx, graphAccess(tx, read, use, check));
    const misconceptions = await readActiveMisconceptionConceptIds(tx, { readStorage: read, isUnavailable: isFactUnavailable, ...hypothesisReaders(tx, check) });
    const { attempts, incompleteConceptIds } = await readConceptAttemptEvidence(tx, readCtx, graph.questionConceptLinks, isFactUnavailable);
    const retention = await readRetention(tx, check), conceptIds = graph.nodes.map(node => node.id);
    let mastery;
    if (pulseHost) {
      const reopen = async (refs: readonly BusWitness[]) => {
        const opened: BusWitness[] = [];
        for (const ref of refs) {
          try {
            const fact = await read.reopen(ref);
            if (fact.ref.id === ref.id && fact.ref.rev === ref.rev && fact.accessEpoch === ref.accessEpoch &&
                (!ref.type || fact.type === ref.type)) opened.push(ref);
          } catch {}
        }
        return opened;
      };
      const clock = ((await tx.query<{ clock: string | null }>('SELECT max(changed_tick)::text AS clock FROM facts WHERE learner_id=$1', [tx.learner])).rows[0]?.clock ?? '0') as Tick;
      mastery = (await projectGraphMastery({ tx, links: graph.questionConceptLinks, read, python: pulseHost.python, reopen, isUnavailable: isFactUnavailable,
        scope: { learner: tx.learner, purpose: use, recipientId: tx.learner, asOf, clockWatermark: clock }, concepts: conceptIds, activeMisconceptionConceptIds: misconceptions })).mastery;
    } else {
      const { rows, conceptsByQuestion } = mapConceptForecastInputs(extractProbabilisticForecastInputs(retention.forecasts as never) as never, graph.questionConceptLinks);
      mastery = projectBatchConceptMastery({ asOf, conceptIds, attempts, forecasts: extractConceptForecastSignals(rows, new Set(conceptIds), conceptsByQuestion), incompleteConceptIds, activeMisconceptionConceptIds: misconceptions });
    }
    return { readers, read, readCtx, graph, attempts, retention, mastery };
  }
  return {
    knowledgeGraph(query?: URLSearchParams) {
      const requested = query?.get('purpose');
      if (requested && requested !== 'storage' && requested !== teachingPurpose) throw new RequestError(400, '图谱读取用途无效。');
      return readScope(async (tx, check) => {
        const asOf = new Date().toISOString(), { graph, mastery } = await readMasterySnapshot(tx, requested ?? 'storage', check, asOf);
        return composeKnowledgeGraphResponse(asOf, graph, mastery);
      });
    },
    memoryOverview: () => readScope(async (tx, check) => {
      const asOf = new Date().toISOString(), { readers, read: readStorage, readCtx: storageCtx, graph, attempts, retention, mastery } = await readMasterySnapshot(tx, 'storage', check, asOf);
      const weaknessSummary = await gatherWeaknessOverview(tx, {
        asOf, read: storageCtx, attemptEvidence: attempts, nodes: graph.nodes, links: graph.questionConceptLinks, mastery, isUnavailable: isFactUnavailable,
        formalFor: async (paper, ref) => { const view = await readWorkbookAssessment(tx, paper.assessmentRelease!, ref, { purpose: 'storage' }); return 'result' in view ? view.result : undefined; },
      });
      const overview = await readMemoryOverview(tx, asOf, {
        readStorage, readTeaching: gatedReader(tx, readers, teachingPurpose, check), isUnavailable: isFactUnavailable, undoTokenFor: claimUndoToken,
        ...hypothesisReaders(tx, check), openUnderstandingCitations: refs => openUnderstandingCitations(tx, refs, 'storage'),
        checkObjectScopeFact: notionCheck(tx, 'storage', check),
        isRevocableCompanionTurn: fact => fact.type === 'activity.studyTurn' && !fact.purpose.includes('all') && studyTurn(fact.value).caseId === 'companion',
        readCalibration: async () => projectCalibrationSummary(retention.reconciliations.flatMap(({ view }) => view.kind === 'reconciliation' ? [view as CalibrationInputRecord] : [])),
      });
      return { ...overview, weaknessSummary };
    }),
    aiActivity: () => readScope(async (tx, check) => {
      const asOf = new Date().toISOString(), readers = snapshotFactReaders(tx), readResearch = researchReader(tx);
      const readStorage = gatedReader(tx, readers, 'storage', check), readTeaching = gatedReader(tx, readers, teachingPurpose, check);
      return readAiActivity(tx, asOf, {
        feedbackSlotType: slotType, readStorage, readTeaching, isUnavailable: isFactUnavailable,
        readBankQuestion: { ...createCommandReadContext(tx, teachingPurpose), fact: readTeaching.fact, slot: readCurrentQuestionVerification(tx) },
        authorizeTodo: rawSpec => authorizeResearchTodoSpec(rawSpec, { settingsId, readResearch, isUnavailable: isFactUnavailable, verifyFact: notionCheck(tx, researchPurpose, check) }),
        projectTrace: projectArtifactMountTrace,
        async validateTurnManifest(rawManifest) {
          const manifest = await readable(async () => parseManifest(rawManifest)).catch(() => undefined);
          if (!manifest || (await revalidateManifest(tx, manifest, teachingPurpose)).kind !== 'valid') return undefined;
          for (const w of await savedNotionWitnesses(tx, manifest.inputs)) {
            const f = await readable(() => readTeaching.fact(factId(w.id), { mode: 'pinned', rev: w.rev as Revision }));
            if (!f || f.accessEpoch !== w.epoch) return undefined;
          }
          return (await manifestFactInputs(tx, manifest.inputs)).map(input => input.id);
        },
        async openResearchWorksheet(id) {
          const opened = await readWorksheetById(tx, id);
          return opened ? { title: opened.worksheet.title, summary: opened.worksheet.steps[0] ?? '后台教研复习单已就绪', basisCount: 1,
            href: opened.source ? `/api/papers/${opened.source.paperId}/attempts/${opened.worksheet.source.attemptId}/research` : null } : undefined;
        },
        readRetentionHandoffs: async () => { const { forecasts, reconciliations } = await readRetention(tx, check); return [...forecasts, ...reconciliations].map(({ view }) => projectRetentionHandoff(view)); },
        openNotionSelection: selectionId => readActiveNotionSelectionSummary(tx, createCommandReadContext(tx, 'storage'), id => readable(() => readStorage.fact(id, { mode: 'following' })), selectionId),
        readBudgetUsage: () => effectBudgetUsage(tx),
        readBudgetLimit: async () => (await readable(() => readResearch.fact(settingsId, { mode: 'following' }).then(f => researchSettings(f.value))))?.scoutConsent?.limitMicros ?? null,
        readGraphProposals: async () => (await readAuthorizedKnowledgeGraph(tx, graphAccess(tx, readStorage, 'storage', check))).pendingProposals,
        openTextbookProposal: (_proposalId, input) => openPendingTextbookProposal(readStorage, input, isFactUnavailable),
      });
    }),
  };
}
