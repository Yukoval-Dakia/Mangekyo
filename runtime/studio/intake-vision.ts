import { extractMultiPagePaperWithVisionOrFallback, isWeakVisionModel, readVisionLlmConfigFromEnv, type LocalExtractionResult, type VisionLlmConfig, type VisionPaperLlmCallResult } from '@mangekyo/executor-document-extraction/vision-ocr';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks, CrossModuleWrites } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, isFactUnavailable } from './fact-read-helpers.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, learnerId, type Tick } from '../../kernel/src/declarations/ids.ts';
import { cancelWork, finishWork, readReadyWork, recordCompletedEffect, requestWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { isExpectedVisionCompletion } from '../../modules/capture/intake-operations.ts';
import { completeMultiPageVisionExtraction, completeVisionIntakeCommand, failedVisionExtraction, intakeDocument, intakeDocumentPages, intakeFactType, intakePurpose, intakeTextLimit, materialType, planMultiPageVisionWork, type IntakeExtraction } from '../../modules/capture/intake-values.ts';
import { buildVisionPaperOcrPrompt, parseStructuredPaperOcr, visionIntakeDeriver, visionIntakeRoute, visionIntakeSlot } from '../../modules/capture/vision-paper-ocr.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { stableId, studioLearner } from './identity.ts';
import { intakeIdFor } from './intake-lifecycle.ts';
import { loadSettings } from './settings.ts';
import { RequestError } from './sessions.ts';

export { visionIntakeRoute, visionIntakeSlot };
export type VisionOcrCallTelemetry = {
  readonly page: number;
  readonly totalPages: number;
  readonly route: string;
  readonly requestedModel: string;
  readonly reportedModel: string;
  readonly elapsedMs: number;
  readonly usage?: VisionPaperLlmCallResult['usage'];
};
export async function resolveVisionIntakeTarget(): Promise<{ config: VisionLlmConfig; route: string } | null> {
  const fromEnv = readVisionLlmConfigFromEnv();
  if (fromEnv) return { config: fromEnv, route: 'env' };
  for (const task of ['preparation', 'companion'] as const) {
    const settings = await loadSettings(task).catch(() => null);
    if (!settings?.baseUrl || !settings.model || settings.protocol === 'anthropic' || isWeakVisionModel(settings.model)) continue;
    return { config: { baseUrl: settings.baseUrl, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}), model: settings.model }, route: task };
  }
  return null;
}
export async function resolveVisionIntakeConfig(): Promise<VisionLlmConfig | null> {
  return (await resolveVisionIntakeTarget())?.config ?? null;
}
export async function enqueueVisionIntake(tx: DbTransaction, tick: Tick, intakeId: string) {
  await tx.query(`INSERT INTO slot_state (learner_id,slot_type,slot_key,scope_keys,changed_tick)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [tx.learner, visionIntakeSlot, intakeId, '{}', tick]);
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
export async function completeVisionIntake(db: Db, runtime: { modules: LoadedModule[]; crossModuleWrites: CrossModuleWrites }, hooks: CommandHooks, ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction, telemetry?: readonly VisionOcrCallTelemetry[]) {
  const { document, material } = input;
  const complete = createCommandHandler(db, { ...runtime, hooks: { ...hooks, async onFactsChanged(tx, tick, changes) {
      const work = await readReadyWork(tx, ref);
      if (!isExpectedVisionCompletion(work, visionIntakeSlot, document.ref, material.ref, changes)) throw new RequestError(409, '交入工作已更改。');
      await hooks.onFactsChanged(tx, tick, changes);
      for (const entry of telemetry ?? []) await recordCompletedEffect(tx, tick, {
        ownerKind: 'session', ownerId: material.ref.id,
        stepKey: `vision-ocr:r${document.ref.rev}:p${entry.page}`, label: 'vision-ocr',
        providerEffectId: `vision-ocr:${ref.workId}:g${ref.generation}:p${entry.page}`,
        input: { model: entry.requestedModel, page: entry.page, totalPages: entry.totalPages },
        result: { reportedModel: entry.reportedModel, elapsedMs: entry.elapsedMs, route: entry.route, ...(entry.usage ? { usage: entry.usage } : {}) },
      });
    } },
  });
  await complete({ learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: completeVisionIntakeCommand,
    id: commandId(stableId('intake-vision-result', ref.workId, ref.generation)),
    input: { intakeId: document.ref.id, expectedRev: document.ref.rev, expectedMaterialRev: material.ref.rev, extraction } });
}

class StoppedVisionIntake extends Error {}
const stopped = (error: unknown) => error instanceof StoppedVisionIntake || error instanceof RequestError || isFactUnavailable(error);
export function openVisionIntakeWork(db: Db, intake: {
  cloudOriginal(materialId: string, sha256: string): Promise<Buffer>;
  originalPage(materialId: string, page: number): Promise<{ original: { name: string; mediaType: string }; bytes: Buffer }>;
  completeVision(ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction, telemetry?: readonly VisionOcrCallTelemetry[]): Promise<void>;
}, deps: { resolveVisionConfig?: () => VisionLlmConfig | null | Promise<VisionLlmConfig | null>; fetch?: typeof fetch; fallbackExtractLocal?: (kind:string,path:string,bytes:Buffer,limit:number) => Promise<LocalExtractionResult> } = {}) {
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
      const publish = async (extraction: IntakeExtraction, telemetry?: readonly VisionOcrCallTelemetry[]) => {
        await intake.completeVision(ref, frozen, extraction, telemetry);
        await finishWork(db, ref);
      };
      if (terminalFailure) return void await publish(failedVisionExtraction('视觉识别未能在规定时间内完成。'));
      const plan = planMultiPageVisionWork(frozen.value);
      if (plan.pagesToRun.length === 0) {
        return void await publish(completeMultiPageVisionExtraction(plan.preservedPages, { titleHint: frozen.value.title }));
      }
      const allPages = intakeDocumentPages(frozen.value);
      const pageInputs = [] as { page: number; bytes: Buffer; storedPath: string; name: string }[];
      for (const page of plan.pagesToRun) {
        const entry = allPages.find(item => item.page === page.page);
        if (!entry) return void await publish(failedVisionExtraction(`第 ${page.page} 页原件缺少元数据。`, 'vision_llm', plan.totalPages));
        const result = await intake.originalPage(frozen.material.ref.id, page.page).catch(() => null);
        if (!result || result.bytes === null) return void await publish(failedVisionExtraction(`第 ${page.page} 页原件无法读取。`, 'vision_llm', plan.totalPages));
        pageInputs.push({ page: page.page, bytes: result.bytes, storedPath: '', name: entry.name });
      }
      const directory = await mkdtemp(join(tmpdir(), 'mangekyo-vision-'));
      try {
        for (const input of pageInputs) {
          input.storedPath = join(directory, `page-${input.page}`);
          await writeFile(input.storedPath, input.bytes, { mode: 0o600 });
        }
        await db.snapshot({ learner: learnerId(ref.learner) }, unchanged);
        const resolved = 'resolveVisionConfig' in deps && deps.resolveVisionConfig
          ? { config: await deps.resolveVisionConfig(), route: 'custom' }
          : await resolveVisionIntakeTarget();
        const visionConfig = resolved?.config ?? null;
        const outcomes = await extractMultiPagePaperWithVisionOrFallback({
          pages: pageInputs.map(input => {
            const prompt = buildVisionPaperOcrPrompt({ filename: input.name, titleHint: frozen.value.title, pageNumber: input.page, totalPages: plan.totalPages });
            return { page: input.page, bytes: input.bytes, storedPath: input.storedPath, systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt };
          }),
          textLimit: intakeTextLimit, visionConfig, signal, ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.fallbackExtractLocal ? { fallbackExtractLocal: deps.fallbackExtractLocal } : {}),
          parseStructuredOutput: parseStructuredPaperOcr,
        });
        await db.snapshot({ learner: learnerId(ref.learner) }, unchanged);
        const telemetry: VisionOcrCallTelemetry[] = outcomes.pages.flatMap(item => item.outcome.kind === 'vision_llm'
          ? [{ page: item.page, totalPages: plan.totalPages, route: resolved?.route ?? 'custom',
            requestedModel: visionConfig?.model ?? '', reportedModel: item.outcome.model,
            elapsedMs: item.outcome.elapsedMs, ...(item.outcome.usage ? { usage: item.outcome.usage } : {}) }]
          : []);
        await publish(completeMultiPageVisionExtraction(
          [...plan.preservedPages, ...outcomes.pages.map(item => item.outcome.kind === 'vision_llm'
            ? { page: item.page, kind: 'vision_llm' as const, ocr: item.outcome.parsed }
            : { page: item.page, kind: 'vision_fallback' as const, fallbackReason: item.outcome.fallbackReason, local: item.outcome.local })],
          { titleHint: frozen.value.title },
        ), telemetry);
      } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    } catch (error) {
      if (stopped(error)) await cancelWork(db, ref);
      else throw error;
    }
  }
  return { execute };
}
