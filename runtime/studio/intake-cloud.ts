import { mineruSupports, pollMineru, type readMineru, type submitMineru } from '@mangekyo/executor-document-extraction/mineru';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { intakeIdFor } from './intake-lifecycle.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';
import { createCommandReadContext, isFactUnavailable } from './fact-read-helpers.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, learnerId, type Tick } from '../../kernel/src/declarations/ids.ts';
import { cancelWork, finishWork, readReadyWork, requestWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { intakeDocument, intakeFactType, intakePurpose, failedMineruExtraction, completeMineruExtraction, materialType, type IntakeExtraction } from '../../modules/capture/intake-values.ts';
import { studioLearner } from './identity.ts';

export const cloudIntakeSlot = 'activity.intakeCloudExtraction';
const cloudIntakeDeriver = 'activity.mineruExtraction';
export const cloudIntakeRoute = { deriver: cloudIntakeDeriver };

export type MineruClient = { submit: typeof submitMineru; read: typeof readMineru };

export function mineruToken() {
  return process.env.MANGEKYO_MINERU_TOKEN?.trim() || undefined;
}

export async function enqueueCloudIntake(tx: DbTransaction, tick: Tick, intakeId: string) {
  await tx.insert('slot_state', {
    learner_id: tx.learner, slot_type: cloudIntakeSlot, slot_key: intakeId, scope_keys: '{}', changed_tick: tick,
  });
  await requestWork(tx, tick, { slotType: cloudIntakeSlot, slotKey: intakeId, deriver: cloudIntakeDeriver }, 'routed_pending');
}

async function cloudInput(tx: ReadTransaction, intakeId: string) {
  const read = createCommandReadContext(tx, intakePurpose);
  const document = await read.fact(factId(intakeId), { mode: 'following' });
  if (document.type !== intakeFactType) return null;
  const value = intakeDocument(document.value);
  if (intakeIdFor(value.materialId) !== document.ref.id) return null;
  const { mediaType } = value.original;
  if (value.requestedExtraction !== 'mineru' || value.extraction.status !== 'pending' || !mineruSupports(mediaType))
    return null;
  const material = await read.fact(value.materialId, { mode: 'following' });
  if (material.type !== materialType) return null;
  return { document, material, mediaType, sha256: value.original.sha256 };
}

export type CloudIntakeInput = NonNullable<Awaited<ReturnType<typeof cloudInput>>>;

class StoppedCloudIntake extends Error {}

function intakeStopped(error: unknown) {
  return (error instanceof LifecycleError && error.status === 410) || error instanceof StoppedCloudIntake || isFactUnavailable(error);
}

export function openCloudIntakeWork(db: Db, intake: {
  cloudOriginal(materialId: string, sha256: string): Promise<Buffer>;
  completeCloud(ref: WorkRef, input: CloudIntakeInput, extraction: IntakeExtraction): Promise<void>;
}, client: MineruClient, pollIntervalMs = 2500) {
  async function execute(ref: WorkRef, terminalFailure = false) {
    if (ref.learner !== studioLearner) throw new Error('Invalid intake learner');
    const scope = { learner: learnerId(ref.learner) };
    const current = async (tx: ReadTransaction) => {
      const work = await readReadyWork(tx, ref);
      if (!work || work.slotType !== cloudIntakeSlot || work.deriver !== cloudIntakeDeriver) return null;
      return cloudInput(tx, work.slotKey);
    };
    try {
      const frozen = await db.snapshot(scope, async tx => {
        const original = await current(tx);
        if (!original) return null;
        const {rows:[clock]} = await tx.query<{tick:string}>('SELECT clock::text AS tick FROM learners WHERE id=$1',[tx.learner]);
        const manifest = parseManifest({version:1, learner:tx.learner, purpose:intakePurpose, gatherTick:clock!.tick,
          inputs:[original.document, original.material].map(({ref,accessEpoch}) =>
            ({kind:'fact', id:ref.id, rev:ref.rev, accessEpoch, mode:'following'}))});
        return {original,manifest};
      });
      if (!frozen) {
        await finishWork(db, ref);
        return;
      }
      const {original,manifest} = frozen;
      const token = mineruToken();
      const authorize = async (tx: ReadTransaction) => {
        const source = await current(tx);
        if (!source || source.document.ref.id !== original.document.ref.id || source.material.ref.id !== original.material.ref.id ||
            source.document.ref.rev !== original.document.ref.rev ||
            source.material.ref.rev !== original.material.ref.rev ||
            source.document.accessEpoch !== original.document.accessEpoch ||
            source.material.accessEpoch !== original.material.accessEpoch) throw new StoppedCloudIntake();
      };
      const publish = async (extraction: IntakeExtraction) => {
        await intake.completeCloud(ref, original, extraction);
        await finishWork(db, ref);
      };
      if (terminalFailure || !token) {
        await publish(failedMineruExtraction(terminalFailure
          ? 'MinerU 未能在规定时间内完成识别。原件可继续查看或手动更正。'
          : 'MinerU 服务尚未配置，原件已保留。'));
        return;
      }
      const configurationChanged = () => mineruToken() !== token;
      const finishConfigurationChange = () => publish(failedMineruExtraction('MinerU 服务配置已变更，原件已保留。'));
      let stoppedBeforeUpload = false;
      const beforeUpload = async () => {
        try {
          await db.snapshot(scope, authorize);
          if (configurationChanged()) throw new StoppedCloudIntake();
        } catch (error) {
          stoppedBeforeUpload = intakeStopped(error);
          throw error;
        }
      };
      const dataId = original.document.ref.id;
      const submission = await runEffect(db, {
        learner: ref.learner, ownerKind: 'session', ownerId: dataId, stepKey: ref.generation, label: 'intake-mineru',
        input: { mediaType: original.mediaType, sha256: original.sha256, revision: original.document.ref.rev },
      }, async () => {
        const bytes = await intake.cloudOriginal(original.material.ref.id, original.sha256).catch(() => null);
        if (bytes === null) return null;
        try {
          await beforeUpload();
          return await client.submit({
            token, dataId, bytes, mediaType: original.mediaType, beforeUpload, signal: AbortSignal.timeout(60_000),
          });
        } catch (error) {
          if (stoppedBeforeUpload) return false;
          throw error;
        }
      }, authorize, {manifest, work:{...ref, ownerSlot:{slotType:cloudIntakeSlot,slotKey:dataId,deriver:cloudIntakeDeriver}}})
        .catch((error: unknown) => {
          if (error instanceof LifecycleError && error.code === 'legacy_effect_basis_missing')
            return {kind:'unverified'} as const;
          throw error;
        });
      await db.snapshot(scope, authorize);
      if (configurationChanged()) return finishConfigurationChange();
      if (submission.kind === 'unverified')
        return publish(failedMineruExtraction('旧上传记录缺少核对删除范围的依据，已停止轮询和重传。'));
      if (submission.kind === 'unknown') {
        await publish(failedMineruExtraction('无法确认 MinerU 是否收到原件，已停止自动重传。你可以查看原件或手动更正。'));
        return;
      }
      if (submission.result === null) {
        await publish(failedMineruExtraction('本地原件无法读取，未发送给 MinerU。'));
        return;
      }
      if (submission.result === false) {
        await publish(failedMineruExtraction('任务已中止，未向 MinerU 发送原件。'));
        return;
      }
      if (typeof submission.result !== 'string') throw new Error('Invalid OCR submission receipt');
      const result = await pollMineru(input => client.read(input), {
        token, dataId, batchId: submission.result, beforeDownload: () => db.snapshot(scope, authorize),
      }, async () => {
        await db.snapshot(scope, authorize);
        return !configurationChanged();
      }, pollIntervalMs);
      if (!result) return finishConfigurationChange();
      await publish(result.state === 'done'
        ? completeMineruExtraction(result.text, result.pages)
        : failedMineruExtraction(result.message));
    } catch (error) {
      if (!intakeStopped(error)) throw error;
      await cancelWork(db, ref);
    }
  }
  return { execute };
}
