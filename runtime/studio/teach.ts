import { classroomReply } from '../../modules/activity/classroom.ts';
import { readClassroomMountEvidence } from './presentation-store.ts';
import { openLearningTools } from './learning-tools.ts';
import { attachmentCurrent } from './reading.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';
import { confirmNotionDispatch, confirmNotionRead, notionSendBasis, savedNotionWitnesses, teachingResultAuthority, type CheckNotionRead, type NotionRecipient } from './notion.ts';
import { ridingLesson, averageSpeed } from '../../modules/activity/starter.ts';
import { currentMemory, memoryId } from './memory.ts';
import { memoryScopeForObject, readMemoryGateway } from './memory-gateway.ts';
import { teachingMemoryBasis } from './memory-claims.ts';
import { isMemoryConflict, openTurnMemory } from './turn-memory.ts';
import { turnClaimWitness } from '../../modules/companion/claim.ts';
import { foregroundDigest } from './foreground-digest.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandReadContext, FactReadDeniedError, FactNotFoundError } from '../../kernel/src/commands/reads.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { factId, learnerId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { failWork, finishWork, readWork, readReadyWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { TeachingError } from '../../executors/teaching/index.ts';
import { ChangedEvidence, classifyTeachingFailure, terminalRecoveryFailure } from '../../executors/teaching/turn-errors.ts';
import { createTurnWitnessLedger } from '../../executors/teaching/turn-witness.ts';
import { createTeachingModelEffect } from '../../executors/teaching/turn-effect.ts';
import { executeCompanionTurn } from '../../executors/teaching/turn-companion.ts';
import {
  companionForegroundSummary, createTurnProgressHandler, prepareTeachingTurn, runIntroTeachingTurn,
} from '../../executors/teaching/turn-context.ts';
import { studyRecord, studyTurn } from '../../modules/activity/values.ts';
import { caseId, readOwnStudyTurn, readTeachingTurn, type DisplayTurn } from './sessions.ts';
import { jitWitnessesCurrent, prepareFirstTurnJit, studioJitCounter, type StudioJitCounter } from './first-turn-jit.ts';
import { turnTask } from './model-routes.ts';
import { workspaceGrantChecker, sameRoute, requiresAccountConfirmation, workspaceRouteRevision } from './harness.ts';
import type { ReadArtifactAssessmentWitness } from './artifact-assessment.ts';
import {openWorkspaceTools, workspaceInput, workspaceProofKey, type WorkspaceWitness} from './workspace-agent.ts';
import {readCurrentLearningObject, type OpenedCurrentLearningObject} from './current-learning-object.ts';
import {isWorkspaceAssessmentSlot, workspaceAssessmentBasis, type AssessmentSlot, type WorkspaceAssessmentBasis} from './workspace-read.ts';
import {isRadarRetentionSlot, readRetentionBasis, type RadarSlot, type RetentionBasis} from './learner-radar.ts';
import { checkProviderAccount, loadSettings } from './settings.ts';
import { completeTurnStream, publishTurnProgress } from './stream.ts';
import { companionReplyStartedLabel, companionReplyTrackingLabel, questionReceiptsCurrent } from './question-exposure.ts';
import { confirmedTeachingMethod, learningToolsMethod, notionModelRecipient, methodName, purpose, slotType, sourceId, stableId, studioLearner } from './identity.ts';

const hasTeachingModelEffect = async (tx: ReadTransaction, learner: ReturnType<typeof learnerId>, slotKey: string) =>
  Boolean((await tx.query(`SELECT 1 FROM effects WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND label='teaching-model' LIMIT 1`, [learner, slotKey])).rowCount);

export async function teach(db: Db, ref: WorkRef, readArtifactAssessmentWitness?: ReadArtifactAssessmentWitness,
  jitCounters: readonly StudioJitCounter[] = [],
  onTurnCompleted?: (tx: DbTransaction, tick: Tick, id: string) => Promise<void>) {
  if (ref.learner !== studioLearner) throw new Error('Unknown teaching scope');
  const job = await readWork(db, ref);
  if (!job) return;
  if (job.slotType !== slotType || ![methodName,confirmedTeachingMethod,learningToolsMethod].includes(job.deriver)) throw new Error('Unknown teaching method');
  const learner = learnerId(ref.learner), {slotKey} = job;
  const scope = { learner };
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
  async function readFact(tx: ReadTransaction, id: string, mode?: 'pinned' | 'following') {
    const fact = await createCommandReadContext(tx, purpose).fact(factId(id), {mode: 'following'});
    trackFact(id, fact, mode);
    return fact.value;
  }
  const read = (id: string) => db.snapshot(scope, (tx) => readFact(tx, id));
  const priorTurn = (id: string) => db.snapshot(scope, async tx => {
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
  async function checkWorkspaceRecipient() {
    if (!authorizeWorkspaceRecipient) throw new ChangedEvidence();
    await authorizeWorkspaceRecipient();
  }
  async function revalidateInputs(tx: ReadTransaction, use: 'publish' | 'dispatch' = 'publish') {
    if ((checkTurnAccount && !await checkTurnAccount()) || (attachmentOrigin && !await attachmentCurrent(tx, attachmentOrigin)))
      throw new ChangedEvidence();
    const pages = await notionSendBasis(tx,notionWitnesses.values(),maySend).catch(() => { throw new ChangedEvidence(); });
    if (liveMemoryRevision !== undefined && (await currentMemory(tx)).revision !== liveMemoryRevision) throw new ChangedEvidence();
    if (ledger.hasExpiredMemory(new Date().toISOString())) throw new ChangedEvidence();
    if (jit) {
      await checkWorkspaceRecipient();
      if (!await jitWitnessesCurrent(tx, jit.basis, maySend)) throw new ChangedEvidence();
    }
    if (currentObject || assessments.size || retention.size) {
      await checkWorkspaceRecipient();
      for (const {slot} of assessments.values()) if (!await workspaceAssessmentBasis(tx, slot, maySend)) throw new ChangedEvidence();
      for (const basis of retention.values()) {
        const actual = await readRetentionBasis(tx,basis.slot,{callerPurpose:purpose,maySend});
        if (!actual || canonicalJsonString(actual) !== canonicalJsonString(basis)) throw new ChangedEvidence();
      }
    }
    const { rows: [clock] } = await tx.query<{ tick: string }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [learner]);
    const manifest = parseManifest({ version: 1, learner, purpose, gatherTick: clock?.tick, inputs: [...inputs.values()] });
    if (!await teachingMemoryBasis(tx, manifest, slotKey, maySend) || !await questionReceiptsCurrent(tx,slotKey,use))
      throw new ChangedEvidence();
    return {manifest, pages};
  }
  const validInputs = async (tx: ReadTransaction) => (await revalidateInputs(tx)).manifest;
  async function validWorkInputs(tx: ReadTransaction, use?: 'publish' | 'dispatch') {
    if (!await readReadyWork(tx, ref)) throw new ChangedEvidence();
    return revalidateInputs(tx, use);
  }
  const settle = (feedback: DisplayTurn, optedIn: boolean) => finishWork(db, ref, async (tx, tick) => {
    const manifest = await validInputs(tx);
    const id = stableId('feedback', ref.learner, ref.workId, ref.generation);
    const sourceIds = ledger.sourceIdsForDigest(feedback.workspaceBasis, memoryId);
    const summary = companionForegroundSummary(feedback, sourceIds.length);
    const digest = summary ? foregroundDigest(job.slotKey, manifest, sourceIds, summary) : undefined;
    await tx.insert('derivations', {
      learner_id: learner, id, slot_type: slotType, slot_key: job.slotKey, deriver: job.deriver, scope_keys: '{}',
      value: JSON.stringify(digest ? { ...feedback, foregroundDigest: digest } : feedback),
      lifecycle: 'effective', freshness: 'current', gather_tick: manifest.gatherTick, effective_tick: tick,
      manifest: JSON.stringify(manifest), is_shadow: false,
    });
    await tx.query(
      'UPDATE slot_state SET current_id=$4,last_id=$4,changed_tick=$5,last_error=NULL WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
      [learner, slotType, job.slotKey, id, tick],
    );
    await completeTurnStream(tx, job.slotKey);
    if (optedIn) await onTurnCompleted?.(tx, tick, job.slotKey);
  });
  try {
    const turn = await db.snapshot(scope, tx => readTeachingTurn(tx, slotKey));
    trackFact(turn.ref.id, turn);
    const submission = studyTurn(turn.value);
    if (submission.memoryVersion === 1) memoryTurn = job.slotKey;
    const prepared = await prepareTeachingTurn(
      { submission, deriver: job.deriver, methodName, learningToolsMethod },
      {
        loadPriorTurn: priorTurn, requiresAccountConfirmation, resolveTask: turnTask,
        checkAttachmentCurrent: origin => db.snapshot(scope, tx => attachmentCurrent(tx, origin)),
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
      recordReplyStarted: async () => {
        await recordLocalRead(db, { ...scope, ownerKind: 'session', ownerId: slotKey, stepKey: 'replying',
          label: companionReplyStartedLabel, input: {} }, async () => 'possible', async tx => {
          if (!(await readReadyWork(tx, ref))) throw new ChangedEvidence();
        });
      },
      publishProgress: progress => publishTurnProgress(db, ref, job.slotKey, submission.sessionId, progress, validInputs),
    });
    const runModelEffect = createTeachingModelEffect<ReadTransaction, DbTransaction>({
      purpose, learningV1, settings, submission, grants, ledger,
      notionRecipientId: () => maySend.notionRecipientId,
      getJit: () => jit,
      getLearningMemoryContext: () => learningMemory?.context,
      loadSelected: () => db.snapshot(scope, tx => notionSendBasis(tx, notionWitnesses.values(), maySend)),
      confirmPages: async pages => {
        try { await confirmNotionDispatch(db, pages as Awaited<ReturnType<typeof notionSendBasis>>); }
        catch { throw new ChangedEvidence(); }
      },
      validWorkInputs,
      loadSettings: () => loadSettings(task),
      jitCounterFor: current => studioJitCounter(jitCounters, current),
      checkWorkspaceRoute,
      checkProviderAccount: tx => checkProviderAccount(tx, {
        providerId: submission.providerId ?? 'default', accountRevision: submission.accountRevision!,
      }, task),
      runEffect: (request, execute, authorize) =>
        runEffect(db, { learner, ownerKind: 'session', ownerId: slotKey, ...request }, execute, authorize),
      runDispatchTx: fn => db.tx(scope, async tx => { await lockLearner(tx, learner); return fn(tx); }),
      checkFreshEvidence: async () => { await db.snapshot(scope, validInputs); },
      isLifecycleError: error => error instanceof LifecycleError,
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
      feedback = await executeCompanionTurn(
        {
          slotKey: job.slotKey, slotType, submission, learningV1, memoryTurn, ledger,
          attachment: original.teaching ? origin.attachment : undefined,
          settings, grants, mcpServers, memoryId, ridingLesson, averageSpeed, onProgress, runEffect: runModelEffect,
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
            const items = [];
            for (const item of observed) {
              const basis = parseManifest(item.manifest).inputs;
              const notion = await db.snapshot(scope, tx => savedNotionWitnesses(tx, basis));
              let assessmentSlot: { slot_type: string; slot_key: string; derivationId: string } | undefined;
              if (item.assessment && 'derivationId' in item.assessment) {
                const { rows: [slot] } = await db.query<{ slot_type: string; slot_key: string }>(
                  'SELECT slot_type,slot_key FROM derivations WHERE learner_id=$1 AND id=$2', [learner, item.assessment.derivationId]);
                if (!slot) throw new ChangedEvidence();
                assessmentSlot = { ...slot, derivationId: item.assessment.derivationId };
              }
              items.push({ ...item, basis, notionWitnesses: notion, ...(assessmentSlot ? { assessmentSlot } : {}) });
            }
            return items;
          },
          getJitCounter: () => studioJitCounter(jitCounters, settings),
          prepareJit: async counter => {
            jit = await prepareFirstTurnJit(db, learner, job.slotKey, submission, settings, counter, { maySend, authorize: authorizeMemory });
            currentObject = jit?.current;
            return jit;
          },
          loadCurrentObject: async () => {
            await authorizeWorkspace();
            currentObject = await db.snapshot(scope, tx => readCurrentLearningObject(tx, submission.currentObject!, maySend));
            currentObject?.basis.forEach(trackNotion);
            return currentObject;
          },
          loadPreference: () => db.snapshot(scope, async tx => {
            const value = await currentMemory(tx);
            if (!value.text || value.endpoint !== settings.baseUrl || value.providerId !== settings.activeProviderId || value.protocol !== settings.protocol) return;
            await readFact(tx, memoryId, 'pinned');
            liveMemoryRevision = value.revision;
            const mem = inputs.get(memoryId);
            return { text: value.text, witness: mem?.kind === 'fact' ? { id: memoryId, rev: mem.rev, epoch: mem.accessEpoch, type: 'companion.memory' } : undefined };
          }),
          loadLearningMemory: async () => {
            const { rows: [prior] } = await db.query<{ has_sample: boolean; has_memory: boolean }>(
              `SELECT bool_or(label='teaching-model') AS has_sample, bool_or(label='local:learning-memory') AS has_memory
               FROM effects WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2`, [learner, job.slotKey]);
            if (prior?.has_sample && !prior.has_memory) return undefined;
            learningMemory = await readMemoryGateway({ ...memoryRequest(), maxBytes: 8192, owner: { kind: 'session', id: job.slotKey, step: 'memory' } });
            if (!learningMemory) throw new ChangedEvidence();
            trackMemory(learningMemory);
            return learningMemory;
          },
          expandLearningMemory: async (expand, step) => {
            expandedMemory = await readMemoryGateway({ ...memoryRequest(), maxBytes: 16_384, expand, owner: { kind: 'session', id: job.slotKey, step: `memory-region:${step}` } });
            if (expandedMemory) trackMemory(expandedMemory);
            return expandedMemory;
          },
          withHistoryRead: fn => confirmNotionRead(db, learner, (tx, check) => fn({
            readPriorTurn: async id => {
              const prior = await readTeachingTurn(tx, id).catch((error: unknown) => {
                if (error instanceof FactReadDeniedError && error.reason === 'purpose') return;
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
          readToolContract: (stepKey, tool, version) => recordLocalRead(db, { learner, ownerKind: 'session', ownerId: slotKey, stepKey,
            label: 'local:tool-contract', input: { tool } }, async tx => {
            return await hasTeachingModelEffect(tx, learner, slotKey) ? 'legacy' : version;
          }, authorizeMemory),
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
              const packet = await readMemoryGateway({ ...memoryRequest(), intent: 'management', maxBytes: 8192,
                ...(beliefTools ? { beliefTools } : {}), ...(query ? { query } : {}), owner: { kind: 'session', id: job.slotKey, step: 'retrieve-memory:' + step } });
              if (!packet) throw new ChangedEvidence();
              trackMemory(packet);
              return packet;
            },
          }),
          recordLearningTracking: async () => {
            await recordLocalRead(db, { ...scope, ownerKind: 'session', ownerId: slotKey,
              stepKey: 'replying', label: companionReplyTrackingLabel, input: {} },
              async tx => await hasTeachingModelEffect(tx, tx.learner, slotKey) ? 'unknown' : 'tracked', authorizeLearning);
          },
          openLearningTools: ({ workspace, turnMemory, manageBeliefs }) => openLearningTools({
            db, turn: slotKey, workspace, maySend, manageBeliefs, authorize: authorizeLearning, trackRetention,
            track(w) { keepLearningBasis(w); trackWorkspace(w, true); },
            async authorizeRemote() {
              try {
                return await confirmNotionRead(db, learner, async (tx, check) => {
                  await authorizeLearning(tx);
                  await notionSendBasis(tx, notionWitnesses.values(), maySend, check);
                  return true;
                });
              } catch (error) {
                if (error instanceof ChangedEvidence || error instanceof FactReadDeniedError || error instanceof FactNotFoundError ||
                    error instanceof TeachingError || error instanceof LifecycleError) return false;
                throw error;
              }
            },
            onDelivered: turnMemory.onDelivered,
            saveBelief: (args, step) => turnMemory.execute('save_belief', args, step),
            async readContext(intent, step, expand, query) {
              const packet = await readMemoryGateway({ ...memoryRequest(), intent, maxBytes: expand ? 16_384 : 8192, beliefTools: true,
                ...(expand ? { expand } : {}), ...(query ? { query } : {}), owner: { kind: 'session', id: slotKey, step: 'context-v1:' + String(step) } });
              if (!packet) return;
              if (intent === 'management') turnMemory.offerManagement(step, packet);
              packet.receipt.basis.forEach(keepLearningBasis);
              trackMemory(packet);
              return packet.bundle;
            },
          }),
          parseClassroomReply: classroomReply,
          isMemoryConflict,
        },
      );
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
