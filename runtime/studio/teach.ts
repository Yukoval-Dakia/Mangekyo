import { classroomReply } from '../../modules/activity/classroom.ts';
import { readClassroomMountEvidence } from './presentation-store.ts';
import { attachmentCurrent } from './reading.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';
import { confirmNotionDispatch, confirmNotionRead, notionSendBasis, savedNotionWitnesses, teachingResultAllowed, type CheckNotionRead, type NotionRecipient } from './notion.ts';
import { providerEndpoint } from '../../executors/teaching/provider.ts';
import {learningToolError} from '../../executors/teaching/tool-error.ts';
import { createHash } from 'node:crypto';
import { ridingLesson, averageSpeed } from '../../modules/activity/starter.ts';
import { currentMemory, memoryId } from './memory.ts';
import { memoryScopeForObject, readMemoryGateway } from './memory-gateway.ts';
import { areMemoryClaimsCurrent } from './memory-claims.ts';
import { isMemoryConflict, openTurnMemory } from './turn-memory.ts';
import { claimType } from '../../modules/companion/claim.ts';
import { foregroundDigest } from './foreground-digest.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { derivationId, factId, learnerId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { parseManifest, type ManifestInput } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import {
  failWork,
  finishWork,
  readWork,
  readReadyWork,
  runEffect,
  type WorkRef,
} from '../../kernel/src/work/index.ts';
import {
  runCompanionTurn,
  runTeachingTurn,
  first45Answer,
  first45Diagnostic,
  first45Histories,
  first45Question,
  TeachingError,
  type CompanionMessage,
  type TeachingDependencies,
  type TeachingDispatch,
  type TeachingResponse,
} from '../../executors/teaching/index.ts';
import { studyRecord, studyTurn } from '../../modules/activity/values.ts';
import { caseId, type DisplayTurn } from './sessions.ts';
import { jitWitnessesCurrent, prepareFirstTurnJit, studioJitCounter, type StudioJitCounter } from './first-turn-jit.ts';
import { turnTask } from './model-routes.ts';
import { workspaceGrantChecker, sameRoute, requiresAccountConfirmation, resolveMcpGrants, workspaceRouteRevision, mcpRevision } from './harness.ts';
import type { ReadArtifactAssessmentWitness } from './artifact-assessment.ts';
import {openWorkspaceTools, workspaceInput, type WorkspaceWitness} from './workspace-agent.ts';
import {readCurrentLearningObject, type OpenedCurrentLearningObject} from './current-learning-object.ts';
import {isWorkspaceAssessmentSlot, workspaceAssessmentBasis, type AssessmentSlot, type WorkspaceAssessmentBasis} from './workspace-read.ts';
import {isRadarRetentionSlot, readRetentionBasis, type RadarSlot, type RetentionBasis} from './learner-radar.ts';
import { checkProviderAccount, loadSettings } from './settings.ts';
import { completeTurnStream, publishTurnProgress } from './stream.ts';
import { confirmedTeachingMethod, notionModelRecipient, methodName, purpose, slotType, sourceId, stableId, studioLearner } from './identity.ts';

class UncertainEffect extends Error {
  constructor(requestId: string | null) {
    super('提供方的执行结果待核对，本轮已停止自动调用。' + (requestId ? '请求标识 ' + requestId : ''));
  }
}
class ChangedEvidence extends Error {}

