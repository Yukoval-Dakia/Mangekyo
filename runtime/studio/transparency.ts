import { projectArtifactMountTrace } from '../../executors/teaching/artifact-trace.ts';
import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { createCommandReadContext, isFactUnavailable, snapshotFactReaders } from './fact-read-helpers.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type LearnerId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, ReadContext } from '../../kernel/src/declarations/types.ts';
import type { BusWitness } from '../../kernel/src/pipeline-contracts.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { manifestFactInputs, revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { effectBudgetUsage } from '../../kernel/src/work/effects.ts';
import { projectRetentionHandoff, readAiActivity } from '../../modules/activity/ai-activity.ts';
import { mapConceptForecastInputs, readConceptAttemptEvidence } from '../../modules/activity/concept-evidence.ts';
import { projectGraphMastery } from '../../modules/activity/graph-mastery-evidence.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { gatherWeaknessOverview } from '../../modules/activity/weakness-overview.ts';
import { verifyWorkspaceEntryBasis, workspaceEntry } from '../../modules/activity/workspace-values.ts';
import { readActiveNotionSelectionSummary } from '../../modules/capture/notion-source.ts';
import { captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { authorizeResearchTodoSpec, readActiveMisconceptionConceptIds, readMemoryOverview } from '../../modules/companion/memory-overview.ts';
import { researchPurpose, researchSettings } from '../../modules/companion/research.ts';
import { composeKnowledgeGraphResponse, openPendingTextbookProposal, readAuthorizedKnowledgeGraph } from '../../modules/content/knowledge-graph-overview.ts';
import { extractConceptForecastSignals, projectBatchConceptMastery, projectCalibrationSummary, type CalibrationInputRecord } from '../../modules/learner/knowledge-mastery.ts';
import { openObjectiveCitations } from './belief-evidence.ts';
import { openHypothesisObject } from './hypothesis-object.ts';
import { purpose as teachingPurpose, slotType, stableId, studioLearner } from './identity.ts';
import { readCurrentQuestionVerification } from './iqdb-verification.ts';
import { readAuthorizedRetention } from './learner-radar.ts';
import { claimUndoToken } from './memory-claims.ts';
import { checkStudioNotionFact, notionReadScope, savedNotionWitnesses, type CheckNotionRead } from './notion.ts';
import { readWorkbookAssessment } from './workbook-assessment.ts';
import { readWorksheetById, researchReader } from './research-sources.ts';
import { openUnderstandingCitations } from './research-understanding.ts';
import { RequestError } from './sessions.ts';
import type { TextbookPulseHost } from './textbook-pulse.ts';

const hasRemoteNotion = () => Boolean(process.env.MANGEKYO_NOTION_TEST_ORIGIN || process.env.MANGEKYO_NOTION_TOKEN);

async function verifyNotion(tx: ReadTransaction, fact: FactSnapshot, use: string, check: CheckNotionRead) {
  if (fact.type !== captureSourceType || sourceEnvelope(fact.value).kind !== 'notion') return fact;
  const authorized = await checkStudioNotionFact(tx, fact, use, 'learner');
  if (authorized && hasRemoteNotion()) await check(authorized);
  return authorized;
}

function gatedReader(tx: ReadTransaction, readers: ReturnType<typeof snapshotFactReaders>, use: string, check: CheckNotionRead) {
  const base = readers(use, () => true);
  const fact: ReadContext['fact'] = async (id, options) => {
    const opened = await base.fact(id, options);
    await verifyNotion(tx, opened, use, check);
    return opened as never;
  };
  return { ...base, fact };
}

export function openTransparency(db: Db, pulseHost?: TextbookPulseHost, learner: LearnerId = studioLearner) {
  const settingsId = factId(stableId('research-settings', learner));
  const readScope = <T>(run: (tx: ReadTransaction, check: CheckNotionRead) => Promise<T>) =>
    notionReadScope(db, learner, { readOnly: true }).read(run);
  const notionCheck = (tx: ReadTransaction, use: string, check: CheckNotionRead) => async (fact: FactSnapshot) =>
    Boolean(await readable(() => verifyNotion(tx, fact, use, check)));
  const graphAccess = (tx: ReadTransaction, read: ReturnType<typeof gatedReader>, use: string, check: CheckNotionRead) => {
    const verifyLegacyBasis = async (id: FactId, fact: FactSnapshot) => {
      try { await verifyWorkspaceEntryBasis(read, id, workspaceEntry(fact.value).basis); return true; }
      catch { return false; }
    };
    return {
      learner: tx.learner, purpose: use, recipient: tx.learner, read, isUnavailable: isFactUnavailable,
      preloadFollowing: read.preloadFollowing, verifyLegacyBasis,
      reopenLegacyQuestion: async (ref: { id: FactId; rev: Revision; accessEpoch: string }) => {
        const fact = await read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
        return fact.accessEpoch === ref.accessEpoch && await verifyLegacyBasis(fact.ref.id, fact);
      },
      openNotionSource: (fact: FactSnapshot) => readable(() => verifyNotion(tx, fact, use, check)),
    };
  };
  const readRetention = (tx: ReadTransaction, check: CheckNotionRead) =>
    readAuthorizedRetention(tx, { callerPurpose: teachingPurpose, maySend: () => true }, notionCheck(tx, teachingPurpose, check));
  const hypothesisCheck = (check: CheckNotionRead): CheckNotionRead => async fact => { if (hasRemoteNotion()) await check(fact); };
  const conceptMastery = async (tx: ReadTransaction, read: ReturnType<typeof gatedReader>, use: string, check: CheckNotionRead, input: {
    asOf: string; graph: Awaited<ReturnType<typeof readAuthorizedKnowledgeGraph>>;
    misconceptions: Awaited<ReturnType<typeof readActiveMisconceptionConceptIds>>;
    retention: Awaited<ReturnType<typeof readRetention>>;
    attempts: Awaited<ReturnType<typeof readConceptAttemptEvidence>>['attempts'];
    incompleteConceptIds: Awaited<ReturnType<typeof readConceptAttemptEvidence>>['incompleteConceptIds'];
  }) => {
    const conceptIds = input.graph.nodes.map(node => node.id);
    if (pulseHost) {
      const reopen = async (refs: readonly BusWitness[]) => {
        const opened: BusWitness[] = [];
        for (const ref of refs) {
          try {
            const fact = await read.reopen(ref);
            if (fact.ref.id === ref.id && fact.ref.rev === ref.rev && fact.accessEpoch === ref.accessEpoch &&
                (!ref.type || fact.type === ref.type) && await verifyNotion(tx, fact, use, check)) opened.push(ref);
          } catch {}
        }
        return opened;
      };
      const clock = ((await tx.query<{clock:string | null}>(
        'SELECT max(changed_tick)::text AS clock FROM facts WHERE learner_id=$1', [tx.learner],
      )).rows[0]?.clock ?? '0') as Tick;
      return (await projectGraphMastery({tx, links: input.graph.questionConceptLinks, read, python: pulseHost.python,
        reopen, isUnavailable: isFactUnavailable, scope: {learner: tx.learner, purpose: use, recipientId: tx.learner, asOf: input.asOf,
        clockWatermark: clock}, concepts: conceptIds, activeMisconceptionConceptIds: input.misconceptions})).mastery;
    }
    const { rows, conceptsByQuestion } = mapConceptForecastInputs(
      input.retention.forecasts.flatMap(({ view, forecast, facts }) => view.kind === 'forecast' && forecast.estimate.kind === 'probabilistic' ? [{
        effectiveTick: view.effectiveTick, observedThrough: forecast.input.observedThrough, probability: forecast.estimate.probability,
        ...(forecast.estimate.crossingAt ? { crossingAt: forecast.estimate.crossingAt } : {}),
        ...(forecast.estimate.bucket.kcId ? { kcId: forecast.estimate.bucket.kcId } : {}),
        paperId: forecast.input.target.paper.id, itemId: forecast.input.target.itemId, facts,
      }] : []), input.graph.questionConceptLinks);
    return projectBatchConceptMastery({ asOf: input.asOf, conceptIds, attempts: input.attempts,
      forecasts: extractConceptForecastSignals(rows, new Set(conceptIds), conceptsByQuestion),
      incompleteConceptIds: input.incompleteConceptIds, activeMisconceptionConceptIds: input.misconceptions });
  };

  return {
    knowledgeGraph(query?: URLSearchParams) {
      const requested = query?.get('purpose');
      if (requested && requested !== 'storage' && requested !== teachingPurpose) throw new RequestError(400, '图谱读取用途无效。');
      const use = requested ?? 'storage';
      return readScope(async (tx, check) => {
        const asOf = new Date().toISOString();
        const readers = snapshotFactReaders(tx);
        const read = gatedReader(tx, readers, use, check);
        const storageRead = { ...createCommandReadContext(tx, use), fact: read.fact };
        const graph = await readAuthorizedKnowledgeGraph(tx, graphAccess(tx, read, use, check));
        const misconceptions = await readActiveMisconceptionConceptIds(tx, {
          readStorage: read, isUnavailable: isFactUnavailable,
          openHypothesisObject: data => openHypothesisObject(tx, data, () => true, hypothesisCheck(check)),
          openObjectiveCitations: refs => openObjectiveCitations(tx, refs, teachingPurpose, () => true),
        });
        const { attempts, incompleteConceptIds } = await readConceptAttemptEvidence(tx, storageRead, graph.questionConceptLinks, isFactUnavailable);
        const retention = await readRetention(tx, check);
        return composeKnowledgeGraphResponse(asOf, graph, await conceptMastery(tx, read, use, check, {
          asOf, graph, misconceptions, retention, attempts, incompleteConceptIds }));
      });
    },

    memoryOverview() {
      return readScope(async (tx, check) => {
        const asOf = new Date().toISOString();
        const readers = snapshotFactReaders(tx);
        const readStorage = gatedReader(tx, readers, 'storage', check);
        const readTeaching = gatedReader(tx, readers, teachingPurpose, check);
        const graph = await readAuthorizedKnowledgeGraph(tx, graphAccess(tx, readStorage, 'storage', check));
        const storageCtx = { ...createCommandReadContext(tx, 'storage'), fact: readStorage.fact };
        const { attempts, incompleteConceptIds } = await readConceptAttemptEvidence(tx, storageCtx, graph.questionConceptLinks, isFactUnavailable);
        const { forecasts, reconciliations } = await readRetention(tx, check);
        const misconceptions = await readActiveMisconceptionConceptIds(tx, {
          readStorage, isUnavailable: isFactUnavailable,
          openHypothesisObject: data => openHypothesisObject(tx, data, () => true, hypothesisCheck(check)),
          openObjectiveCitations: refs => openObjectiveCitations(tx, refs, teachingPurpose, () => true),
        });
        const mastery = await conceptMastery(tx, readStorage, 'storage', check, {
          asOf, graph, misconceptions, retention: { forecasts, reconciliations }, attempts, incompleteConceptIds });
        const weaknessSummary = await gatherWeaknessOverview(tx, {
          asOf, read: storageCtx, attemptEvidence: attempts, nodes: graph.nodes, links: graph.questionConceptLinks,
          mastery, isUnavailable: isFactUnavailable,
          formalFor: async (paper, ref) => {
            const view = await readWorkbookAssessment(tx, paper.assessmentRelease!, ref, { purpose: 'storage' });
            return 'result' in view ? view.result : undefined;
          },
        });
        const overview = await readMemoryOverview(tx, asOf, {
          readStorage, readTeaching, isUnavailable: isFactUnavailable, undoTokenFor: claimUndoToken,
          openHypothesisObject: data => openHypothesisObject(tx, data, () => true, hypothesisCheck(check)),
          openObjectiveCitations: refs => openObjectiveCitations(tx, refs, teachingPurpose, () => true),
          openUnderstandingCitations: refs => openUnderstandingCitations(tx, refs, 'storage'),
          checkObjectScopeFact: notionCheck(tx, 'storage', check),
          isRevocableCompanionTurn: fact => fact.type === 'activity.studyTurn' && !fact.purpose.includes('all') && studyTurn(fact.value).caseId === 'companion',
          readCalibration: async () => {
            return projectCalibrationSummary(reconciliations.flatMap(({ view }) => view.kind === 'reconciliation' ? [view as CalibrationInputRecord] : []));
          },
        });
        return { ...overview, weaknessSummary };
      });
    },

    aiActivity() {
      return readScope(async (tx, check) => {
        const asOf = new Date().toISOString();
        const readers = snapshotFactReaders(tx);
        const readStorage = gatedReader(tx, readers, 'storage', check);
        const readTeaching = gatedReader(tx, readers, teachingPurpose, check);
        const readResearch = researchReader(tx);
        return readAiActivity(tx, asOf, {
          feedbackSlotType: slotType, readStorage, readTeaching, isUnavailable: isFactUnavailable,
          readBankQuestion: { ...createCommandReadContext(tx, teachingPurpose), fact: readTeaching.fact, slot: readCurrentQuestionVerification(tx) },
          authorizeTodo: rawSpec => authorizeResearchTodoSpec(rawSpec, {
            settingsId, readResearch, isUnavailable: isFactUnavailable, verifyFact: notionCheck(tx, researchPurpose, check),
          }),
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
            return opened ? {
              title: opened.worksheet.title, summary: opened.worksheet.steps[0] ?? '后台教研复习单已就绪',
              basisCount: 1, href: opened.source ? `/api/papers/${opened.source.paperId}/attempts/${opened.worksheet.source.attemptId}/research` : null,
            } : undefined;
          },
          async readRetentionHandoffs() {
            const { forecasts, reconciliations } = await readRetention(tx, check);
            return [...forecasts, ...reconciliations].map(({ view }) => projectRetentionHandoff(view));
          },
          openNotionSelection: selectionId => readActiveNotionSelectionSummary(
            tx, createCommandReadContext(tx, 'storage'), id => readable(() => readStorage.fact(id, { mode: 'following' })), selectionId),
          readBudgetUsage: () => effectBudgetUsage(tx),
          readBudgetLimit: async () => (await readable(() => readResearch.fact(settingsId, { mode: 'following' }).then(f => researchSettings(f.value))))?.scoutConsent?.limitMicros ?? null,
          readGraphProposals: async () => (await readAuthorizedKnowledgeGraph(tx, graphAccess(tx, readStorage, 'storage', check))).pendingProposals,
          openTextbookProposal: (_proposalId, input) => openPendingTextbookProposal(readStorage, input, isFactUnavailable),
        });
      });
    },
  };
}
