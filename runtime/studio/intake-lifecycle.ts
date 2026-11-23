import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks, CrossModuleWrites } from '../../kernel/src/commands/contracts.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, learnerId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { assertDeletionWatermark, assertUnburned, deletionState, eraseOriginal, LifecycleError } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { cancelWork, finishWork, readReadyWork, requestWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { isExpectedCloudCompletion, parseIntakeErasureRequest, planIntakeErasureTarget } from '../../modules/capture/intake-operations.ts';
import { intakeDocument, intakeFactType, intakePurpose, materialType, type IntakeExtraction, type IntakeRequestedExtraction } from '../../modules/capture/intake-values.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import { createCommandReadContext } from './fact-read-helpers.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { teachingErasure } from './teaching-erasure.ts';

export const intakeCaptureId = (requestId: string) => commandId(stableId('intake-capture', requestId));
export const intakeIdFor = (materialId: FactId) => factId(stableId('intake-document', materialId));
type IntakeWorkPair = { readonly document: FactSnapshot; readonly material: FactSnapshot };

export async function enqueueIntakeWork(tx: DbTransaction, tick: Tick, slotType: string, deriver: string, intakeId: string) {
  await tx.query(`INSERT INTO slot_state (learner_id,slot_type,slot_key,scope_keys,changed_tick) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [tx.learner, slotType, intakeId, '{}', tick]);
  await requestWork(tx, tick, { slotType, slotKey: intakeId, deriver }, 'routed_pending');
}

export async function readPendingIntakeWork(
  tx: ReadTransaction, ref: WorkRef, slotType: string, deriver: string,
  requested: IntakeRequestedExtraction, acceptMedia?: (mediaType: string) => boolean,
) {
  const work = await readReadyWork(tx, ref);
  if (!work || work.slotType !== slotType || work.deriver !== deriver) return null;
  const read = createCommandReadContext(tx, intakePurpose), document = await read.fact(factId(work.slotKey), { mode: 'following' });
  if (document.type !== intakeFactType) return null;
  const value = intakeDocument(document.value);
  if (intakeIdFor(value.materialId) !== document.ref.id || value.requestedExtraction !== requested ||
      value.extraction.status !== 'pending' || (acceptMedia && !acceptMedia(value.original.mediaType))) return null;
  const material = await read.fact(value.materialId, { mode: 'following' });
  return material.type === materialType ? { document, material, value } : null;
}

export const sameIntakeWorkSnapshot = (now: IntakeWorkPair | null, frozen: IntakeWorkPair, checkEpoch = false): boolean => Boolean(
  now && now.document.ref.id === frozen.document.ref.id && now.material.ref.id === frozen.material.ref.id &&
  now.document.ref.rev === frozen.document.ref.rev && now.material.ref.rev === frozen.material.ref.rev &&
  (!checkEpoch || (now.document.accessEpoch === frozen.document.accessEpoch && now.material.accessEpoch === frozen.material.accessEpoch)));

export async function runPendingIntakeWork<T>(
  db: Db, ref: WorkRef, load: (tx: ReadTransaction) => Promise<T | null>,
  isStopped: (error: unknown) => boolean, run: (frozen: T, finish: () => Promise<unknown>) => Promise<void>,
) {
  if (ref.learner !== studioLearner) throw new Error('Invalid intake learner');
  try {
    const frozen = await db.snapshot({ learner: learnerId(ref.learner) }, load);
    if (!frozen) return void await finishWork(db, ref);
    await run(frozen, () => finishWork(db, ref));
  } catch (error) {
    if (isStopped(error)) await cancelWork(db, ref); else throw error;
  }
}

export async function completeIntakeWorkCommand(
  db: Db, runtime: { modules: LoadedModule[]; crossModuleWrites: CrossModuleWrites }, hooks: CommandHooks,
  ref: WorkRef, { document, material }: IntakeWorkPair, extraction: IntakeExtraction,
  opts: { slotType: string; commandType: string; stableTag: string; afterChanged?: (tx: DbTransaction, tick: Tick) => Promise<void> },
) {
  await createCommandHandler(db, {
    ...runtime, hooks: { ...hooks, async onFactsChanged(tx, tick, changes) {
      if (!isExpectedCloudCompletion(await readReadyWork(tx, ref), opts.slotType, document.ref, material.ref, changes))
        throw new RequestError(409, '交入工作已更改。');
      await hooks.onFactsChanged(tx, tick, changes);
      await opts.afterChanged?.(tx, tick);
    } },
  })({
    learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: opts.commandType,
    id: commandId(stableId(opts.stableTag, ref.workId, ref.generation)),
    input: { intakeId: document.ref.id, expectedRev: document.ref.rev, expectedMaterialRev: material.ref.rev, extraction },
  });
}

export function openIntakeLifecycle(db: Db, removeObject: (id: FactId) => Promise<void>) {
  const scope = { learner: studioLearner };
  return {
    state: () => db.snapshot(scope, deletionState),
    checkCapture: async (tx: ReadTransaction, id: FactId, watermark: string) => {
      await assertUnburned(tx, 'fact', [id]);
      await assertDeletionWatermark(tx, watermark);
    },
    erase: (id: string, input: Record<string, unknown>) => {
      const { root, rev, requestKey } = parseIntakeErasureRequest(id, input);
      return eraseOriginal(db, scope, { actor: 'learner', confirmed: true, requestId: commandId(stableId('erase-intake', requestKey)), root, expectedRev: rev }, async tx => {
        const read = createCommandReadContext(tx, intakePurpose), material = await read.fact(root, { mode: 'following' });
        const document = material.type === captureSourceType ? undefined : await read.fact(intakeIdFor(root), { mode: 'following' });
        const plan = planIntakeErasureTarget(root, rev, { type: material.type, rev: material.ref.rev, value: material.value },
          document && { id: document.ref.id, type: document.type, rev: document.ref.rev, value: document.value });
        if (plan.kind === 'conflict') throw new LifecycleError(409, plan.message);
        return { ids: plan.ids, commandTypes: plan.commandTypes };
      }, () => removeObject(root), teachingErasure);
    },
  };
}
