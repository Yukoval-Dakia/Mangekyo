import { setTimeout as delay } from 'node:timers/promises';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, learnerId, type Tick } from '../../kernel/src/declarations/ids.ts';
import { cancelWork, finishWork, readReadyWork, requestWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import {
  intakeDocument,
  intakeFactType,
  intakePurpose,
  intakeTextLimit,
  materialType,
  type IntakeExtraction,
} from '../../modules/capture/intake-values.ts';
import { studioLearner } from './identity.ts';

export const cloudIntakeSlot = 'activity.intakeCloudExtraction';
const cloudIntakeDeriver = 'activity.mineruExtraction';

type MineruMediaType = 'application/pdf' | 'image/png' | 'image/jpeg';
type MineruContext = { token: string; dataId: string; signal?: AbortSignal };
export type MineruClient = {
  submit(input: MineruContext & {
    bytes: Buffer; mediaType: MineruMediaType; beforeUpload?: () => Promise<void>;
  }): Promise<string>;
  read(input: MineruContext & { batchId: string }): Promise<
    { state: 'pending'; pages: number | null } |
    { state: 'done'; text: string; pages: number | null } |
    { state: 'failed'; message: string }
  >;
};

export function mineruSupports(mediaType: string): mediaType is MineruMediaType {
  return mediaType === 'application/pdf' || mediaType === 'image/png' || mediaType === 'image/jpeg';
}

export function mineruToken() {
  return process.env.MANGEKYO_MINERU_TOKEN?.trim() || undefined;
}

export async function enqueueCloudIntake(tx: DbTransaction, tick: Tick, intakeId: string) {
  await tx.insert('slot_state', {
    learner_id: tx.learner, slot_type: cloudIntakeSlot, slot_key: intakeId, scope_keys: '{}', changed_tick: tick,
  });
  await requestWork(tx, tick, { slotType: cloudIntakeSlot, slotKey: intakeId, deriver: cloudIntakeDeriver });
}

async function cloudInput(tx: ReadTransaction, intakeId: string) {
  const read = createCommandReadContext(tx, intakePurpose);
  const document = await read.fact(factId(intakeId), { mode: 'following' });
  if (document.type !== intakeFactType) return null;
  const value = intakeDocument(document.value);
  const { mediaType } = value.original;
  if (value.requestedExtraction !== 'mineru' || value.extraction.status !== 'pending' || !mineruSupports(mediaType))
    return null;
  const material = await read.fact(value.materialId, { mode: 'following' });
  if (material.type !== materialType) return null;
  return { document, material, mediaType, sha256: value.original.sha256 };
}

export type CloudIntakeInput = NonNullable<Awaited<ReturnType<typeof cloudInput>>>;

function failure(error: string): IntakeExtraction {
  const message = error.replaceAll(String.fromCharCode(0), '').trim().slice(0, 1_000).toWellFormed();
  return {
    status: 'failed', method: 'mineru', error: message || 'MinerU 识别失败。',
    text: '', characterCount: 0, pages: null, warnings: [], truncated: false,
  };
}

function completed(text: string, pages: number | null): IntakeExtraction {
  if (!text.trim() || !text.isWellFormed() || text.includes('\u0000'))
    return failure('MinerU 没有返回可用正文。');
  const truncated = text.length > intakeTextLimit;
  const content = truncated ? text.slice(0, intakeTextLimit).toWellFormed() : text;
  if (!content.trim()) return failure('MinerU 没有返回可用正文。');
  return {
    status: truncated ? 'partial' : 'ok', method: 'mineru', text: content,
    pages: pages !== null && Number.isSafeInteger(pages) && pages >= 0 && pages <= 1_000 ? pages : null, error: null,
    warnings: truncated ? ['识别正文超过保存上限，已保留前 200 万字。'] : [],
    truncated, characterCount: content.length,
  };
}

class StoppedCloudIntake extends Error {}

function intakeStopped(error: unknown) {
  return error instanceof StoppedCloudIntake || error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
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
      const original = await db.snapshot(scope, current);
      if (!original) {
        await finishWork(db, ref);
        return;
      }
      const token = mineruToken();
      const authorize = async (tx: ReadTransaction) => {
        const source = await current(tx);
        if (!source || source.document.ref.rev !== original.document.ref.rev ||
            source.material.ref.rev !== original.material.ref.rev ||
            source.document.accessEpoch !== original.document.accessEpoch ||
            source.material.accessEpoch !== original.material.accessEpoch) throw new StoppedCloudIntake();
      };
      const publish = async (extraction: IntakeExtraction) => {
        await intake.completeCloud(ref, original, extraction);
        await finishWork(db, ref);
      };
      if (terminalFailure || !token) {
        await publish(failure(terminalFailure
          ? 'MinerU 未能在规定时间内完成识别。原件可继续查看或手动更正。'
          : 'MinerU 服务尚未配置，原件已保留。'));
        return;
      }
      const configurationChanged = () => mineruToken() !== token;
      const finishConfigurationChange = () => publish(failure('MinerU 服务配置已变更，原件已保留。'));
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
      }, authorize);
      await db.snapshot(scope, authorize);
      if (configurationChanged()) return finishConfigurationChange();
      if (submission.kind === 'unknown') {
        await publish(failure('无法确认 MinerU 是否收到原件，已停止自动重传。你可以查看原件或手动更正。'));
        return;
      }
      if (submission.result === null) {
        await publish(failure('本地原件无法读取，未发送给 MinerU。'));
        return;
      }
      if (submission.result === false) {
        await publish(failure('任务已中止，未向 MinerU 发送原件。'));
        return;
      }
      if (typeof submission.result !== 'string') throw new Error('Invalid OCR submission receipt');
      const signal = AbortSignal.timeout(120_000);
      for (;;) {
        await db.snapshot(scope, authorize);
        if (configurationChanged()) return finishConfigurationChange();
        const result = await client.read({ token, dataId, batchId: submission.result, signal });
        if (result.state === 'pending') {
          await delay(pollIntervalMs, undefined, { signal });
          continue;
        }
        await db.snapshot(scope, authorize);
        if (configurationChanged()) return finishConfigurationChange();
        if (result.state === 'done') {
          await publish(completed(result.text, result.pages));
          return;
        }
        await publish(failure(result.message));
        return;
      }
    } catch (error) {
      if (!intakeStopped(error)) throw error;
      await cancelWork(db, ref);
    }
  }
  return { execute };
}
