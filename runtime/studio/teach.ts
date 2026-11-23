import { classroomReply } from '../../modules/activity/classroom.ts';
import { readClassroomMountEvidence } from './presentation-store.ts';
import { openLearningTools } from './learning-tools.ts';
import { attachmentCurrent } from './reading.ts';
import { confirmNotionDispatch, confirmNotionRead, notionSendBasis, savedNotionWitnesses, teachingResultAuthority,
  type CheckNotionRead, type NotionRecipient, type openStudioNotion } from './notion.ts';
import { ridingLesson, averageSpeed } from '../../modules/activity/starter.ts';
import { currentMemory, memoryId } from './memory.ts';
import { memoryScopeForObject, readMemoryGateway } from './memory-gateway.ts';
import { teachingMemoryBasis } from './memory-claims.ts';
import { isMemoryConflict, openTurnMemory } from './turn-memory.ts';
import { turnClaimWitness } from '../../modules/companion/claim.ts';
import { foregroundDigest } from './foreground-digest.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { isFactReadDenied, isFactUnavailable } from './fact-read-helpers.ts';
import { createLearnerHost, derivationId, factId, learnerId, LifecycleError, parseManifest,
  storeSettledValue, type Db, type DbTransaction, type FactSnapshot, type Json, type Manifest, type ReadTransaction, type Tick } from '../../kernel/src/index.ts';
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
import {isRadarRetentionSlot, readRetentionBasis, type RadarSlot, type RetentionBasis} from './learner-radar.ts';
import { checkProviderAccount, loadSettings } from './settings.ts';
import { completeTurnStream, publishSessionDelta, publishTurnProgress } from './stream.ts';
import { companionReplyStartedLabel, companionReplyTrackingLabel, questionReceiptsCurrent } from './question-exposure.ts';
import { confirmedTeachingMethod, learningToolsMethod, notionModelRecipient, methodName, purpose, slotType, sourceId, stableId, studioLearner } from './identity.ts';

const hasTeachingModelEffect = async (tx: ReadTransaction, slotKey: string) =>
  Boolean((await tx.query(`SELECT 1 FROM effects WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND label='teaching-model' LIMIT 1`,
    [tx.learner, slotKey])).rowCount);
/** Teaching turns own their publication path; downstream propagation stays with declared slot triggers. */
const noopSettledHooks = { async onSlotChanged() {} };

