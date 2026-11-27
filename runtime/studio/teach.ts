import { classroomReply } from '../../modules/activity/classroom.ts';
import { readClassroomMountEvidence } from './presentation-store.ts';
import { openLearningTools } from './learning-tools.ts';
import { attachmentCurrent } from './reading.ts';
import {
  confirmNotionDispatch, confirmNotionRead, notionSendBasis, savedNotionWitnesses,
  teachingResultAuthority, type CheckNotionRead, type NotionRecipient, type openStudioNotion,
} from './notion.ts';
import { ridingLesson, averageSpeed } from '../../modules/activity/starter.ts';
import { currentMemory, memoryId } from './memory.ts';
import { memoryScopeForObject, readMemoryGateway } from './memory-gateway.ts';
import { teachingMemoryBasis } from './memory-claims.ts';
import { isMemoryConflict, openTurnMemory } from './turn-memory.ts';
import { turnClaimWitness } from '../../modules/companion/claim.ts';
import { loadTeachingCraft } from '../../modules/companion/teaching-craft-host.ts';
import { foregroundDigest } from './foreground-digest.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import {
  derivationId, factId, isFactReadDenied, isFactUnavailable, learnerId, LifecycleError, listEffectLabels,
  markSlotFailed, parseManifest, readDerivationSlot, storeSettledValue,
  type Db, type DbTransaction, type FactSnapshot, type Json, type Manifest, type ReadTransaction, type Tick,
} from '../../kernel/src/index.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { manifestFactInputs } from '../../kernel/src/derivations/revalidate.ts';
import { bindSessionPayloadSources } from '../../kernel/src/work/payload.ts';
import { failWork, finishWork, readWork, readReadyWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { TeachingError, type CarePauseSignal } from '../../executors/teaching/index.ts';
import { ChangedEvidence, classifyTeachingFailure, terminalRecoveryFailure } from '../../executors/teaching/turn-errors.ts';
import { createTurnWitnessLedger } from '../../executors/teaching/turn-witness.ts';
import { createTeachingModelEffect } from '../../executors/teaching/turn-effect.ts';
import { executeCompanionTurn } from '../../executors/teaching/turn-companion.ts';
import { companionForegroundSummary, createTurnProgressHandler, prepareTeachingTurn, runIntroTeachingTurn } from '../../executors/teaching/turn-context.ts';
import { studyRecord, studyTurn } from '../../modules/activity/values.ts';
import { caseId, readOwnStudyTurn, readTeachingTurn, type DisplayTurn } from './sessions.ts';
import { jitWitnessesCurrent, prepareFirstTurnJit, studioJitCounter, type StudioJitCounter } from './first-turn-jit.ts';
import { turnTask } from '../../executors/teaching/model-routes.ts';
import { workspaceGrantChecker, sameRoute, requiresAccountConfirmation, workspaceRouteRevision } from './harness.ts';
import type { ReadArtifactAssessmentWitness } from './artifact-assessment.ts';
import {openWorkspaceTools, workspaceInput, workspaceProofKey, type WorkspaceWitness} from './workspace-agent.ts';
import {readCurrentLearningObject, type OpenedCurrentLearningObject} from './current-learning-object.ts';
import {isWorkspaceAssessmentSlot, workspaceAssessmentBasis, type AssessmentSlot, type WorkspaceAssessmentBasis} from './workspace-read.ts';
import {isRadarRetentionSlot, readRetentionBasis, verifyRetentionBases, type RadarSlot, type RetentionBasis} from './learner-radar.ts';
import { checkProviderAccount, loadSettings } from './settings.ts';
import { completeTurnStream, publishSessionActivity, publishSessionDelta, publishTurnProgress } from './stream.ts';
import { companionReplyStartedLabel, companionReplyTrackingLabel, questionReceiptsCurrent } from './question-exposure.ts';
import {
  confirmedTeachingMethod, learningToolsMethod, modelRecipientId, methodName,
  purpose, slotType, sourceId, stableId, studioHost, studioLearner,
} from './identity.ts';

const hasTeachingModelEffect = async (tx: ReadTransaction, slotKey: string) =>
  (await listEffectLabels(tx, 'session', slotKey)).has('teaching-model');
/** Teaching turns own their publication path; downstream propagation stays with declared slot triggers. */
const noopSettledHooks = { async onSlotChanged() {} };

export async function teach(db: Db, ref: WorkRef, readArtifactAssessmentWitness?: ReadArtifactAssessmentWitness,
  jitCounters: readonly StudioJitCounter[] = [], onTurnCompleted?: (tx: DbTransaction, tick: Tick, id: string) => Promise<void>,
  carePause?: { pause: (key: string) => Promise<unknown>; paused?: (tx: ReadTransaction) => Promise<boolean> },
  notion?: Pick<ReturnType<typeof openStudioNotion>, 'readTool'>) {
  if (ref.learner !== studioLearner) throw new Error('Unknown teaching scope');
  const job = await readWork(db, ref);
  if (!job) return;
  if (job.slotType !== slotType || ![methodName, confirmedTeachingMethod, learningToolsMethod].includes(job.deriver))
    throw new Error('Unknown teaching method');
  const learner = learnerId(ref.learner), { slotKey } = job, host = studioHost(db), scope = host.scope;
  let currentObject: OpenedCurrentLearningObject | undefined, jit: Awaited<ReturnType<typeof prepareFirstTurnJit>>;
  let liveMemoryRevision: number | undefined, learningMemory: Awaited<ReturnType<typeof readMemoryGateway>>;
  let expandedMemory: typeof learningMemory, memoryTurn: string | undefined;
  let checkTurnAccount: (() => Promise<boolean>) | undefined, attachmentOrigin: ReturnType<typeof studyTurn> | undefined;
  let authorizeWorkspaceRecipient: (() => Promise<void>) | undefined;
  const ledger = createTurnWitnessLedger<WorkspaceWitness, WorkspaceAssessmentBasis, RetentionBasis, NonNullable<typeof learningMemory>>(
    { slotType, toInput: workspaceInput, proofKey: workspaceProofKey, canonicalKey: canonicalJsonString });
  const { inputs, assessments, retention, notionWitnesses, learningReadBasis, trackNotion, trackRetention, trackFact,
    trackFeedback, trackWorkspace, trackMemory, keepLearningBasis } = ledger;
  const maySend: NotionRecipient = (fact: FactSnapshot) => fact.type !== 'companion.memory' || fact.ref.rev === liveMemoryRevision;
  const localRead = (stepKey: string, label: string, input: unknown, read: (tx: ReadTransaction) => Promise<string>,
    authorize: (tx: DbTransaction) => Promise<void>) =>
    recordLocalRead(db, { ...scope, ownerKind: 'session', ownerId: slotKey, stepKey, label, input: input as Json }, read, authorize);
  const read = (id: string) => host.snapshot(async tx => {
    const fact = await host.read(tx, purpose).fact(factId(id), { mode: 'following' });
    trackFact(id, fact);
    return fact.value;
  });
  const priorTurn = (id: string) => host.snapshot(async tx => {
    const fact = await readOwnStudyTurn(tx, id), teaching = fact.purpose.includes(purpose) || fact.purpose.includes('all');
    if (teaching) trackFact(id, fact);
    return { data: studyTurn(fact.value), teaching };
  });

  async function readFeedback(tx: ReadTransaction, id: string, check: CheckNotionRead, prior?: ReturnType<typeof studyTurn>) {
    const { rows: [row] } = await tx.query<{ id: string; value: DisplayTurn; manifest: unknown }>(
      `SELECT d.id, d.value, d.manifest FROM slot_state s JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3 AND NOT EXISTS (
         SELECT 1 FROM effects e WHERE e.learner_id=$1 AND e.owner_kind='session' AND e.owner_id=$3
           AND e.label='local:python_attempts' AND ((e.result #>> '{}')::jsonb->>'pythonAttemptsProjection') IS DISTINCT FROM '1')`,
      [learner, slotType, id]);
    if (!row) return;
    const manifest = parseManifest(row.manifest), submission = prior ?? studyTurn((await readTeachingTurn(tx, id)).value);
    const authority = await teachingResultAuthority(tx, id, submission, manifest, workspaceGrantChecker(tx), check, undefined, 'history');
    return authority.state === 'authorized' ? { ...row, manifest, memoryBasis: authority.memoryBasis } : undefined;
  }
  const stale = (): never => { throw new ChangedEvidence(); };
  const checkWorkspaceRecipient = async () => (authorizeWorkspaceRecipient ?? stale())();
  async function revalidateInputs(tx: ReadTransaction, use: 'publish' | 'dispatch' = 'publish') {
    if ((checkTurnAccount && !await checkTurnAccount()) || (attachmentOrigin && !await attachmentCurrent(tx, attachmentOrigin))) stale();
    const pages = await notionSendBasis(tx, notionWitnesses.values(), maySend).catch(stale);
    if (liveMemoryRevision !== undefined && (await currentMemory(tx)).revision !== liveMemoryRevision) stale();
    if (ledger.hasExpiredMemory(new Date().toISOString())) stale();
    if (jit) { await checkWorkspaceRecipient(); if (!await jitWitnessesCurrent(tx, jit.basis, maySend)) stale(); }
    if (currentObject || assessments.size || retention.size) {
      await checkWorkspaceRecipient();
      for (const { slot } of assessments.values()) if (!await workspaceAssessmentBasis(tx, slot, maySend)) stale();
      if (!await verifyRetentionBases(tx, retention.values(), maySend)) stale();
    }
    const manifest = parseManifest({ version: 1, learner, purpose, gatherTick: await host.clock(tx), inputs: [...inputs.values()] });
    const evidence = await teachingMemoryBasis(tx, manifest, slotKey, maySend);
    if (!evidence || !await questionReceiptsCurrent(tx, slotKey, use)) stale();
    return { manifest, pages, usesRadarTodo: evidence!.usesRadarTodo };
  }
  const validInputs = async (tx: ReadTransaction) => (await revalidateInputs(tx)).manifest;
  const validWorkInputs = async (tx: ReadTransaction, use?: 'publish' | 'dispatch') => {
    if (!await readReadyWork(tx, ref)) stale();
    return revalidateInputs(tx, use);
  };
  const settle = (feedback: DisplayTurn, optedIn: boolean) => finishWork(db, ref, async (tx, tick) => {
    const manifest = await validInputs(tx), id = derivationId(stableId('feedback', ref.learner, ref.workId, ref.generation));
    const sourceIds = ledger.sourceIdsForDigest(feedback.workspaceBasis, memoryId);
    const summary = companionForegroundSummary(feedback, sourceIds.length);
    const digest = summary ? foregroundDigest(job.slotKey, manifest, sourceIds, summary) : undefined;
    await storeSettledValue(tx, tick, { slotType, key: job.slotKey, id, deriver: job.deriver, scope: {},
      value: (digest ? { ...feedback, foregroundDigest: digest } : feedback) as Json, manifest, kind: 'carry' }, noopSettledHooks);
    await completeTurnStream(tx, job.slotKey);
    if (optedIn) await onTurnCompleted?.(tx, tick, job.slotKey);
  });
  try {
    const turn = await host.snapshot(tx => readTeachingTurn(tx, slotKey));
    trackFact(turn.ref.id, turn);
    const submission = studyTurn(turn.value);
    if (submission.memoryVersion === 1) memoryTurn = job.slotKey;
    const prepared = await prepareTeachingTurn({ submission, deriver: job.deriver, methodName, learningToolsMethod },
      { loadPriorTurn: priorTurn, requiresAccountConfirmation, resolveTask: turnTask,
        checkAttachmentCurrent: origin => host.snapshot(tx => attachmentCurrent(tx, origin)), loadSettings, workspaceRouteRevision });
    const { original, origin, learningV1, task, settings, checkWorkspaceRoute, authorizeWorkspace, grants, mcpServers } = prepared;
    attachmentOrigin = prepared.attachmentOrigin; checkTurnAccount = prepared.checkTurnAccount; authorizeWorkspaceRecipient = authorizeWorkspace;
    if (submission.workspaceRevision) maySend.notionRecipientId = modelRecipientId(settings, submission.workspaceRevision);
    const onProgress = createTurnProgressHandler({
      learningV1, publishProgress: progress => publishTurnProgress(db, ref, job.slotKey, submission.sessionId, progress, validInputs),
      recordReplyStarted: () => localRead('replying', companionReplyStartedLabel, {},
        async () => 'possible', async tx => { if (!await readReadyWork(tx, ref)) stale(); }).then(() => {}),
    });
    let deltaSeq = 0;
    const runModelEffect = createTeachingModelEffect<ReadTransaction, DbTransaction>({
      purpose, learningV1, settings, submission, grants, ledger, notionRecipientId: () => maySend.notionRecipientId, getJit: () => jit,
      getLearningMemoryContext: () => learningMemory?.context,
      loadSelected: () => host.snapshot(tx => notionSendBasis(tx, notionWitnesses.values(), maySend)),
      confirmPages: async pages => { await confirmNotionDispatch(db, pages as Awaited<ReturnType<typeof notionSendBasis>>).catch(stale); },
      validWorkInputs, loadSettings: () => loadSettings(task), jitCounterFor: current => studioJitCounter(jitCounters, current), checkWorkspaceRoute,
      checkProviderAccount: tx => checkProviderAccount(tx,
        { providerId: submission.providerId ?? 'default', accountRevision: submission.accountRevision! }, task),
      runEffect: (request, execute, authorize) => runEffect(db, { learner, ownerKind: 'session', ownerId: slotKey, ...request }, execute, authorize),
      runDispatchTx: fn => host.lockedTx(fn), checkFreshEvidence: () => host.snapshot(validInputs).then(() => {}),
      isLifecycleError: error => error instanceof LifecycleError,
      bindSources: async (tx, manifest) => {
        const sources = (await manifestFactInputs(tx, manifest.inputs as Manifest['inputs'])).map(input => input.id);
        if (attachmentOrigin?.attachment) sources.push(attachmentOrigin.attachment.id);
        await bindSessionPayloadSources(tx, ref, sources);
      },
    });

    let feedback: DisplayTurn;
    if (submission.caseId === 'companion' || submission.caseId === 'riding') {
      const authorizeMemory = async (tx: ReadTransaction) => { await validWorkInputs(tx); await authorizeWorkspace(); };
      const authorizeLearning = async (tx: ReadTransaction) => {
        await validWorkInputs(tx);
        if (!sameRoute(submission, await loadSettings(task))) stale();
        if (submission.workspaceRevision) await checkWorkspaceRoute();
      };
      const memoryGateway = async (overrides: Pick<Parameters<typeof readMemoryGateway>[0], 'owner' | 'maxBytes'>
          & Partial<Parameters<typeof readMemoryGateway>[0]>, required = true) => {
        const packet = await readMemoryGateway({ db, scope: memoryScopeForObject(currentObject), intent: 'tutoring', maySend,
          ...(memoryTurn ? { ownTurn: memoryTurn } : {}), authorize: authorizeMemory, ...overrides });
        if (!packet && required) stale();
        if (packet) trackMemory(packet);
        return packet;
      };
      feedback = await executeCompanionTurn({
        slotKey: job.slotKey, slotType, submission, learningV1, memoryTurn, ledger,
        attachment: original.teaching ? origin.attachment : undefined, settings, grants, mcpServers, memoryId, ridingLesson, averageSpeed,
        onProgress, runEffect: runModelEffect,
        onTextDelta: async delta => {
          if (delta) deltaSeq = await publishSessionDelta(db, submission.sessionId, job.slotKey, deltaSeq, delta).catch(() => deltaSeq + 1);
        },
        onActivity: activity => publishSessionActivity(db, submission.sessionId, job.slotKey, activity).catch(() => {}),
      }, {
        loadClassroomAdjust: async () => {
          const classroom = submission.classroom!;
          const observed = await confirmNotionRead(db, learner, (tx, check) => Promise.all(classroom.evidence.map(async itemRef =>
            await readClassroomMountEvidence(tx, submission.sessionId, classroom.evidenceTurn!, itemRef, check) ?? stale())));
          return host.snapshot(tx => Promise.all(observed.map(async item => {
            const basis = parseManifest(item.manifest).inputs, witnesses = await savedNotionWitnesses(tx, basis);
            let assessmentSlot: { slot_type: string; slot_key: string; derivationId: string } | undefined;
            if (item.assessment && 'derivationId' in item.assessment) {
              const slot = await readDerivationSlot(tx, item.assessment.derivationId) ?? stale();
              assessmentSlot = { slot_type: slot.slotType, slot_key: slot.slotKey, derivationId: item.assessment.derivationId };
            }
            return { ...item, basis, notionWitnesses: witnesses, ...(assessmentSlot && { assessmentSlot }) };
          })));
        },
        getJitCounter: () => studioJitCounter(jitCounters, settings),
        prepareJit: async counter => {
          jit = await prepareFirstTurnJit(db, learner, job.slotKey, submission, settings, counter, { maySend, authorize: authorizeMemory });
          currentObject = jit?.current;
          return jit;
        },
        loadCurrentObject: async () => {
          await authorizeWorkspace();
          currentObject = await host.snapshot(tx => readCurrentLearningObject(tx, submission.currentObject!, maySend));
          currentObject?.basis.forEach(trackNotion);
          return currentObject;
        },
        loadPreference: () => host.snapshot(async tx => {
          const value = await currentMemory(tx);
          if (!value.text || value.endpoint !== settings.baseUrl || value.providerId !== settings.activeProviderId ||
              value.protocol !== settings.protocol) return;
          const fact = await host.read(tx, purpose).fact(memoryId, { mode: 'following' });
          trackFact(memoryId, fact, 'pinned');
          liveMemoryRevision = value.revision;
          const mem = inputs.get(memoryId);
          return { text: value.text, witness: mem?.kind === 'fact'
            ? { id: memoryId, rev: mem.rev, epoch: mem.accessEpoch, type: 'companion.memory' } : undefined };
        }),
        loadLearningMemory: async () => {
          const labels = await host.snapshot(tx => listEffectLabels(tx, 'session', job.slotKey));
          if (labels.has('teaching-model') && !labels.has('local:learning-memory')) return undefined;
          return learningMemory = await memoryGateway({ maxBytes: 8192, owner: { kind: 'session', id: job.slotKey, step: 'memory' } });
        },
        loadTeachingCraft: context => host.snapshot(tx => loadTeachingCraft(tx, {
          ...context, slotKey, sessionId: submission.sessionId, classroom: Boolean(submission.classroom), carePause,
          carePauseId: factId(stableId('care-pause', studioLearner)),
          classroomId: factId(stableId('classroom', submission.sessionId)),
          referenceIds: [...new Set([
            submission.currentObject?.id, origin.currentObject?.id, submission.attachment?.id, origin.attachment?.id,
            ...context.priorReferenceIds, ...(currentObject?.basis.map(w => w.id) ?? []),
            ...(jit?.basis.map(w => w.id) ?? []),
          ].filter((id): id is string => Boolean(id)))],
        })),
        expandLearningMemory: async (expand, step) => expandedMemory = await memoryGateway(
          { maxBytes: 16_384, expand, owner: { kind: 'session', id: job.slotKey, step: `memory-region:${step}` } }, false),
        withHistoryRead: fn => confirmNotionRead(db, learner, (tx, check) => fn({
          readPriorTurn: async id => {
            const prior = await readTeachingTurn(tx, id).catch(e => isFactReadDenied(e) && e.reason === 'purpose' ? undefined : Promise.reject(e));
            return prior && { ref: prior.ref, accessEpoch: prior.accessEpoch, data: studyTurn(prior.value) };
          },
          readReply: (id, previous) => readFeedback(tx, id, check, previous),
          savedNotionWitnesses: (reply): Promise<WorkspaceWitness[]> =>
            savedNotionWitnesses(tx, reply.manifest.inputs as Parameters<typeof savedNotionWitnesses>[1]),
          readAssessmentBasis: slot => workspaceAssessmentBasis(tx, slot as AssessmentSlot, maySend),
          readRetentionBasis: slot => readRetentionBasis(tx, slot as RadarSlot, { callerPurpose: purpose, maySend }),
          confirmNotionSend: async witnesses => { await notionSendBasis(tx, witnesses, maySend, check); },
        })),
        isAssessmentSlot: isWorkspaceAssessmentSlot, isRetentionSlot: isRadarRetentionSlot, proofKey: workspaceProofKey,
        readToolContract: (stepKey, tool, version) => localRead(stepKey, 'local:tool-contract', { tool },
          async tx => await hasTeachingModelEffect(tx, slotKey) ? 'legacy' : version, authorizeMemory),
        openWorkspace: ({ prior, beliefTools, jitBasis, learningMemoryBasis }) => openWorkspaceTools({
          db, turn: job.slotKey, presentationManifest: validInputs, readArtifactAssessmentWitness, prior, currentObject, maySend, beliefTools,
          ...(submission.agentVersion === 2 && { narrowSaves: true }), draftBasis: ledger.draftBasis, ...(jitBasis && { jitBasis }),
          ...(learningV1 && { learningBasis: () => [...learningReadBasis.values()] }),
          pageBasis: ledger.pageBasis(job.slotKey, learningMemoryBasis, jitBasis), track: trackWorkspace,
          trackAssessment: ledger.trackAssessment, trackRetention, trackDiagnosis: ledger.markWorkspaceDispatch, authorize: authorizeLearning,
        }),
        openTurnMemory: ({ answer, beliefTools, workspace }) => openTurnMemory({
          db, turn: memoryTurn!, answer, source: turnClaimWitness(turn), ...(currentObject && { currentObject }), authorize: authorizeMemory,
          ...(beliefTools && { belief: { maySend, opened: citation => workspace?.openedBeliefEvidence(citation) ?? false } }),
          retrieve: (query, step) => memoryGateway({ intent: 'management', maxBytes: 8192,
            ...(beliefTools && { beliefTools }), ...(query && { query }),
            owner: { kind: 'session', id: job.slotKey, step: 'retrieve-memory:' + step } }).then(packet => packet!),
        }),
        recordLearningTracking: async () => { await localRead('replying', companionReplyTrackingLabel, {},
          async tx => await hasTeachingModelEffect(tx, slotKey) ? 'unknown' : 'tracked', authorizeLearning); },
        openLearningTools: ({ workspace, turnMemory, manageBeliefs }) => openLearningTools({
          db, turn: slotKey, workspace, maySend, manageBeliefs, authorize: authorizeLearning, trackRetention, ...(notion && { notion }),
          track: w => { keepLearningBasis(w); trackWorkspace(w, true); },
          authorizeRemote: () => confirmNotionRead(db, learner, async (tx, check) => {
            await authorizeLearning(tx);
            await notionSendBasis(tx, notionWitnesses.values(), maySend, check);
            return true;
          }).catch(e => e instanceof ChangedEvidence || isFactUnavailable(e) || e instanceof TeachingError || e instanceof LifecycleError
            ? false : Promise.reject(e)),
          onDelivered: turnMemory.onDelivered, saveBelief: (args, step) => turnMemory.execute('save_belief', args, step),
          async readContext(intent, step, expand, query) {
            const packet = await memoryGateway({ intent, maxBytes: expand ? 16_384 : 8192, beliefTools: true,
              ...(expand && { expand }), ...(query && { query }), owner: { kind: 'session', id: slotKey, step: `context-v1:${step}` } }, false);
            if (!packet) return;
            if (intent === 'management') turnMemory.offerManagement(step, packet);
            packet.receipt.basis.forEach(keepLearningBasis);
            return packet.bundle;
          },
        }),
        parseClassroomReply: classroomReply, isMemoryConflict,
      });
    } else {
      const selected = caseId(submission.caseId);
      if (selected !== 'independent' && selected !== 'workedExample') throw new Error('Unknown teaching case');
      feedback = await runIntroTeachingTurn(
        { selected, parentId: submission.parentId, answer: submission.answer, settings, onProgress, runEffect: runModelEffect },
        {
          loadParentReply: async parent => {
            const prior = await confirmNotionRead(db, learner, async (tx, check) => {
              const reply = await readFeedback(tx, parent, check);
              return reply && { reply, witnesses: await savedNotionWitnesses(tx, reply.manifest.inputs) };
            }) ?? stale();
            prior.witnesses.forEach(trackNotion);
            trackFeedback(parent, prior.reply);
            return prior.reply.value;
          },
          readEvidenceRecord: async id => {
            const { title, text } = studyRecord(await read(sourceId(selected, id)));
            return { id, title, text };
          },
        });
    }
    const isCrisis = Boolean((feedback as DisplayTurn & { carePause?: CarePauseSignal }).carePause);
    if (isCrisis) await carePause?.pause(job.slotKey);
    await settle(feedback, submission.allowBackgroundUnderstanding === true && !isCrisis);
  } catch (error) {
    const failure = classifyTeachingFailure(error);
    if (!failure) throw error;
    await failTeachingWork(db, ref, job, failure);
  }
}

const failTeachingWork = (db: Db, ref: WorkRef, job: { slotType: string; slotKey: string },
  error: { status: 'failed' | 'unknown'; message: string }) => failWork(db, ref, async (tx, tick) => {
  await markSlotFailed(tx, job.slotType, job.slotKey, error, tick);
  await completeTurnStream(tx, job.slotKey);
});
export async function recordTerminalFailure(db: Db, ref: WorkRef) {
  const job = await readWork(db, ref);
  if (job) await failTeachingWork(db, ref, job, { status: 'failed', message: terminalRecoveryFailure });
}
