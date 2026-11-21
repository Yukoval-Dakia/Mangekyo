import { extractPhotoWithVisionOrFallback, readVisionLlmConfigFromEnv, type LocalExtractionResult, type VisionLlmConfig } from '@mangekyo/executor-document-extraction/vision-ocr';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks, CrossModuleWrites } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, learnerId, type Tick } from '../../kernel/src/declarations/ids.ts';
import { cancelWork, finishWork, readReadyWork, requestWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { isExpectedVisionCompletion } from '../../modules/capture/intake-operations.ts';
import { completeVisionExtraction, completeVisionIntakeCommand, failedVisionExtraction, fallbackVisionExtraction, intakeDocument, intakeFactType, intakePurpose, intakeTextLimit, materialType, type IntakeExtraction } from '../../modules/capture/intake-values.ts';
import { buildVisionPaperOcrPrompt, parseStructuredPaperOcr, visionIntakeDeriver, visionIntakeRoute, visionIntakeSlot } from '../../modules/capture/vision-paper-ocr.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { stableId, studioLearner } from './identity.ts';
import { intakeIdFor } from './intake-lifecycle.ts';
import { RequestError } from './sessions.ts';

export { visionIntakeRoute, visionIntakeSlot };
export const resolveVisionIntakeConfig = readVisionLlmConfigFromEnv;
export async function enqueueVisionIntake(tx: DbTransaction, tick: Tick, intakeId: string) {
  await tx.insert('slot_state', { learner_id: tx.learner, slot_type: visionIntakeSlot, slot_key: intakeId, scope_keys: '{}', changed_tick: tick });
  await requestWork(tx, tick, { slotType: visionIntakeSlot, slotKey: intakeId, deriver: visionIntakeDeriver }, 'routed_pending');
}

async function visionInput(tx: ReadTransaction, intakeId: string) {
  const read = createCommandReadContext(tx, intakePurpose);
  const document = await read.fact(factId(intakeId), { mode: 'following' });
  if (document.type !== intakeFactType) return null;
  const value = intakeDocument(document.value);
  if (intakeIdFor(value.materialId) !== document.ref.id || value.requestedExtraction !== 'vision_llm' || value.extraction.status !== 'pending') return null;
  const material = await read.fact(value.materialId, { mode: 'following' });
  if (material.type !== materialType) return null;
  return { document, material, value };
}

export type VisionIntakeInput = NonNullable<Awaited<ReturnType<typeof visionInput>>>;
export async function completeVisionIntake(db: Db, runtime: { modules: LoadedModule[]; crossModuleWrites: CrossModuleWrites }, hooks: CommandHooks, ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction) {
  const { document, material } = input;
  const complete = createCommandHandler(db, { ...runtime, hooks: { ...hooks, async onFactsChanged(tx, tick, changes) {
      const work = await readReadyWork(tx, ref);
      if (!isExpectedVisionCompletion(work, visionIntakeSlot, document.ref, material.ref, changes)) throw new RequestError(409, '交入工作已更改。');
      await hooks.onFactsChanged(tx, tick, changes);
    } },
  });
  await complete({ learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: completeVisionIntakeCommand,
    id: commandId(stableId('intake-vision-result', ref.workId, ref.generation)),
    input: { intakeId: document.ref.id, expectedRev: document.ref.rev, expectedMaterialRev: material.ref.rev, extraction } });
}

class StoppedVisionIntake extends Error {}
const stopped = (error: unknown) => error instanceof StoppedVisionIntake || error instanceof RequestError || error instanceof FactNotFoundError || error instanceof FactReadDeniedError;
export function openVisionIntakeWork(db: Db, intake: {
  cloudOriginal(materialId: string, sha256: string): Promise<Buffer>;
  completeVision(ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction): Promise<void>;
}, deps: { resolveVisionConfig?: () => VisionLlmConfig | null; fetch?: typeof fetch; fallbackExtractLocal?: (kind:string,path:string,bytes:Buffer,limit:number) => Promise<LocalExtractionResult> } = {}) {
  async function execute(ref: WorkRef, terminalFailure = false, signal?: AbortSignal) {
    if (ref.learner !== studioLearner) throw new Error('Invalid intake learner');
    const current = async (tx: ReadTransaction) => {
      const work = await readReadyWork(tx, ref);
      return work?.slotType === visionIntakeSlot && work.deriver === visionIntakeDeriver ? visionInput(tx, work.slotKey) : null;
    };
    try {
      const frozen = await db.snapshot({ learner: learnerId(ref.learner) }, current);
      if (!frozen) return void await finishWork(db, ref);
      const unchanged = async (tx: ReadTransaction) => {
        const now = await current(tx);
        if (!now || now.document.ref.id !== frozen.document.ref.id || now.document.ref.rev !== frozen.document.ref.rev || now.material.ref.id !== frozen.material.ref.id || now.material.ref.rev !== frozen.material.ref.rev) throw new StoppedVisionIntake();
      };
      const publish = async (extraction: IntakeExtraction) => {
        await intake.completeVision(ref, frozen, extraction);
        await finishWork(db, ref);
      };
      if (terminalFailure) return void await publish(failedVisionExtraction('视觉识别未能在规定时间内完成。'));
      const bytes = await intake.cloudOriginal(frozen.material.ref.id, frozen.value.original.sha256).catch(() => null);
      if (bytes === null) return void await publish(failedVisionExtraction('本地原件无法读取。'));
      const directory = await mkdtemp(join(tmpdir(), 'mangekyo-vision-'));
      const storedPath = join(directory, 'original');
      await writeFile(storedPath, bytes, { mode: 0o600 });
      try {
        await db.snapshot({ learner: learnerId(ref.learner) }, unchanged);
        const prompt = buildVisionPaperOcrPrompt({ filename: frozen.value.original.name, titleHint: frozen.value.title });
        const outcome = await extractPhotoWithVisionOrFallback({
          bytes, storedPath, textLimit: intakeTextLimit, visionConfig: deps.resolveVisionConfig?.() ??
            readVisionLlmConfigFromEnv(), systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt,
          parseStructuredOutput: parseStructuredPaperOcr, signal, ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.fallbackExtractLocal ? { fallbackExtractLocal: deps.fallbackExtractLocal } : {}),
        });
        await db.snapshot({ learner: learnerId(ref.learner) }, unchanged);
        await publish(outcome.kind === 'vision_llm' ? completeVisionExtraction(outcome.parsed, 1)
          : fallbackVisionExtraction(outcome.local, outcome.fallbackReason));
      } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    } catch (error) {
      if (stopped(error)) await cancelWork(db, ref);
      else throw error;
    }
  }
  return { execute };
}
