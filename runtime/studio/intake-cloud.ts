import {
  mineruSubmissionFailure, mineruSupports, pollMineru, submitMineruChecked,
  type MineruMediaType, type readMineru, type submitMineru,
} from '@mangekyo/executor-document-extraction/mineru';
import {
  isFactUnavailable, LifecycleError, parseManifest, readLearnerClock,
  type Db, type DbTransaction, type ReadTransaction, type Tick,
} from '../../kernel/src/index.ts';
import { runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { completeMineruExtraction, failedMineruExtraction, intakePurpose, type IntakeExtraction } from '../../modules/capture/intake-values.ts';
import { enqueueIntakeWork, readPendingIntakeWork, runPendingIntakeWork, sameIntakeWorkSnapshot, StoppedIntakeWork } from './intake-lifecycle.ts';
export const cloudIntakeSlot = 'activity.intakeCloudExtraction', cloudIntakeRoute = { deriver: 'activity.mineruExtraction' };
export type MineruClient = { submit: typeof submitMineru; read: typeof readMineru };
export const mineruToken = () => process.env.MANGEKYO_MINERU_TOKEN?.trim() || undefined;
export const enqueueCloudIntake = (tx: DbTransaction, tick: Tick, intakeId: string) =>
  enqueueIntakeWork(tx, tick, cloudIntakeSlot, cloudIntakeRoute.deriver, intakeId);
async function cloudInput(tx: ReadTransaction, ref: WorkRef) {
  const pending = await readPendingIntakeWork(tx, ref, cloudIntakeSlot, cloudIntakeRoute.deriver, 'mineru', mineruSupports);
  return pending && { document: pending.document, material: pending.material,
    mediaType: pending.value.original.mediaType as MineruMediaType, sha256: pending.value.original.sha256 };
}
export type CloudIntakeInput = NonNullable<Awaited<ReturnType<typeof cloudInput>>>;
const intakeStopped = (error: unknown) =>
  (error instanceof LifecycleError && error.status === 410) || error instanceof StoppedIntakeWork || isFactUnavailable(error);
export function openCloudIntakeWork(db: Db, intake: {
  cloudOriginal(materialId: string, sha256: string): Promise<Buffer>;
  completeCloud(ref: WorkRef, input: CloudIntakeInput, extraction: IntakeExtraction): Promise<void>;
}, client: MineruClient, pollIntervalMs = 2500) {
  return {
    execute: (ref: WorkRef, terminalFailure = false) => runPendingIntakeWork(db, ref, async tx => {
      const original = await cloudInput(tx, ref);
      if (!original) return null;
      return { original, manifest: parseManifest({ version: 1, learner: tx.learner, purpose: intakePurpose, gatherTick: await readLearnerClock(tx),
        inputs: [original.document, original.material].map(({ ref: r, accessEpoch }) => ({ kind: 'fact', id: r.id, rev: r.rev, accessEpoch, mode: 'following' })) }) };
    }, intakeStopped, async ({ frozen: { original, manifest }, host, finish }) => {
      const token = mineruToken(), dataId = original.document.ref.id;
      const authorize = async (tx: ReadTransaction) => { if (!sameIntakeWorkSnapshot(await cloudInput(tx, ref), original, true)) throw new StoppedIntakeWork(); };
      const publish = async (extraction: IntakeExtraction) => { await intake.completeCloud(ref, original, extraction); await finish(); };
      if (terminalFailure || !token) return publish(failedMineruExtraction(terminalFailure
        ? 'MinerU 未能在规定时间内完成识别。原件可继续查看或手动更正。' : 'MinerU 服务尚未配置，原件已保留。'));
      const configChanged = () => mineruToken() !== token;
      const failConfig = () => publish(failedMineruExtraction('MinerU 服务配置已变更，原件已保留。'));
      const submission = await runEffect(db, {
        learner: ref.learner, ownerKind: 'session', ownerId: dataId, stepKey: ref.generation, label: 'intake-mineru',
        input: { mediaType: original.mediaType, sha256: original.sha256, revision: original.document.ref.rev },
      }, () => submitMineruChecked(client.submit, {
        token, dataId, mediaType: original.mediaType, isStopped: intakeStopped,
        readBytes: () => intake.cloudOriginal(original.material.ref.id, original.sha256).catch(() => null),
        checkCurrent: async () => { await host.snapshot(authorize); if (configChanged()) throw new StoppedIntakeWork(); },
      }), authorize, { manifest, work: { ...ref, ownerSlot: { slotType: cloudIntakeSlot, slotKey: dataId, deriver: cloudIntakeRoute.deriver } } })
        .catch((error: unknown) => error instanceof LifecycleError && error.code === 'legacy_effect_basis_missing' ? { kind: 'unverified' as const } : Promise.reject(error));
      await host.snapshot(authorize);
      if (configChanged()) return failConfig();
      const failure = mineruSubmissionFailure(submission);
      if (failure) return publish(failedMineruExtraction(failure));
      if (submission.kind !== 'done' || typeof submission.result !== 'string') throw new Error('Invalid OCR submission receipt');
      const result = await pollMineru(input => client.read(input),
        { token, dataId, batchId: submission.result, beforeDownload: () => host.snapshot(authorize) },
        async () => (await host.snapshot(authorize), !configChanged()), pollIntervalMs);
      await (result ? publish(result.state === 'done' ? completeMineruExtraction(result.text, result.pages) : failedMineruExtraction(result.message)) : failConfig());
    }),
  };
}
