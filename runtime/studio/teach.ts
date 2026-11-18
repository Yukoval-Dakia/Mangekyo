import { ridingLesson, averageSpeed } from '../../modules/activity/starter.ts';
import { createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, factId, learnerId } from '../../kernel/src/declarations/ids.ts';
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
  teachingProfile,
  type CompanionMessage,
  type TeachingDependencies,
  type TeachingResponse,
} from '../../executors/teaching/index.ts';
import { studyRecord, studyTurn } from '../../modules/activity/values.ts';
import { caseId, type DisplayTurn } from './sessions.ts';
import { loadSettings } from './settings.ts';
import { completeTurnStream, publishTurnProgress } from './stream.ts';
import { methodName, purpose, slotType, sourceId, stableId, studioLearner } from './identity.ts';

class UncertainEffect extends Error {
  constructor(requestId: string | null) {
    super('提供方的执行结果待核对，本轮已停止自动调用。' + (requestId ? '请求标识 ' + requestId : ''));
  }
}
class ChangedEvidence extends Error {}

export async function teach(db: Db, ref: WorkRef) {
  if (ref.learner !== studioLearner) throw new Error('Unknown teaching scope');
  const job = await readWork(db, ref);
  if (!job) return;
  if (job.slotType !== slotType || job.deriver !== methodName) throw new Error('Unknown teaching method');
  const learner = learnerId(ref.learner);
  const scope = { learner };
  const inputs = new Map<string, ManifestInput>();
  async function readFact(tx: ReadTransaction, id: string) {
    const fact = await createCommandReadContext(tx, purpose).fact(factId(id), { mode: 'following' });
    inputs.set(id, {
      kind: 'fact',
      id: fact.ref.id,
      rev: fact.ref.rev,
      accessEpoch: fact.accessEpoch,
      mode: 'following',
    });
    return fact.value;
  }
  const read = (id: string) => db.snapshot(scope, (tx) => readFact(tx, id));

  async function readFeedback(tx: ReadTransaction, id: string, recordDependency = true) {
    const {
      rows: [row],
    } = await tx.query<{ id: string; value: DisplayTurn }>(
      `SELECT d.id, d.value FROM slot_state s JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3`,
      [learner, slotType, id],
    );
    if (!row) throw new ChangedEvidence();
    if (recordDependency) {
      inputs.set('feedback:' + id, {
        kind: 'slot',
        slotType,
        slotKey: id,
        derivationId: derivationId(row.id),
        mode: 'following',
      });
      await validInputs(tx);
    }
    return row.value;
  }
  async function validInputs(tx: ReadTransaction) {
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
  try {
    const submission = studyTurn(await read(job.slotKey));
    if (submission.model !== teachingProfile.model || submission.reasoningEffort !== teachingProfile.reasoningEffort)
      throw new TeachingError('provider_configuration', '这轮作答提交于教学模型切换前。请开始新对话，以当前模型继续。');
    const settings = await loadSettings();
    if (settings.baseUrl !== submission.baseUrl)
      throw new TeachingError('provider_configuration', '模型服务地址已更改，请开始新会话。');
    if (submission.parentId) {
      const origin = studyTurn(await read(submission.sessionId));
      const previous = studyTurn(await read(submission.parentId));
      if (origin.baseUrl !== settings.baseUrl || previous.baseUrl !== settings.baseUrl)
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
    const runModelEffect: TeachingDependencies['runEffect'] = async (step, invoke) => {
      const effect = await runEffect(
        db,
        {
          learner,
          ownerKind: 'session',
          ownerId: job.slotKey,
          stepKey: String(step.index),
          label: 'teaching-model',
          input: { digest: step.requestDigest, provider: step.provider, model: step.model },
        },
        async (requestId) => {
          try {
            return await invoke(requestId);
          } catch (error) {
            console.warn('模型调用未能确认', requestId, error instanceof TeachingError ? error.code : 'transport_error');
            throw error;
          }
        },
        async (tx) => {
          if (!(await readReadyWork(tx, ref))) throw new ChangedEvidence();
          await validInputs(tx);
        },
      );
      if (effect.kind === 'unknown') throw new UncertainEffect(effect.providerEffectId);
      if (typeof effect.result !== 'string') throw new Error('Invalid stored model response');
      return effect.result;
    };

    let feedback: DisplayTurn;
    if (submission.caseId === 'companion' || submission.caseId === 'riding') {
      const answer = submission.answer;
      if (!answer) throw new TeachingError('invalid_input', '请输入有效的学习问题。');
      const publicHistory = await db.snapshot(scope, async (tx) => {
        const messages: CompanionMessage[] = [];
        let previousId = submission.parentId;
        for (let count = 0; previousId && count < 3; count++) {
          const previous = studyTurn(await readFact(tx, previousId));
          if (previous.sessionId !== submission.sessionId || previous.caseId !== submission.caseId || previous.baseUrl !== settings.baseUrl || !previous.answer) {
            throw new ChangedEvidence();
          }
          // Each reply follows its immediate predecessor. Recursive manifest
          // validation covers earlier replies without repeating dependency paths.
          const response = await readFeedback(tx, previousId, count === 0);
          messages.unshift({ role: 'user', content: previous.answer }, { role: 'assistant', content: response.message });
          previousId = previous.parentId;
        }
        return messages;
      });
      await onProgress({ phase: 'thinking' });
      const { title, distanceKm, movingMinutes, stoppedMinutes } = ridingLesson;
      const material = submission.caseId === 'riding'
        ? `《${title}》：全程 ${distanceKm} 公里，移动 ${movingMinutes} 分钟，停车 ${stoppedMinutes} 分钟。移动均速 ${averageSpeed(distanceKm, movingMinutes)} 公里/小时，全程均速 ${averageSpeed(distanceKm, movingMinutes + stoppedMinutes)} 公里/小时。`
        : undefined;
      const result = await runCompanionTurn(answer, publicHistory, material, {
        provider: settings, runEffect: runModelEffect, onProgress,
      });
      feedback = { ...result, action: 'companion_reply', rationale: '', evidenceIds: [], reads: [], ...teachingProfile };
    } else {
      const selected = caseId(submission.caseId);
      if (selected !== 'independent' && selected !== 'workedExample') throw new Error('Unknown teaching case');
      const catalog = first45Histories[selected].map(({ id, title }) => ({ id, title }));
      const actual = new Map<string, { id: string; title: string; text: string }>();
      let followUp;
      if (submission.parentId && submission.answer) {
        const parent = submission.parentId;
        const prev = await db.snapshot(scope, tx => readFeedback(tx, parent));
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
        ...teachingProfile,
        evidenceIds: result.evidenceIds,
        ...(result.reportedModel ? { reportedModel: result.reportedModel } : {}),
        reads: result.reads.map((record) => ({
          ...actual.get(record.id)!,
          ...(record.reportedModel ? { reportedModel: record.reportedModel } : {}),
        })),
      };
    }
    await finishWork(db, ref, async (tx, tick) => {
      const manifest = await validInputs(tx);
      const id = stableId('feedback', ref.learner, ref.workId, ref.generation);
      await tx.insert('derivations', {
        learner_id: learner,
        id,
        slot_type: slotType,
        slot_key: job.slotKey,
        deriver: methodName,
        scope_keys: '{}',
        value: JSON.stringify(feedback),
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