export async function teach(db: Db, ref: WorkRef, readArtifactAssessmentWitness?: ReadArtifactAssessmentWitness,
  jitCounters: readonly StudioJitCounter[] = []) {
  if (ref.learner !== studioLearner) throw new Error('Unknown teaching scope');
  const job = await readWork(db, ref);
  if (!job) return;
  if (job.slotType !== slotType || (job.deriver !== methodName && job.deriver !== confirmedTeachingMethod)) throw new Error('Unknown teaching method');
  const learner = learnerId(ref.learner);
  const scope = { learner };
  const inputs = new Map<string, ManifestInput>();
  const assessments = new Map<string, WorkspaceAssessmentBasis>();
  const retention = new Map<string, RetentionBasis>();
  let protectWorkspaceDispatch = false;
  let currentObject: OpenedCurrentLearningObject | undefined;
  let jit: Awaited<ReturnType<typeof prepareFirstTurnJit>>;
  let liveMemoryRevision: number | undefined;
  let learningMemory: Awaited<ReturnType<typeof readMemoryGateway>>;
  let expandedMemory: typeof learningMemory;
  const memoryPackets: NonNullable<typeof learningMemory>[] = [];
  const memoryHeads = new Set<string>();
  let memoryTurn: string | undefined;
  let checkTurnAccount: (() => Promise<boolean>) | undefined;
  let attachmentOrigin: ReturnType<typeof studyTurn> | undefined;
  let authorizeWorkspaceRecipient: (() => Promise<void>) | undefined;
  const notionWitnesses = new Map<string,WorkspaceWitness>();
  const trackNotion = (w: WorkspaceWitness) => {
    if (w.type === 'capture.source') notionWitnesses.set(w.id + ':' + w.rev,w);
  };
  const maySend: NotionRecipient = (fact: FactSnapshot) => fact.type !== 'companion.memory' || fact.ref.rev === liveMemoryRevision;
  function trackAssessment(basis: WorkspaceAssessmentBasis) {
    const {slot, facts} = basis;
    assessments.set(slot.derivationId, basis);
    inputs.set('assessment:' + slot.derivationId, slot);
    for (const fact of facts) {
      inputs.set(`assessment-fact:${fact.id}:${fact.rev}:${fact.accessEpoch}:${fact.mode}`, fact);
    }
  }
  function trackRetention(basis: RetentionBasis) {
    const {slot, facts} = basis;
    retention.set(slot.derivationId, basis);
    inputs.set('retention:' + slot.derivationId, slot);
    for (const fact of facts) inputs.set(`retention-fact:${fact.id}:${fact.rev}:${fact.accessEpoch}:${fact.mode}`, fact);
  }
  function trackFact(id: string, fact: Pick<FactSnapshot,'ref'|'accessEpoch'>, mode: 'pinned' | 'following' = 'following') {
    inputs.set(id, {
      kind: 'fact',
      id: fact.ref.id,
      rev: fact.ref.rev,
      accessEpoch: fact.accessEpoch,
      mode,
    });
  }
  async function readFact(tx: ReadTransaction, id: string, mode: 'pinned' | 'following' = 'following') {
    const fact = await createCommandReadContext(tx, purpose).fact(factId(id), {mode:'following'});
    trackFact(id, fact, mode);
    return fact.value;
  }
  const read = (id: string) => db.snapshot(scope, (tx) => readFact(tx, id));

  async function readFeedback(tx: ReadTransaction, id: string, check: CheckNotionRead) {
    const {
      rows: [row],
    } = await tx.query<{ id: string; value: DisplayTurn; manifest: unknown }>(
      `SELECT d.id, d.value, d.manifest FROM slot_state s JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3
       AND NOT EXISTS (
         SELECT 1 FROM effects e WHERE e.learner_id=$1 AND e.owner_kind='session' AND e.owner_id=$3
           AND e.label='local:python_attempts'
           AND ((e.result #>> '{}')::jsonb->>'pythonAttemptsProjection') IS DISTINCT FROM '1')`,
      [learner, slotType, id],
    );
    if (!row) return;
    const prior = await createCommandReadContext(tx, purpose).fact(factId(id), {mode: 'following'});
    if (prior.type === 'activity.studyTurn' &&
        await teachingResultAllowed(tx, studyTurn(prior.value), row.manifest, workspaceGrantChecker(), check)) return row;
    return undefined;
  }
  function trackFeedback(id: string, replyId: string) {
    inputs.set('feedback:' + id, { kind: 'slot', slotType, slotKey: id, derivationId: derivationId(replyId), mode: 'following' });
  }
  async function validInputs(tx: ReadTransaction) {
    if ((checkTurnAccount && !await checkTurnAccount()) || (attachmentOrigin && !await attachmentCurrent(tx, attachmentOrigin)))
      throw new ChangedEvidence();
    try { await notionSendBasis(tx,notionWitnesses.values(),maySend); } catch { throw new ChangedEvidence(); }
    if (liveMemoryRevision !== undefined && (await currentMemory(tx)).revision !== liveMemoryRevision) throw new ChangedEvidence();
    const now = new Date().toISOString();
    if (memoryPackets.some(item => item.receipt.expiresAt && item.receipt.expiresAt <= now) ||
        !await areMemoryClaimsCurrent(tx, [...memoryHeads], memoryTurn)) throw new ChangedEvidence();
    if (jit) {
      if (!authorizeWorkspaceRecipient) throw new ChangedEvidence();
      await authorizeWorkspaceRecipient();
      if (!await jitWitnessesCurrent(tx, jit.basis, maySend)) throw new ChangedEvidence();
    }
    if (currentObject || assessments.size || retention.size) {
      if (!authorizeWorkspaceRecipient) throw new ChangedEvidence();
      await authorizeWorkspaceRecipient();
      for (const {slot} of assessments.values()) {
        if (!await workspaceAssessmentBasis(tx, slot, maySend)) throw new ChangedEvidence();
      }
      for (const basis of retention.values()) {
        const actual = await readRetentionBasis(tx,basis.slot,{callerPurpose:purpose,maySend});
        if (!actual || canonicalJsonString(actual) !== canonicalJsonString(basis)) throw new ChangedEvidence();
      }
    }
    const {
      rows: [clock],
    } = await tx.query<{ tick: string }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [learner]);
    const manifest = parseManifest({
      version: 1,
      learner,
      purpose,
      gatherTick: clock?.tick,
      inputs: [...inputs.values()],
    });
    if ((await revalidateManifest(tx, manifest)).kind !== 'valid') throw new ChangedEvidence();
    return manifest;
  }
  const settle = (feedback: DisplayTurn) => finishWork(db, ref, async (tx, tick) => {
    const manifest = await validInputs(tx);
    const id = stableId('feedback', ref.learner, ref.workId, ref.generation);
    const sourceIds = [...(feedback.workspaceBasis ?? []).filter(item => item.id !== memoryId),
      ...memoryPackets.flatMap(packet => packet.receipt.sent)].map(item => item.id);
    const digest = feedback.action === 'companion_reply' && feedback.completion !== 'receipts_only'
      ? foregroundDigest(job.slotKey, manifest, sourceIds, feedback.studyKit ? '本轮完成讲义和练习。'
        : feedback.writes?.length ? '本轮完成伴学回复并保存工作区变更。'
        : sourceIds.length ? '本轮依据已授权的学习记录给出伴学回复。' : '本轮完成一次伴学回复。') : undefined;
    await tx.insert('derivations', {
      learner_id: learner,
      id,
      slot_type: slotType,
      slot_key: job.slotKey,
      deriver: job.deriver,
      scope_keys: '{}',
      value: JSON.stringify(digest ? { ...feedback, foregroundDigest: digest } : feedback),
      lifecycle: 'effective',
      freshness: 'current',
      gather_tick: manifest.gatherTick,
      effective_tick: tick,
      manifest: JSON.stringify(manifest),
      is_shadow: false,
    });
    await tx.query(
      'UPDATE slot_state SET current_id=$4,last_id=$4,changed_tick=$5,last_error=NULL WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
      [learner, slotType, job.slotKey, id, tick],
    );
    await completeTurnStream(tx, job.slotKey);
  });
  try {
    const submission = studyTurn(await read(job.slotKey));
    if (submission.memoryVersion === 1) memoryTurn = job.slotKey;
    const origin = submission.parentId ? studyTurn(await read(submission.sessionId)) : submission;
    const guarded = requiresAccountConfirmation(origin) || requiresAccountConfirmation(submission);
    if (guarded !== (job.deriver === confirmedTeachingMethod) ||
        (guarded && (!origin.accountConfirmation || !submission.accountConfirmation))) throw new ChangedEvidence();
    const task = turnTask(submission.caseId, origin.attachment?.mode === 'prepare');
    if (origin.attachment) {
      if (!origin.accountRevision || submission.accountRevision !== origin.accountRevision)
        throw new TeachingError('provider_configuration', '请重新选择材料并确认发送账户。');
      attachmentOrigin = origin;
      if (!await db.snapshot(scope, tx => attachmentCurrent(tx, origin))) throw new ChangedEvidence();
    }
    const settings = await loadSettings(task);
    if (submission.accountRevision) checkTurnAccount = async () => sameRoute(submission,await loadSettings(task));
    if (!sameRoute(submission, settings))
      throw new TeachingError('provider_configuration', '本轮绑定的模型配置已变更，请切回原配置或新建对话。');
    const checkWorkspaceRoute = async (current = settings) => {
      if (await workspaceRouteRevision(current) !== submission.workspaceRevision)
        throw new TeachingError('provider_configuration', '这个模型的学习工作区访问已关闭。请开始新会话。');
    };
    if (submission.workspaceRevision) {
      await checkWorkspaceRoute();
      maySend.notionRecipientId = notionModelRecipient(settings.activeProviderId,settings.baseUrl,settings.protocol,settings.model,submission.workspaceRevision);
    }
    const authorizeWorkspace = authorizeWorkspaceRecipient = async () => {
      const current = await loadSettings(task);
      if (!submission.workspaceRevision || !sameRoute(submission, current) || current.apiKey !== settings.apiKey ||
          await workspaceRouteRevision(current) !== submission.workspaceRevision) throw new ChangedEvidence();
    };
    const grants = submission.mcpGrants ?? [];
    function checkMcpAccess(current: typeof settings) {
      const servers = resolveMcpGrants(grants, current);
      if (grants.length && submission.mcpRevision !== mcpRevision(grants, current))
        throw new TeachingError('provider_configuration', 'MCP 服务凭证已变更，请重新选择工具并发送。');
      return servers;
    }
    const mcpServers = checkMcpAccess(settings);
    if (submission.parentId) {
      const previous = studyTurn(await read(submission.parentId));
      if (!sameRoute(origin, settings) || !sameRoute(previous, settings))
        throw new TeachingError('provider_configuration', '此对话使用过不同端点，请新建对话。');
    }
    const onProgress: NonNullable<TeachingDependencies['onProgress']> = async (progress) => {
      try {
        await publishTurnProgress(db, ref, job.slotKey, submission.sessionId, progress, validInputs);
      } catch (error) {
        if (error instanceof ChangedEvidence) throw error;
        // The evidence and completed effect are authoritative, including while
        // the optional stream storage is unavailable.
        console.warn('本轮进度暂不可用。');
      }
    };
    async function confirmPages(pages: Awaited<ReturnType<typeof notionSendBasis>>) {
      try { await confirmNotionDispatch(db,pages); } catch { throw new ChangedEvidence(); }
    }
    const runModelEffect: TeachingDependencies['runEffect'] = async (step, invoke) => {
      const selected = notionWitnesses.size ? await db.snapshot(scope, tx => notionSendBasis(tx,notionWitnesses.values(),maySend)) : [];
      const selectionReceipt = selected.map(({selection,pageId,watermark}) => ({
        selectionId:selection.id, generation:selection.selectionEpoch, pageId, watermark, purpose, recipient:maySend.notionRecipientId!,
      }));
      const memorySend = step.learningMemory && learningMemory?.context ? {
        purpose, recipient: { id: settings.activeProviderId, endpoint: step.provider, protocol: settings.protocol,
          model: step.model, workspaceRevision: submission.workspaceRevision! },
        requestDigest: step.requestDigest, fragments: memoryPackets.flatMap(packet => packet.receipt.sent),
      } : undefined;
      const authorize = async (tx: ReadTransaction, current?: typeof settings) => {
        if (!(await readReadyWork(tx, ref))) throw new ChangedEvidence();
        await validInputs(tx);
        if (selected.length && (step.provider !== providerEndpoint(settings) || step.model !== settings.model ||
            JSON.stringify(selected) !== JSON.stringify(await notionSendBasis(tx,notionWitnesses.values(),maySend)))) throw new ChangedEvidence();
        current ??= await loadSettings(task);
        if (!sameRoute(submission, current)) throw new ChangedEvidence();
        if (step.jitContext) {
          const counter = studioJitCounter(jitCounters, current);
          if (!jit || counter?.id !== submission.jitCounterId || counter?.endpoint !== step.provider ||
              counter?.model !== step.model) throw new ChangedEvidence();
        }
        if (!step.provider.startsWith('tool:') && current.apiKey !== settings.apiKey) throw new ChangedEvidence();
        if (step.provider === 'tool:exa_search' && (!current.allowSearch || current.exaApiKey !== settings.exaApiKey)) throw new ChangedEvidence();
        if (grants.length) checkMcpAccess(current);
        if (submission.workspaceRevision) await checkWorkspaceRoute(current);
      };
      let dispatchDenied: ChangedEvidence | TeachingError | LifecycleError | undefined;
      const mcp = step.provider.startsWith('tool:mcp:');
      const needsFreshEvidence = Boolean(jit || notionWitnesses.size || protectWorkspaceDispatch || assessments.size || retention.size || memorySend);
      const effect = await runEffect(
        db,
        {
          learner,
          ownerKind: 'session',
          ownerId: job.slotKey,
          stepKey: String(step.index),
          label: step.provider.startsWith('tool:') ? step.provider : 'teaching-model',
          input: { digest: step.requestDigest, provider: step.provider, model: step.model,
            ...(step.jitContext && jit ? {jitBasis: jit.receipt} : {}),
            ...(selectionReceipt.length ? {notionBasis:selectionReceipt} : {}),
            ...(memorySend ? { memoryBasis: memoryPackets.flatMap(packet => packet.receipt.basis) } : {}),
            ...(assessments.size ? {assessmentBasis: [...assessments.values()]} : {}),
            ...(retention.size ? {retentionBasis: [...retention.values()]} : {}) },
        },
        async (requestId, checkDispatch) => {
          const dispatch: TeachingDispatch = async send => {
            try {
              if (selected.length) await confirmPages(selected);
              // Start the transport under the same lock as the reservation and
              // current authority check. The response wait is outside it.
              const { response } = await db.tx(scope, async tx => {
                await lockLearner(tx, learner);
                await checkDispatch(tx);
                const current = submission.accountRevision ? await checkProviderAccount(tx,{
                  providerId:submission.providerId ?? 'default',accountRevision:submission.accountRevision,
                },task) : undefined;
                if (submission.accountRevision && !current) throw new ChangedEvidence();
                await authorize(tx,current);
                const response = send();
                void response.catch(() => {});
                return { response };
              });
              return response;
            } catch (error) {
              if (error instanceof ChangedEvidence || error instanceof TeachingError || error instanceof LifecycleError)
                dispatchDenied = error;
              throw error;
            }
          };
          try {
            // A resumed MCP call may authenticate and negotiate before sending tool arguments.
            const reply = await (mcp || step.jitContext ? invoke(requestId, dispatch) :
              dispatch(() => invoke(requestId)));
            return memorySend ? { reply, sent: { ...memorySend, requestId } } : reply;
          } catch (error) {
            console.warn('模型调用未能确认', requestId, error instanceof TeachingError ? error.code : 'transport_error');
            throw error;
          }
        },
        authorize,
      ).catch(error => {
        if (error instanceof LifecycleError) throw new ChangedEvidence();
        throw error;
      });
      if (dispatchDenied) throw dispatchDenied instanceof LifecycleError ? new ChangedEvidence() : dispatchDenied;
      if (selected.length) await confirmPages(selected);
      if (needsFreshEvidence) await db.snapshot(scope, validInputs);
      if (effect.kind === 'unknown') throw new UncertainEffect(effect.providerEffectId);
      if (memorySend && effect.result && typeof effect.result === 'object' && !Array.isArray(effect.result) &&
          'reply' in effect.result && typeof effect.result.reply === 'string') return effect.result.reply;
      if (typeof effect.result !== 'string') throw new Error('Invalid stored model response');
      return effect.result;
    };

    let feedback: DisplayTurn;
    if (submission.caseId === 'companion' || submission.caseId === 'riding') {
      let answer = submission.answer;
      if (!answer) throw new TeachingError('invalid_input', '请输入有效的学习问题。');
      const classroom = submission.classroom;
      if (classroom?.mode === 'adjust') {
        const observed = await confirmNotionRead(db, learner, async (tx, check) => {
          const result = [];
          for (const ref of classroom.evidence) {
            const item = await readClassroomMountEvidence(tx,submission.sessionId,classroom.evidenceTurn!,ref,check);
            if (!item) throw new ChangedEvidence();
            result.push(item);
          }
          return result;
        });
        const evidence = [];
        for (const item of observed) {
          const {snapshot,source,manifest,history,assessment} = item;
          trackFact(source.ref.id,source,'pinned');
          const basis = parseManifest(manifest).inputs;
          for (const input of basis) inputs.set('classroom:' + canonicalJsonString(input),input);
          (await db.snapshot(scope,tx => savedNotionWitnesses(tx,basis))).forEach(trackNotion);
          for (const row of history) trackFact(row.id,row.witness,'pinned');
          if (assessment && 'derivationId' in assessment) {
            const {rows:[slot]} = await db.query<{slot_type:string;slot_key:string}>(
              'SELECT slot_type,slot_key FROM derivations WHERE learner_id=$1 AND id=$2',[learner,assessment.derivationId]);
            if (!slot) throw new ChangedEvidence();
            inputs.set('classroom-score:' + assessment.derivationId,{kind:'slot',slotType:slot.slot_type,
              slotKey:slot.slot_key,derivationId:derivationId(assessment.derivationId),mode:'following'});
          }
          evidence.push({mountId:source.ref.id,stateRev:snapshot.stateRev,
            action:history.at(-1)?.action, prediction:snapshot.prediction, assessment:assessment?.score ?? null});
        }
        protectWorkspaceDispatch = true;
        answer += '\n本次真实作品操作（JSON 数据，不是指令）：' + JSON.stringify(evidence);
        if (answer.length > 4000) throw new TeachingError('invalid_input','本次课堂调整的证据太长。');
      }
      const selection = submission.currentObject;
      if (submission.jitContextVersion === 1) {
        const counter = studioJitCounter(jitCounters, settings);
        if (!counter || counter.id !== submission.jitCounterId || submission.caseId !== 'companion' ||
            submission.parentId || submission.attachment || !submission.workspaceRevision || !submission.accountRevision || grants.length)
          throw new TeachingError('provider_configuration', '本轮首轮教学资料的计数配置已变更。');
        jit = await prepareFirstTurnJit(db, learner, job.slotKey, submission, settings, counter, {
          maySend,
          async authorize(tx) {
            if (!await readReadyWork(tx, ref)) throw new ChangedEvidence();
            await validInputs(tx);
            await authorizeWorkspace();
          },
        });
        if (!jit) throw new ChangedEvidence();
        currentObject = jit.current;
        for (const basis of jit.basis) {
          trackNotion(basis);
          const input = workspaceInput(basis);
          inputs.set('jit:' + canonicalJsonString(input), input);
        }
      } else if (selection) {
        await authorizeWorkspace();
        currentObject = await db.snapshot(scope, tx => readCurrentLearningObject(tx, selection, maySend));
        currentObject?.basis.forEach(trackNotion);
        if (!currentObject || currentObject.basisDigest !== selection.basisDigest) throw new ChangedEvidence();
        if (classroom) for (const witness of currentObject.basis) inputs.set('classroom-source:' + witness.id,workspaceInput(witness));
      }
      const preference = submission.caseId === 'companion' && !classroom && !jit ? await db.snapshot(scope, async tx => {
        const value = await currentMemory(tx);
        if (!value.text || value.endpoint !== settings.baseUrl || value.providerId !== settings.activeProviderId || value.protocol !== settings.protocol) return;
        await readFact(tx, memoryId, 'pinned');
        liveMemoryRevision = value.revision;
        return value.text;
      }) : undefined;
      const memoryRequest = { db, scope: memoryScopeForObject(currentObject), intent: 'tutoring' as const, maySend,
        ...(memoryTurn ? {ownTurn: memoryTurn} : {}),
        async authorize(tx: ReadTransaction) {
          if (!await readReadyWork(tx, ref)) throw new ChangedEvidence();
          await validInputs(tx);
          await authorizeWorkspace();
        } };
      function trackMemory(packet: NonNullable<typeof learningMemory>) {
        memoryPackets.push(packet);
        for (const entry of packet.receipt.basis) {
          trackNotion(entry);
          inputs.set('learning-memory:' + entry.id + ':' + entry.rev, workspaceInput(entry));
          if (entry.type === claimType) memoryHeads.add(entry.id);
        }
      }
      if (submission.caseId === 'companion' && !classroom && submission.workspaceRevision && !grants.length && !jit) {
        const { rows: [prior] } = await db.query<{ has_sample: boolean; has_memory: boolean }>(
          `SELECT bool_or(label='teaching-model') AS has_sample, bool_or(label='local:learning-memory') AS has_memory
           FROM effects WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2`, [learner, job.slotKey],
        );
        // Preserve the payload of turns already journaled by a previous worker build.
        if (!prior?.has_sample || prior.has_memory) {
          learningMemory = await readMemoryGateway({ ...memoryRequest, maxBytes: 8192,
            owner: { kind: 'session', id: job.slotKey, step: 'memory' } });
          if (!learningMemory) throw new ChangedEvidence();
          trackMemory(learningMemory);
        }
      }
      const learningMemoryDigest = learningMemory?.context ? learningMemory.receipt.digest : undefined;
      const inherited = new Map<string, WorkspaceWitness>();
      // Only the revalidated projection may register evidence for this turn.
      const history = await confirmNotionRead(db, learner, async (tx, check) => {
        let historyNotice = '';
        const priorBasis = new Map<string, WorkspaceWitness>();
        const retain: (() => void)[] = [];
        const messages: CompanionMessage[] = [];
        const reader = createCommandReadContext(tx, purpose);
        const coveredReplies = new Set<string>();
        let previousId = submission.parentId;
        let historyBytes = 0;
        const historyLimit = submission.workspaceRevision ? 32 : 3;
        for (let count = 0; previousId && count < historyLimit; count++) {
          const prior = await reader.fact(factId(previousId), {mode:'following'});
          const previous = studyTurn(prior.value);
          retain.push(() => trackFact(prior.ref.id, prior));
          if (previous.sessionId !== submission.sessionId || previous.caseId !== submission.caseId || !sameRoute(previous, settings) || !previous.answer) {
            throw new ChangedEvidence();
          }
          // Legacy overview replies can lack workspaceBasis. The saved route still bounds their reuse.
          if (previous.workspaceRevision && previous.workspaceRevision !== submission.workspaceRevision) {
            historyNotice = '工作区授权已变更，本轮省略了使用旧授权的对话。';
            break;
          }
          if (previous.mcpGrants?.length && (!previous.mcpRevision || previous.mcpRevision !== submission.mcpRevision ||
              JSON.stringify(previous.mcpGrants) !== JSON.stringify(grants))) {
            historyNotice = '本轮的工具授权已变化，旧工具回复已省略。';
            break;
          }
          const reply = await readFeedback(tx, previousId, check);
          if (!reply) {
            historyNotice = '旧回复的依据已变更，本轮从当前消息继续。';
            break;
          }
          const {value: response, manifest} = reply;
          if (response.memoryManagement) {
            historyNotice = '记忆管理已结束，本轮使用当前获准的记忆。';
            break;
          }
          if (response.action === 'memory_claim') {
            previousId = previous.parentId;
            continue;
          }
          historyBytes += Buffer.byteLength(previous.answer) + Buffer.byteLength(response.message);
          if (submission.workspaceRevision && count > 0 && historyBytes > 12 * 1024) break;
          const priorMemory = response.reads.find(item => item.id === memoryId);
          if (priorMemory && priorMemory.text !== preference) break;
          if (response.learningMemoryDigest && response.learningMemoryDigest !== learningMemoryDigest) {
            historyNotice = '记忆范围或依据已变更，本轮从当前学习记录继续。';
            break;
          }
          const previousInputs = parseManifest(manifest).inputs;
          const assessmentSlots = previousInputs.filter((input): input is AssessmentSlot =>
            input.kind === 'slot' && isWorkspaceAssessmentSlot(input.slotType));
          const retentionSlots = previousInputs.filter((input): input is RadarSlot =>
            input.kind === 'slot' && isRadarRetentionSlot(input.slotType));
          const notion = await savedNotionWitnesses(tx, previousInputs);
          if (response.workspaceBasis?.length || assessmentSlots.length || retentionSlots.length || notion.length) {
            if (!submission.workspaceRevision || previous.workspaceRevision !== submission.workspaceRevision) {
              historyNotice = '工作区授权已变更，本轮省略了使用旧授权的对话。';
              break;
            }
            const witnesses: WorkspaceWitness[] = [...response.workspaceBasis ?? [], ...notion];
            if (new Set([...priorBasis.keys(), ...witnesses.map(w => `${w.id}:${w.rev}`)]).size > 48) {
              historyNotice = '较早的学习记录可按需重新检索，本轮从最近的对话继续。';
              break;
            }
            for (const slot of assessmentSlots) {
              const basis = await workspaceAssessmentBasis(tx, slot, maySend);
              if (!basis) throw new ChangedEvidence();
              retain.push(() => trackAssessment(basis));
            }
            for (const slot of retentionSlots) {
              const basis = await readRetentionBasis(tx,slot,{callerPurpose:purpose,maySend});
              if (!basis) throw new ChangedEvidence();
              retain.push(() => trackRetention(basis));
            }
            try { await notionSendBasis(tx,witnesses,maySend,check); }
            catch { historyNotice = '选源或接收人授权已变化，本轮省略了旧回复。'; break; }
            retain.push(() => witnesses.forEach(trackNotion));
            for (const witness of witnesses) {
              const w = 'image' in witness && witness.image === true ? {...witness,writeBasis:true as const} : witness;
              const key = `${w.id}:${w.rev}`;
              const newer = priorBasis.get(key);
              if (!newer || (w.jitBasis && !newer.jitBasis) || (w.writeBasis && !newer.writeBasis))
                priorBasis.set(key, {...newer,...w});
            }
          }
          // A reply can reenter history after an intervening turn omitted it.
          // Its witness is needed unless an admitted reply already tracks it.
          if (!coveredReplies.has(reply.id)) retain.push(() => trackFeedback(prior.ref.id, reply.id));
          for (const input of previousInputs) {
            if (input.kind === 'slot' && input.slotType === slotType && input.mode === 'following')
              coveredReplies.add(input.derivationId);
          }
          messages.unshift({ role: 'user', content: previous.answer }, { role: 'assistant', content: response.message });
          previousId = previous.parentId;
        }
        return {messages, historyNotice, retain, priorBasis};
      });
      const {messages: publicHistory, historyNotice} = history;
      history.retain.forEach(keep => keep());
      history.priorBasis.forEach((w, key) => inherited.set(key, w));
      if (inherited.size) protectWorkspaceDispatch = true;
      await onProgress({ phase: 'thinking' });
      const { title, distanceKm, movingMinutes, stoppedMinutes } = ridingLesson;
      const attachment = origin.attachment;
      const material = submission.caseId === 'riding'
        ? `《${title}》：全程 ${distanceKm} 公里，移动 ${movingMinutes} 分钟，停车 ${stoppedMinutes} 分钟。移动均速 ${averageSpeed(distanceKm, movingMinutes)} 公里/小时，全程均速 ${averageSpeed(distanceKm, movingMinutes + stoppedMinutes)} 公里/小时。`
        : attachment ? `《${attachment.title}》\n${attachment.text}` : undefined;
      const publicSearchQuery = /(?:^|\n)公开检索[：:]([^\n]{1,400})(?:\n|$)/u.exec(answer)?.[1]?.trim();
      const privateContext = Boolean(material || preference || publicHistory.length || submission.workspaceRevision);
      if (preference && liveMemoryRevision !== undefined) {
        const w = inputs.get(memoryId);
        if (w?.kind === 'fact') inherited.set(`${memoryId}:${w.rev}`, {id: memoryId, rev: w.rev, epoch: w.accessEpoch, type: 'companion.memory'});
      }
      const turnInput = inputs.get(job.slotKey);
      const workspace = (classroom ? classroom.mode !== 'adjust' : submission.workspaceRevision) ? openWorkspaceTools({
        db, turn: job.slotKey, presentationManifest:validInputs, readArtifactAssessmentWitness, prior: [...inherited.values()], currentObject,
        maySend,
        ...(jit ? {jitBasis:jit.basis} : {}),
        pageBasis: [
          ...(turnInput?.kind === 'fact' ? [{id:turnInput.id,rev:turnInput.rev,epoch:turnInput.accessEpoch,type:'activity.studyTurn'}] : []),
          ...(learningMemory?.receipt.basis ?? []),
          ...(jit?.basis ?? []),
        ],
        track(w, checkAtDispatch) {
          trackNotion(w);
          inputs.set('workspace:' + w.id + ':' + w.rev, workspaceInput(w));
          if (checkAtDispatch) protectWorkspaceDispatch = true;
        },
        trackAssessment, trackRetention, trackDiagnosis() { protectWorkspaceDispatch = true; },
        async authorize(tx) {
          if (!await readReadyWork(tx, ref)) throw new ChangedEvidence();
          await validInputs(tx);
          if (!sameRoute(submission, await loadSettings(task))) throw new ChangedEvidence();
          if (submission.workspaceRevision) await checkWorkspaceRoute();
        },
      }) : undefined;
      // Claim commands only bind the learner quote and optional object scope.
      // They cannot preserve the independent sources included in a JIT frame.
      const hasJitBasis = Boolean(jit?.basis.length || [...inherited.values()].some(w => w.jitBasis));
      const turnMemory = memoryTurn && !hasJitBasis && (learningMemory || jit) && turnInput?.kind === 'fact' ? openTurnMemory({
        db, turn: memoryTurn, answer, source: turnInput, ...(currentObject ? {currentObject} : {}),
        authorize: memoryRequest.authorize,
        async retrieve(query, step) {
          const packet = await readMemoryGateway({...memoryRequest, intent: 'management', maxBytes: 8192,
            ...(query ? {query} : {}), owner: {kind: 'session', id: job.slotKey, step: 'retrieve-memory:' + step}});
          if (!packet) throw new ChangedEvidence();
          trackMemory(packet);
          return packet;
        },
      }) : undefined;
      const result = await runCompanionTurn(answer, publicHistory, material, {
        provider: settings, runEffect: runModelEffect,
        async onProgress(progress) {
          // The generated tool call included private answers. The host owns the public
          // confirmation once a formal artifact has been mounted.
          if (progress.phase !== 'replying' || (!classroom && !workspace?.publishedFormalArtifact() && !turnMemory?.hasPending()))
            await onProgress(progress);
        },
        ...(historyNotice ? {historyNotice} : {}),
        ...(jit ? {jitContext: jit.context} : currentObject ? {currentLearningObject: JSON.stringify(currentObject.view)} : {}),
        ...(learningMemory?.context ? { learningMemory: learningMemory.context } : {}),
        ...(turnMemory ? {memoryTools: turnMemory.execute} : {}),
        ...(learningMemory?.bundle.omitted.some(item => item.reason === 'budget') ? {
          async openMemoryRegion(input: Record<string, unknown>, step: number) {
            if (expandedMemory) return JSON.stringify(learningToolError('budget_or_limit','region','本轮已使用一次记忆区域展开。'));
            const omitted = learningMemory?.bundle.omitted.find(item => item.reason === 'budget' &&
              item.expand.region === input.region && item.expand.start === input.start && item.expand.basisDigest === input.basisDigest);
            if (omitted?.reason !== 'budget') return JSON.stringify(learningToolError('not_found','region','请使用本轮提供的展开位置。'));
            expandedMemory = await readMemoryGateway({ ...memoryRequest, maxBytes: 16_384, expand: omitted.expand,
              owner: { kind: 'session', id: job.slotKey, step: `memory-region:${step}` } });
            if (!expandedMemory) throw new ChangedEvidence();
            trackMemory(expandedMemory);
            return expandedMemory.context;
          },
        } : {}),
        ...(classroom ? {tools:{...(workspace ? {workspace:{...workspace,presentationOnly:true as const}} : {})}} : submission.agentVersion === 1 ? { tools: { exaApiKey: settings.exaApiKey, mcpServers, ...(workspace ? {workspace} : {}),
          ...(publicSearchQuery ? {publicSearchQuery} : {}),
          allowSearch: submission.allowSearch === true && settings.allowSearch && (!privateContext || Boolean(publicSearchQuery)) } } : {}),
      }, attachment?.mode === 'prepare' && !submission.parentId, preference);
      let generated: ReturnType<typeof classroomReply> | undefined;
      if (classroom && classroom.mode !== 'advance') {
        try {
          generated = classroomReply(result.message);
          if (classroom.mode === 'start' && generated.steps.length < 2) throw new Error('missing future steps');
        } catch {
          throw new TeachingError('provider_response','模型返回的课堂编排不完整。');
        }
      }
      const memoryWrites = await turnMemory?.commit().catch(error => {
        if (isMemoryConflict(error)) throw new ChangedEvidence();
        throw error;
      }) ?? [];
      const writes = [...(workspace?.writes() ?? []), ...memoryWrites];
      const anchor = jit?.context.slots.anchor?.version;
      const bridge = jit?.context.slots.bridge?.oldMistake;
      feedback = {
        ...result,
        ...(generated ? {message:generated.message,classroomPlan:generated.steps} : {}),
        ...(workspace?.publishedFormalArtifact() ? { message: '断句题已发放。请先保存预测。', trace: [] } : {}),
        action: 'companion_reply', rationale: attachment ? '本次请求随附了你选择的材料片段。' : historyNotice,
        ...(learningMemoryDigest ? { learningMemoryDigest: expandedMemory
          ? createHash('sha256').update(learningMemoryDigest).update(expandedMemory.receipt.digest).digest('hex') : learningMemoryDigest } : {}),
        ...(writes.length ? {writes} : {}),
        ...(turnMemory?.used() ? {memoryManagement: true} : {}),
        ...(workspace?.basis().length || notionWitnesses.size ? {workspaceBasis:[...new Map([...notionWitnesses.values(), ...(workspace?.basis() ?? [])].map(w => [w.id + ':' + w.rev,w])).values()]} : {}),
        evidenceIds: [], reads: [
          ...(workspace?.reads() ?? []),
          ...(anchor ? [{id:anchor.ref,title:'首轮版本锚点',text:anchor.text}] : []),
          ...(bridge ? [{id:bridge.ref,title:'首轮同版旧错答',text:bridge.text}] : []),
          ...(attachment ? [{ id: attachment.id, title: attachment.title, text: attachment.text }] : []),
          ...(preference ? [{ id: memoryId, title: '本人保存的同伴备忘', text: preference }] : []),
        ],
        model: settings.model, reasoningEffort: settings.reasoningEffort,
      };
    } else {
      const selected = caseId(submission.caseId);
      if (selected !== 'independent' && selected !== 'workedExample') throw new Error('Unknown teaching case');
      const catalog = first45Histories[selected].map(({ id, title }) => ({ id, title }));
      const actual = new Map<string, { id: string; title: string; text: string }>();
      let followUp;
      if (submission.parentId && submission.answer) {
        const parent = submission.parentId;
        const prior = await confirmNotionRead(db, learner, async (tx, check) => {
          const reply = await readFeedback(tx, parent, check);
          return reply && {reply, witnesses:await savedNotionWitnesses(tx, parseManifest(reply.manifest).inputs)};
        });
        if (!prior) throw new ChangedEvidence();
        const {reply, witnesses} = prior;
        witnesses.forEach(trackNotion);
        trackFeedback(parent, reply.id);
        const prev = reply.value;
        followUp = {
          previous: {
            action: prev.action as TeachingResponse['action'],
            rationale: prev.rationale,
            nextStep: prev.message,
            evidenceIds: prev.evidenceIds,
          },
          answer: submission.answer,
        };
      }
      await onProgress({ phase: 'thinking' });
      const result = await runTeachingTurn(
        {
          question: first45Question,
          answer: first45Answer,
          diagnostic: first45Diagnostic,
          evidenceCatalog: catalog,
          ...(followUp ? { followUp } : {}),
        },
        {
          provider: settings,
          onProgress,
          readEvidence: async (id) => {
            const value = studyRecord(await read(sourceId(selected, id)));
            actual.set(id, { id, title: value.title, text: value.text });
            return value.text;
          },
          runEffect: runModelEffect,
        },
      );
      feedback = {
        action: result.action,
        rationale: result.rationale,
        message: result.nextStep,
        model: settings.model, reasoningEffort: settings.reasoningEffort,
        evidenceIds: result.evidenceIds,
        ...(result.reportedModel ? { reportedModel: result.reportedModel } : {}),
        reads: result.reads.map((record) => ({
          ...actual.get(record.id)!,
          ...(record.reportedModel ? { reportedModel: record.reportedModel } : {}),
        })),
      };
    }
    await settle(feedback);
  } catch (error) {
    if (
      !(
        error instanceof TeachingError ||
        error instanceof UncertainEffect ||
        error instanceof ChangedEvidence
      )
    )
      throw error;
    const status = error instanceof UncertainEffect ? 'unknown' : 'failed';
    const message =
      error instanceof UncertainEffect
        ? error.message
        : error instanceof ChangedEvidence
          ? '作答依据已变化，本轮结果无法使用。'
          : error.message;
    await failWork(db, ref, async (tx, tick) => {
      await tx.query(
        `UPDATE slot_state SET last_error=$4,changed_tick=$5 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`,
        [learner, slotType, job.slotKey, JSON.stringify({ status, message }), tick],
      );
      await completeTurnStream(tx, job.slotKey);
    });
  }
}

export async function recordTerminalFailure(db: Db, ref: WorkRef) {
  const job = await readWork(db, ref);
  if (!job) return;
  await failWork(db, ref, async (tx, tick) => {
    await tx.query(
      `UPDATE slot_state SET changed_tick=$4,last_error=$5
      WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`,
      [
        tx.learner,
        job.slotType,
        job.slotKey,
        tick,
        JSON.stringify({ status: 'failed', message: '执行器恢复后仍无法完成本轮教学。可开始新会话。' }),
      ],
    );
    await completeTurnStream(tx, job.slotKey);
  });
}
