import {
  collectVisionOcrTelemetry, extractMultiPagePaperWithVisionOrFallback, isWeakVisionModel, mapVisionPageOutcomes,
  readVisionLlmConfigFromEnv, visionOcrEffectRecords, type LocalExtractionResult, type VisionLlmConfig, type VisionOcrCallTelemetry,
} from '@mangekyo/executor-document-extraction/vision-ocr';
import type { CommandHooks, CrossModuleWrites } from '../../kernel/src/commands/contracts.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { learnerId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { recordCompletedEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { completeMultiPageVisionExtraction, completeVisionIntakeCommand, failedVisionExtraction, intakeDocumentPages, intakeTextLimit, planMultiPageVisionWork, type IntakeExtraction } from '../../modules/capture/intake-values.ts';
import { buildVisionPaperOcrPrompt, parseStructuredPaperOcr, visionIntakeDeriver, visionIntakeRoute, visionIntakeSlot } from '../../modules/capture/vision-paper-ocr.ts';
import { isFactUnavailable } from './fact-read-helpers.ts';
import { completeIntakeWorkCommand, enqueueIntakeWork, readPendingIntakeWork, runPendingIntakeWork, sameIntakeWorkSnapshot } from './intake-lifecycle.ts';
import { RequestError } from './sessions.ts';
import { loadSettings } from './settings.ts';

export { visionIntakeRoute, visionIntakeSlot, type VisionOcrCallTelemetry };

export async function resolveVisionIntakeTarget(): Promise<{ config: VisionLlmConfig; route: string } | null> {
  const fromEnv = readVisionLlmConfigFromEnv();
  if (fromEnv) return { config: fromEnv, route: 'env' };
  for (const task of ['preparation', 'companion'] as const) {
    const s = await loadSettings(task).catch(() => null);
    if (s?.baseUrl && s.model && s.protocol !== 'anthropic' && !isWeakVisionModel(s.model))
      return { config: { baseUrl: s.baseUrl, ...(s.apiKey ? { apiKey: s.apiKey } : {}), model: s.model }, route: task };
  }
  return null;
}

export const resolveVisionIntakeConfig = async (): Promise<VisionLlmConfig | null> => (await resolveVisionIntakeTarget())?.config ?? null;
export const enqueueVisionIntake = (tx: DbTransaction, tick: Tick, intakeId: string) =>
  enqueueIntakeWork(tx, tick, visionIntakeSlot, visionIntakeDeriver, intakeId);

const visionInput = (tx: ReadTransaction, ref: WorkRef) => readPendingIntakeWork(tx, ref, visionIntakeSlot, visionIntakeDeriver, 'vision_llm');
export type VisionIntakeInput = NonNullable<Awaited<ReturnType<typeof visionInput>>>;

export const completeVisionIntake = (
  db: Db, runtime: { modules: LoadedModule[]; crossModuleWrites: CrossModuleWrites }, hooks: CommandHooks,
  ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction, telemetry?: readonly VisionOcrCallTelemetry[],
) => completeIntakeWorkCommand(db, runtime, hooks, ref, input, extraction, {
  slotType: visionIntakeSlot, commandType: completeVisionIntakeCommand, stableTag: 'intake-vision-result',
  afterChanged: async (tx, tick) => {
    for (const record of visionOcrEffectRecords(input.material.ref.id, input.document.ref.rev, ref, telemetry ?? []))
      await recordCompletedEffect(tx, tick, record);
  },
});

class StoppedVisionIntake extends Error {}
const stopped = (error: unknown) => error instanceof StoppedVisionIntake || error instanceof RequestError || isFactUnavailable(error);

export function openVisionIntakeWork(db: Db, intake: {
  cloudOriginal(materialId: string, sha256: string): Promise<Buffer>;
  originalPage(materialId: string, page: number): Promise<{ original: { name: string; mediaType: string }; bytes: Buffer }>;
  completeVision(ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction, telemetry?: readonly VisionOcrCallTelemetry[]): Promise<void>;
}, deps: {
  resolveVisionConfig?: () => VisionLlmConfig | null | Promise<VisionLlmConfig | null>;
  fetch?: typeof fetch;
  fallbackExtractLocal?: (kind: string, path: string, bytes: Buffer, limit: number) => Promise<LocalExtractionResult>;
} = {}) {
  return {
    execute: (ref: WorkRef, terminalFailure = false, signal?: AbortSignal) => {
      const scope = { learner: learnerId(ref.learner) };
      return runPendingIntakeWork(db, ref, tx => visionInput(tx, ref), stopped, async (frozen, finish) => {
        const unchanged = async (tx: ReadTransaction) => { if (!sameIntakeWorkSnapshot(await visionInput(tx, ref), frozen)) throw new StoppedVisionIntake(); };
        const publish = async (extraction: IntakeExtraction, telemetry?: readonly VisionOcrCallTelemetry[]) => {
          await intake.completeVision(ref, frozen, extraction, telemetry);
          await finish();
        };
        if (terminalFailure) return publish(failedVisionExtraction('视觉识别未能在规定时间内完成。'));
        const plan = planMultiPageVisionWork(frozen.value);
        if (plan.pagesToRun.length === 0) return publish(completeMultiPageVisionExtraction(plan.preservedPages, { titleHint: frozen.value.title }));
        const allPages = intakeDocumentPages(frozen.value), pageInputs: { page: number; bytes: Buffer; name: string }[] = [];
        for (const { page } of plan.pagesToRun) {
          const entry = allPages.find(item => item.page === page);
          if (!entry) return publish(failedVisionExtraction(`第 ${page} 页原件缺少元数据。`, 'vision_llm', plan.totalPages));
          const result = await intake.originalPage(frozen.material.ref.id, page).catch(() => null);
          if (!result || result.bytes === null) return publish(failedVisionExtraction(`第 ${page} 页原件无法读取。`, 'vision_llm', plan.totalPages));
          pageInputs.push({ page, bytes: result.bytes, name: entry.name });
        }
        await db.snapshot(scope, unchanged);
        const resolved = deps.resolveVisionConfig ? { config: await deps.resolveVisionConfig(), route: 'custom' } : await resolveVisionIntakeTarget();
        const visionConfig = resolved?.config ?? null;
        const outcomes = await extractMultiPagePaperWithVisionOrFallback({
          pages: pageInputs.map(p => ({ page: p.page, bytes: p.bytes,
            ...buildVisionPaperOcrPrompt({ filename: p.name, titleHint: frozen.value.title, pageNumber: p.page, totalPages: plan.totalPages }) })),
          textLimit: intakeTextLimit, visionConfig, signal, parseStructuredOutput: parseStructuredPaperOcr,
          ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.fallbackExtractLocal ? { fallbackExtractLocal: deps.fallbackExtractLocal } : {}),
        });
        await db.snapshot(scope, unchanged);
        const telemetry = collectVisionOcrTelemetry(outcomes.pages, { totalPages: plan.totalPages, route: resolved?.route ?? 'custom', requestedModel: visionConfig?.model ?? '' });
        await publish(completeMultiPageVisionExtraction([...plan.preservedPages, ...mapVisionPageOutcomes(outcomes.pages)], { titleHint: frozen.value.title }), telemetry);
      });
    },
  };
}