export async function teach(db: Db, ref: WorkRef, readArtifactAssessmentWitness?: ReadArtifactAssessmentWitness,
  jitCounters: readonly StudioJitCounter[] = [],
  onTurnCompleted?: (tx: DbTransaction, tick: Tick, id: string) => Promise<void>,
  carePause?: { pause: (key: string) => Promise<unknown> },
  notion?: Pick<ReturnType<typeof openStudioNotion>, 'readTool'>) {
  if (ref.learner !== studioLearner) throw new Error('Unknown teaching scope');
  const job = await readWork(db, ref);
  if (!job) return;
  if (job.slotType !== slotType || ![methodName,confirmedTeachingMethod,learningToolsMethod].includes(job.deriver)) throw new Error('Unknown teaching method');
  const learner = learnerId(ref.learner), {slotKey} = job;
  const host = createLearnerHost(db, learner);
  const scope = host.scope;
  let currentObject: OpenedCurrentLearningObject | undefined;
  let jit: Awaited<ReturnType<typeof prepareFirstTurnJit>>;
  let liveMemoryRevision: number | undefined;
  let learningMemory: Awaited<ReturnType<typeof readMemoryGateway>>;
  let expandedMemory: typeof learningMemory;
  let memoryTurn: string | undefined;
  let checkTurnAccount: (() => Promise<boolean>) | undefined;
  let attachmentOrigin: ReturnType<typeof studyTurn> | undefined;
  let authorizeWorkspaceRecipient: (() => Promise<void>) | undefined;
  const ledger = createTurnWitnessLedger<
    WorkspaceWitness,
    WorkspaceAssessmentBasis,
    RetentionBasis,
    NonNullable<typeof learningMemory>
  >({ slotType, toInput: workspaceInput, proofKey: workspaceProofKey, canonicalKey: canonicalJsonString });
  const { inputs, assessments, retention, notionWitnesses, learningReadBasis, trackNotion, trackRetention, trackFact, trackFeedback, trackWorkspace, trackMemory, keepLearningBasis } = ledger;
  const maySend: NotionRecipient = (fact: FactSnapshot) => fact.type !== 'companion.memory' || fact.ref.rev === liveMemoryRevision;
  const localRead = (stepKey: string, label: string, input: unknown, read: (tx: ReadTransaction) => Promise<string>,
    authorize: (tx: DbTransaction) => Promise<void>) =>
    recordLocalRead(db, { ...scope, ownerKind: 'session', ownerId: slotKey, stepKey, label, input: input as Json }, read, authorize);
  async function readFact(tx: ReadTransaction, id: string, mode?: 'pinned' | 'following') {
    const fact = await host.read(tx, purpose).fact(factId(id), {mode: 'following'});
    trackFact(id, fact, mode);
    return fact.value;
  }
  const read = (id: string) => host.snapshot(tx => readFact(tx, id));
  const priorTurn = (id: string) => host.snapshot(async tx => {
    const fact = await readOwnStudyTurn(tx, id);
    const teaching = fact.purpose.includes(purpose) || fact.purpose.includes('all');
    if (teaching) trackFact(id, fact);
    return {data: studyTurn(fact.value), teaching};
  });

  async function readFeedback(tx: ReadTransaction, id: string, check: CheckNotionRead,
    prior?: ReturnType<typeof studyTurn>) {
    const { rows: [row] } = await tx.query<{ id: string; value: DisplayTurn; manifest: unknown }>(
      `SELECT d.id, d.value, d.manifest FROM slot_state s JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3
       AND NOT EXISTS (
         SELECT 1 FROM effects e WHERE e.learner_id=$1 AND e.owner_kind='session' AND e.owner_id=$3
           AND e.label='local:python_attempts'
           AND ((e.result #>> '{}')::jsonb->>'pythonAttemptsProjection') IS DISTINCT FROM '1')`,
      [learner, slotType, id],
    );
    if (!row) return;
    const manifest = parseManifest(row.manifest);
    const submission = prior ?? studyTurn((await readTeachingTurn(tx, id)).value);
    const authority = await teachingResultAuthority(tx, id, submission, manifest, workspaceGrantChecker(tx), check, undefined, 'history');
    if (authority.state !== 'authorized') return;
    return {...row, manifest, memoryBasis: authority.memoryBasis};
  }
  const stale = (): never => { throw new ChangedEvidence(); };
  async function checkWorkspaceRecipient() {
    if (!authorizeWorkspaceRecipient) throw new ChangedEvidence();
    await authorizeWorkspaceRecipient();
  }
  async function revalidateInputs(tx: ReadTransaction, use: 'publish' | 'dispatch' = 'publish') {
    if ((checkTurnAccount && !await checkTurnAccount()) || (attachmentOrigin && !await attachmentCurrent(tx, attachmentOrigin))) stale();
    const pages = await notionSendBasis(tx,notionWitnesses.values(),maySend).catch(stale);
    if (liveMemoryRevision !== undefined && (await currentMemory(tx)).revision !== liveMemoryRevision) stale();
    if (ledger.hasExpiredMemory(new Date().toISOString())) stale();
    if (jit) {
      await checkWorkspaceRecipient();
      if (!await jitWitnessesCurrent(tx, jit.basis, maySend)) stale();
    }
    if (currentObject || assessments.size || retention.size) {
      await checkWorkspaceRecipient();
      for (const {slot} of assessments.values()) if (!await workspaceAssessmentBasis(tx, slot, maySend)) stale();
      for (const basis of retention.values()) {
        const actual = await readRetentionBasis(tx,basis.slot,{callerPurpose:purpose,maySend});
        if (!actual || canonicalJsonString(actual) !== canonicalJsonString(basis)) stale();
      }
    }
    const { rows: [clock] } = await tx.query<{ tick: string }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [learner]);
    const manifest = parseManifest({ version: 1, learner, purpose, gatherTick: clock?.tick, inputs: [...inputs.values()] });
    const evidence = await teachingMemoryBasis(tx, manifest, slotKey, maySend);
    if (!evidence) throw new ChangedEvidence();
    if (!await questionReceiptsCurrent(tx,slotKey,use)) stale();
    return {manifest, pages, usesRadarTodo:evidence.usesRadarTodo};
  }
  const validInputs = async (tx: ReadTransaction) => (await revalidateInputs(tx)).manifest;
  const validWorkInputs = async (tx: ReadTransaction, use?: 'publish' | 'dispatch') => {
    if (!await readReadyWork(tx, ref)) stale();
    return revalidateInputs(tx, use);
  };
  const settle = (feedback: DisplayTurn, optedIn: boolean) => finishWork(db, ref, async (tx, tick) => {
    const manifest = await validInputs(tx);
    const id = derivationId(stableId('feedback', ref.learner, ref.workId, ref.generation));
    const sourceIds = ledger.sourceIdsForDigest(feedback.workspaceBasis, memoryId);
    const summary = companionForegroundSummary(feedback, sourceIds.length);
    const digest = summary ? foregroundDigest(job.slotKey, manifest, sourceIds, summary) : undefined;
    await storeSettledValue(tx, tick, {
      slotType, key: job.slotKey, id, deriver: job.deriver, scope: {},
      value: (digest ? { ...feedback, foregroundDigest: digest } : feedback) as Json,
      manifest, kind: 'carry',
    }, noopSettledHooks);
    await completeTurnStream(tx, job.slotKey);
    if (optedIn) await onTurnCompleted?.(tx, tick, job.slotKey);
  });
  try {
    const turn = await host.snapshot(tx => readTeachingTurn(tx, slotKey));
    trackFact(turn.ref.id, turn);
    const submission = studyTurn(turn.value);
    if (submission.memoryVersion === 1) memoryTurn = job.slotKey;
    const prepared = await prepareTeachingTurn(
      { submission, deriver: job.deriver, methodName, learningToolsMethod },
      {
        loadPriorTurn: priorTurn, requiresAccountConfirmation, resolveTask: turnTask,
        checkAttachmentCurrent: origin => host.snapshot(tx => attachmentCurrent(tx, origin)),
        loadSettings, workspaceRouteRevision,
      },
    );
    const { original, origin, learningV1, task, settings, checkWorkspaceRoute, authorizeWorkspace, grants, mcpServers } = prepared;
    attachmentOrigin = prepared.attachmentOrigin;
    checkTurnAccount = prepared.checkTurnAccount;
    authorizeWorkspaceRecipient = authorizeWorkspace;
    if (submission.workspaceRevision) {
      maySend.notionRecipientId = notionModelRecipient(settings.activeProviderId, settings.baseUrl, settings.protocol, settings.model, submission.workspaceRevision);
    }
    const onProgress = createTurnProgressHandler({
      learningV1,
      recordReplyStarted: async () => { await localRead('replying', companionReplyStartedLabel, {},
        async () => 'possible', async tx => { if (!(await readReadyWork(tx, ref))) stale(); }); },
      publishProgress: progress => publishTurnProgress(db, ref, job.slotKey, submission.sessionId, progress, validInputs),
    });
    let deltaSeq = 0;
    const runModelEffect = createTeachingModelEffect<ReadTransaction, DbTransaction>({
      purpose, learningV1, settings, submission, grants, ledger,
      notionRecipientId: () => maySend.notionRecipientId,
      getJit: () => jit,
      getLearningMemoryContext: () => learningMemory?.context,
      loadSelected: () => host.snapshot(tx => notionSendBasis(tx, notionWitnesses.values(), maySend)),
      confirmPages: async pages => { await confirmNotionDispatch(db, pages as Awaited<ReturnType<typeof notionSendBasis>>).catch(stale); },
      validWorkInputs,
      loadSettings: () => loadSettings(task),
      jitCounterFor: current => studioJitCounter(jitCounters, current),
      checkWorkspaceRoute,
      checkProviderAccount: tx => checkProviderAccount(tx, {
        providerId: submission.providerId ?? 'default', accountRevision: submission.accountRevision!,
      }, task),
      runEffect: (request, execute, authorize) =>
        runEffect(db, { learner, ownerKind: 'session', ownerId: slotKey, ...request }, execute, authorize),
      runDispatchTx: fn => host.lockedTx(fn),
      checkFreshEvidence: () => host.snapshot(validInputs).then(() => {}),
      isLifecycleError: error => error instanceof LifecycleError,
      bindSources: async (tx, manifest) => {
        const sources = (await manifestFactInputs(tx, manifest.inputs as Manifest['inputs'])).map(input => input.id);
        if (attachmentOrigin?.attachment) sources.push(attachmentOrigin.attachment.id);
        await bindSessionPayloadSources(tx, ref, sources);
      },
    });

    let feedback: DisplayTurn;
    if (submission.caseId === 'companion' || submission.caseId === 'riding') {
      async function authorizeMemory(tx: ReadTransaction) {
        await validWorkInputs(tx);
        await authorizeWorkspace();
      }
      async function authorizeLearning(tx: ReadTransaction) {
        await validWorkInputs(tx);
        if (!sameRoute(submission, await loadSettings(task))) throw new ChangedEvidence();
        if (submission.workspaceRevision) await checkWorkspaceRoute();
      }
      const memoryRequest = () => ({ db, scope: memoryScopeForObject(currentObject), intent: 'tutoring' as const, maySend,
        ...(memoryTurn ? { ownTurn: memoryTurn } : {}), authorize: authorizeMemory });
      const memoryGateway = async (overrides: Pick<Parameters<typeof readMemoryGateway>[0], 'owner' | 'maxBytes'>
          & Partial<Parameters<typeof readMemoryGateway>[0]>, required = true) => {
        const packet = await readMemoryGateway({ ...memoryRequest(), ...overrides });
        if (!packet && required) throw new ChangedEvidence();
        if (packet) trackMemory(packet);
        return packet;
      };
      feedback = await executeCompanionTurn(
        {
          slotKey: job.slotKey, slotType, submission, learningV1, memoryTurn, ledger,
          attachment: original.teaching ? origin.attachment : undefined,
          settings, grants, mcpServers, memoryId, ridingLesson, averageSpeed, onProgress, runEffect: runModelEffect,
          onTextDelta: async delta => {
            if (!delta) return;
            deltaSeq = await publishSessionDelta(db, submission.sessionId, job.slotKey, deltaSeq, delta)
              .catch(() => deltaSeq + 1);
          },
        },
        {
          loadClassroomAdjust: async () => {
            const classroom = submission.classroom!;
            const observed = await confirmNotionRead(db, learner, async (tx, check) => {
              const result = [];
              for (const itemRef of classroom.evidence) {
                const item = await readClassroomMountEvidence(tx, submission.sessionId, classroom.evidenceTurn!, itemRef, check);
                if (!item) throw new ChangedEvidence();
                result.push(item);
              }
              return result;
            });
            return host.snapshot(async tx => {
              const items = [];
              for (const item of observed) {
                const basis = parseManifest(item.manifest).inputs;
                const notion = await savedNotionWitnesses(tx, basis);
                let assessmentSlot: { slot_type: string; slot_key: string; derivationId: string } | undefined;
                if (item.assessment && 'derivationId' in item.assessment) {
                  const { rows: [slot] } = await tx.query<{ slot_type: string; slot_key: string }>(
                    'SELECT slot_type,slot_key FROM derivations WHERE learner_id=$1 AND id=$2', [tx.learner, item.assessment.derivationId]);
                  if (!slot) throw new ChangedEvidence();
                  assessmentSlot = { ...slot, derivationId: item.assessment.derivationId };
                }
                items.push({ ...item, basis, notionWitnesses: notion, ...(assessmentSlot ? { assessmentSlot } : {}) });
              }
              return items;
            });
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
            if (!value.text || value.endpoint !== settings.baseUrl || value.providerId !== settings.activeProviderId || value.protocol !== settings.protocol) return;
            await readFact(tx, memoryId, 'pinned');
            liveMemoryRevision = value.revision;
            const mem = inputs.get(memoryId);
            return { text: value.text, witness: mem?.kind === 'fact' ? { id: memoryId, rev: mem.rev, epoch: mem.accessEpoch, type: 'companion.memory' } : undefined };
          }),
          loadLearningMemory: async () => {
            const { rows: [prior] } = await host.snapshot(tx => tx.query<{ has_sample: boolean; has_memory: boolean }>(
              `SELECT bool_or(label='teaching-model') AS has_sample, bool_or(label='local:learning-memory') AS has_memory
               FROM effects WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2`, [tx.learner, job.slotKey]));
            if (prior?.has_sample && !prior.has_memory) return undefined;
            learningMemory = await memoryGateway({ maxBytes: 8192, owner: { kind: 'session', id: job.slotKey, step: 'memory' } });
            return learningMemory;
          },
          expandLearningMemory: async (expand, step) => {
            expandedMemory = await memoryGateway({ maxBytes: 16_384, expand, owner: { kind: 'session', id: job.slotKey, step: `memory-region:${step}` } }, false);
            return expandedMemory;
          },
          withHistoryRead: fn => confirmNotionRead(db, learner, (tx, check) => fn({
            readPriorTurn: async id => {
              const prior = await readTeachingTurn(tx, id).catch((error: unknown) => {
                if (isFactReadDenied(error) && error.reason === 'purpose') return;
                throw error;
              });
              return prior ? { ref: prior.ref, accessEpoch: prior.accessEpoch, data: studyTurn(prior.value) } : undefined;
            },
            readReply: (id, previous) => readFeedback(tx, id, check, previous),
            savedNotionWitnesses: async (reply): Promise<WorkspaceWitness[]> =>
              savedNotionWitnesses(tx, reply.manifest.inputs as Parameters<typeof savedNotionWitnesses>[1]),
            readAssessmentBasis: slot => workspaceAssessmentBasis(tx, slot as AssessmentSlot, maySend),
            readRetentionBasis: slot => readRetentionBasis(tx, slot as RadarSlot, { callerPurpose: purpose, maySend }),
            confirmNotionSend: async witnesses => { await notionSendBasis(tx, witnesses, maySend, check); },
          })),
          isAssessmentSlot: isWorkspaceAssessmentSlot,
          isRetentionSlot: isRadarRetentionSlot,
          proofKey: workspaceProofKey,
          readToolContract: (stepKey, tool, version) => localRead(stepKey, 'local:tool-contract', { tool },
            async tx => await hasTeachingModelEffect(tx, slotKey) ? 'legacy' : version, authorizeMemory),
          openWorkspace: ({ prior, beliefTools, jitBasis, learningMemoryBasis }) => openWorkspaceTools({
            db, turn: job.slotKey, presentationManifest: validInputs, readArtifactAssessmentWitness, prior, currentObject,
            maySend, beliefTools, ...(submission.agentVersion === 2 && { narrowSaves: true }),
            draftBasis: ledger.draftBasis, ...(jitBasis ? { jitBasis } : {}),
            ...(learningV1 ? { learningBasis: () => [...learningReadBasis.values()] } : {}),
            pageBasis: ledger.pageBasis(job.slotKey, learningMemoryBasis, jitBasis),
            track: trackWorkspace, trackAssessment: ledger.trackAssessment, trackRetention, trackDiagnosis: ledger.markWorkspaceDispatch, authorize: authorizeLearning,
          }),
          openTurnMemory: ({ answer, beliefTools, workspace }) => openTurnMemory({
            db, turn: memoryTurn!, answer, source: turnClaimWitness(turn), ...(currentObject ? { currentObject } : {}), authorize: authorizeMemory,
            ...(beliefTools ? { belief: { maySend, opened: citation => workspace?.openedBeliefEvidence(citation) ?? false } } : {}),
            async retrieve(query, step) {
              return memoryGateway({ intent: 'management', maxBytes: 8192, ...(beliefTools ? { beliefTools } : {}),
                ...(query ? { query } : {}), owner: { kind: 'session', id: job.slotKey, step: 'retrieve-memory:' + step } })
                .then(packet => packet!);
            },
          }),
          recordLearningTracking: async () => { await localRead('replying', companionReplyTrackingLabel, {},
            async tx => await hasTeachingModelEffect(tx, slotKey) ? 'unknown' : 'tracked', authorizeLearning); },
          openLearningTools: ({ workspace, turnMemory, manageBeliefs }) => openLearningTools({
            db, turn: slotKey, workspace, maySend, manageBeliefs, authorize: authorizeLearning, trackRetention,
            ...(notion ? { notion } : {}),
            track(w) { keepLearningBasis(w); trackWorkspace(w, true); },
            async authorizeRemote() {
              try {
                return await confirmNotionRead(db, learner, async (tx, check) => {
                  await authorizeLearning(tx);
                  await notionSendBasis(tx, notionWitnesses.values(), maySend, check);
                  return true;
                });
              } catch (error) {
                if (error instanceof ChangedEvidence || isFactUnavailable(error) ||
                    error instanceof TeachingError || error instanceof LifecycleError) return false;
                throw error;
              }
            },
            onDelivered: turnMemory.onDelivered,
            saveBelief: (args, step) => turnMemory.execute('save_belief', args, step),
            async readContext(intent, step, expand, query) {
              const packet = await memoryGateway({ intent, maxBytes: expand ? 16_384 : 8192, beliefTools: true,
                ...(expand ? { expand } : {}), ...(query ? { query } : {}), owner: { kind: 'session', id: slotKey, step: 'context-v1:' + String(step) } }, false);
              if (!packet) return;
              if (intent === 'management') turnMemory.offerManagement(step, packet);
              packet.receipt.basis.forEach(keepLearningBasis);
              return packet.bundle;
            },
          }),
          parseClassroomReply: classroomReply,
          isMemoryConflict,
        },
      );
      if ((feedback as DisplayTurn & { carePause?: CarePauseSignal }).carePause)
        await carePause?.pause(job.slotKey);
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
            });
            if (!prior) throw new ChangedEvidence();
            prior.witnesses.forEach(trackNotion);
            trackFeedback(parent, prior.reply);
            return prior.reply.value;
          },
          readEvidenceRecord: async id => {
            const value = studyRecord(await read(sourceId(selected, id)));
            return { id, title: value.title, text: value.text };
          },
        },
      );
    }
    await settle(feedback, submission.allowBackgroundUnderstanding === true);
  } catch (error) {
    const failure = classifyTeachingFailure(error);
    if (!failure) throw error;
    await failTeachingWork(db, ref, job, failure);
  }
}

function failTeachingWork(db: Db, ref: WorkRef, job: {slotType: string; slotKey: string},
  error: {status: 'failed' | 'unknown'; message: string}) {
  return failWork(db, ref, async (tx, tick) => {
    await tx.query(
      `UPDATE slot_state SET last_error=$4,changed_tick=$5 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`,
      [tx.learner, job.slotType, job.slotKey, JSON.stringify(error), tick],
    );
    await completeTurnStream(tx, job.slotKey);
  });
}

export async function recordTerminalFailure(db: Db, ref: WorkRef) {
  const job = await readWork(db, ref);
  if (!job) return;
  await failTeachingWork(db, ref, job, {status:'failed', message:terminalRecoveryFailure});
}
