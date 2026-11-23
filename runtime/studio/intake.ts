import { extractLocalDocument, identifyLocalDocument } from '@mangekyo/executor-document-extraction/local';
import { mineruSupports } from '@mangekyo/executor-document-extraction/mineru';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CommandHooks, CrossModuleWrites } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { Db, DbTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import type { WorkRef } from '../../kernel/src/work/index.ts';
import * as intakeOps from '../../modules/capture/intake-operations.ts';
import { buildWorkbookDraftFromIntakeSelection, projectIntakeQuestionCards, type IntakeWorkbookSelection } from '../../modules/capture/intake-question-cards.ts';
import { appendIntakePagesCommand, captureIntakeCommand, completeCloudIntakeCommand, completeVisionIntakeCommand, correctIntakeCommand, intakeDocument, intakeDocumentPages, intakePurpose, intakeTextLimit, pendingMineruExtraction, pendingVisionExtraction, retryVisionIntakeCommand, setIntakeResearchCommand, type IntakeExtraction } from '../../modules/capture/intake-values.ts';
import type { IntakeMetadata } from '../../modules/capture/intake-view.ts';
import type { paperReturnSelection } from '../../modules/capture/paper.ts';
import { clientRequest, submittedWatermark } from '../../modules/capture/request.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import { assetType as questionAssetType, classifyConfirmIntakeError, confirmIntakeQuestionsCommand, parseBankConfirmRequest, summarizeIntakeQuestionConfirmation } from '../../modules/content/intake-question-bank.ts';
import { questionMetaDraftType, questionStateType } from '../../modules/content/question-state.ts';
import { materialType } from '../../modules/content/text-material.ts';
import type { openCapturePapers } from './capture-papers.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { createCommandReadContext, FactReadDeniedError, isFactUnavailable } from './fact-read-helpers.ts';
import { stableId, studioLearner } from './identity.ts';
import { cloudIntakeSlot, enqueueCloudIntake, mineruToken, type CloudIntakeInput } from './intake-cloud.ts';
import { completeIntakeWorkCommand, intakeCaptureId, intakeIdFor, openIntakeLifecycle } from './intake-lifecycle.ts';
import { digest, openIntakeObjects } from './intake-objects.ts';
import { completeVisionIntake, enqueueVisionIntake, resolveVisionIntakeConfig, type VisionIntakeInput, type VisionOcrCallTelemetry } from './intake-vision.ts';
import { RequestError } from './sessions.ts';

export { intakeSwiftTimeoutMs } from '@mangekyo/executor-document-extraction/local';
export type { IntakeMetadata } from '../../modules/capture/intake-view.ts';

type CaptureInput = Omit<intakeOps.IntakeCaptureInput, 'bytes'> & { readonly bytes: Buffer };
type PagesCaptureInput = Omit<intakeOps.IntakeMultiPageCaptureInput<Buffer>, 'pages'> & {
  readonly pages: readonly { filename?: unknown; declaredType?: unknown; bytes: Buffer }[];
};

export const intakeWriteTargets = {
  [captureIntakeCommand]: { create: [materialType] }, [correctIntakeCommand]: { correct: [materialType] },
  [completeCloudIntakeCommand]: { correct: [materialType] }, [completeVisionIntakeCommand]: { correct: [materialType] },
  [retryVisionIntakeCommand]: { correct: [materialType] }, [appendIntakePagesCommand]: { correct: [materialType] },
  [confirmIntakeQuestionsCommand]: { create: [questionAssetType, questionStateType, questionMetaDraftType] },
} satisfies CrossModuleWrites;

const prepareDeps = {
  isBuffer: Buffer.isBuffer, parseWatermark: submittedWatermark,
  materialIdFor: (requestId: string) => factId(stableId('intake-material', requestId)),
  identify: (bytes: Uint8Array, ext: string, declaredType: unknown) => identifyLocalDocument(bytes as Buffer, ext, declaredType),
  sha256: (bytes: Uint8Array) => digest(bytes as Buffer),
};

export function openIntake(db: Db, captureModule: LoadedModule, content: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks(), workbook?: { save(input: unknown): Promise<{ id: string }> }) {
  const runtime = { modules: [captureModule, content], crossModuleWrites: intakeWriteTargets };
  const handle = createCommandHandler(db, { ...runtime, hooks }), objects = openIntakeObjects(db);
  const lifecycle = openIntakeLifecycle(db, objects.erase);
  const saveWith = (beforeHooks: (tx: DbTransaction, tick: Tick) => Promise<void>) => createCommandHandler(db, {
    ...runtime, hooks: { async onFactsChanged(tx, tick, changes) { await beforeHooks(tx, tick); await hooks.onFactsChanged(tx, tick, changes); } },
  });

  async function factsFor(materialId: string, watermark?: string) {
    const id = factId(materialId), intakeId = intakeIdFor(id);
    return db.snapshot({ learner: studioLearner }, async tx => {
      if (watermark !== undefined) await lifecycle.checkCapture(tx, id, watermark);
      const read = createCommandReadContext(tx, intakePurpose), material = await read.fact(id, { mode: 'following' });
      if (watermark !== undefined && material.type === captureSourceType) throw new RequestError(409, '同一个请求标识已用于纸卷拍回。');
      return { id, material, document: await read.fact(intakeId, { mode: 'following' }), intakeId };
    });
  }

  const readFacts = async (materialId: string, watermark?: string) => {
    try { return await factsFor(materialId, watermark); }
    catch (error) { throw intakeOps.translateIntakeReadError(error, error instanceof LifecycleError, error instanceof FactReadDeniedError); }
  };

  async function metadataFor(materialId: string, watermark?: string): Promise<IntakeMetadata & { questionCards: ReturnType<typeof projectIntakeQuestionCards> }> {
    const f = await readFacts(materialId, watermark);
    return { ...intakeOps.projectIntakeFacts(f.id, f.material.value, f.document.value, f.document.ref.rev, f.document.purpose),
      questionCards: projectIntakeQuestionCards(f.document.value) };
  }

  const metadataOrNull = async (materialId: string, watermark: string) => {
    try { return await metadataFor(materialId, watermark); }
    catch (error) { if (error instanceof RequestError && error.status === 404) return null; throw error; }
  };

  async function originalFor(materialId: string) {
    const id = factId(materialId);
    const original = await db.snapshot({ learner: studioLearner }, async tx => {
      try { return intakeOps.extractPaperReturnOriginal(await createCommandReadContext(tx, intakePurpose).fact(id, { mode: 'following' }), id); }
      catch (error) { if (!isFactUnavailable(error)) throw error; return null; }
    });
    const metadata = original ? { original } : await metadataFor(id);
    return { metadata, stored: metadata.original, bytes: await objects.read(id, metadata.original) };
  }

  async function commitCapture(
    materialId: FactId, requestId: string, deletionWatermark: string, matches: (prior: IntakeMetadata) => boolean,
    stage: (commit: (install: () => Promise<void>, commandInput: Json, enqueue?: (tx: DbTransaction, tick: Tick) => Promise<void>) => Promise<void>) => Promise<void>,
  ) {
    const prior = await metadataOrNull(materialId.toString(), deletionWatermark);
    if (prior) {
      if (!matches(prior)) throw new RequestError(409, '同一个请求标识已经用于不同文件或标题。');
      return { ...prior, created: false };
    }
    let installed = false;
    try {
      await stage((install, commandInput, enqueue) =>
        saveWith(async (tx, tick) => { await install(); installed = true; await enqueue?.(tx, tick); })({
          learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: captureIntakeCommand,
          id: intakeCaptureId(requestId), deletionWatermark, input: commandInput,
        }).then(() => undefined));
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      const raced = await metadataOrNull(materialId.toString(), deletionWatermark);
      if (raced && matches(raced)) return { ...raced, created: false };
      if (raced || (error instanceof Error && error.message === 'Command ID already used with a different command identity'))
        throw new RequestError(409, '同一个请求标识已经用于不同内容。');
      throw error;
    }
    return { ...(await metadataFor(materialId)), created: installed };
  }

  async function capture(input: CaptureInput) {
    const { requestId, materialId, deletionWatermark, detected, title, original } = intakeOps.prepareIntakeCapture(input, prepareDeps);
    const intakeId = intakeIdFor(materialId);
    const { requested, cloud, asyncVision } = intakeOps.resolveCaptureExtraction(input.extraction, detected.mediaType, mineruSupports, { asyncPhotoDefault: true });
    if (cloud && !mineruToken()) throw new RequestError(503, 'MinerU 云识别尚未配置。');
    return commitCapture(materialId, requestId, deletionWatermark,
      prior => intakeOps.matchesCaptureReplay(prior, original, title, detected.mediaType, requested),
      commit => objects.withOriginal(materialId, input.bytes, original, async (staged, install) => {
        const extraction: IntakeExtraction = cloud ? pendingMineruExtraction() : asyncVision ? pendingVisionExtraction('queued')
          : await extractLocalDocument(detected.kind, staged, input.bytes, intakeTextLimit);
        await commit(install, {
          materialId, intakeId, title, original, extraction, savedAt: new Date().toISOString(),
          ...(cloud ? { requestedExtraction: 'mineru' } : asyncVision ? { requestedExtraction: 'vision_llm' } : {}),
        }, cloud ? (tx, tick) => enqueueCloudIntake(tx, tick, intakeId)
          : asyncVision ? (tx, tick) => enqueueVisionIntake(tx, tick, intakeId) : undefined);
      }));
  }

  async function capturePages(input: PagesCaptureInput) {
    const { requestId, materialId, deletionWatermark, title, original, originals, pages } = intakeOps.prepareIntakeMultiPageCapture(input, prepareDeps);
    const intakeId = intakeIdFor(materialId);
    const { requested, asyncVision } = intakeOps.resolveCaptureExtraction(
      input.extraction === undefined && pages.length === 1 ? 'vision_llm' : input.extraction, original.mediaType, mineruSupports, { asyncPhotoDefault: true });
    if (requested === 'mineru') throw new RequestError(400, '多页合并拍卷仅支持视觉模型识别。');
    if (!asyncVision) throw new RequestError(415, '多页合并拍卷仅支持视觉模型识别。');
    return commitCapture(materialId, requestId, deletionWatermark,
      prior => intakeOps.matchesMultiPageCaptureReplay(prior, originals, title, requested),
      commit => objects.withOriginals(materialId, pages.map(item => ({ bytes: item.bytes as Buffer, original: item.original })),
        (_staged, install) => commit(install, {
          materialId, intakeId, title, original, originals, extraction: pendingVisionExtraction('queued', { pageCount: originals.length }),
          savedAt: new Date().toISOString(), requestedExtraction: 'vision_llm',
        }, (tx, tick) => enqueueVisionIntake(tx, tick, intakeId))));
  }

  async function appendPages(input: intakeOps.IntakeAppendPagesInput<Buffer>) {
    const { materialId, requestId, data, pages } = intakeOps.prepareIntakeAppendPages(input, intakeIdFor, prepareDeps);
    let installed = false;
    try {
      const current = await factsFor(materialId.toString());
      const startPage = intakeDocumentPages(intakeDocument(current.document.value)).length + 1;
      if (current.document.ref.rev !== data.expectedRev) throw new RequestError(409, '原文版本已经变更，请刷新后再续拍加页。');
      await objects.appendOriginals(materialId, startPage, pages.map(p => ({ bytes: p.bytes as Buffer, original: p.original })),
        (_staged, install) => saveWith(async (tx, tick) => { await install(); installed = true; await enqueueVisionIntake(tx, tick, data.intakeId); })({
          learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: appendIntakePagesCommand,
          id: commandId(stableId('intake-append-pages', requestId)), input: data,
        }), { whenUncommitted: async undo => {
          const now = await factsFor(materialId.toString()).catch(() => null);
          if (!(now ? intakeDocumentPages(intakeDocument(now.document.value)) : []).some(p => p.page >= startPage)) await undo();
        } });
    } catch (error) { throw intakeOps.translateIntakeAppendPagesError(error, error instanceof FactReadDeniedError); }
    return { ...(await metadataFor(materialId.toString())), created: installed };
  }

  async function runMaterialCommand(
    materialId: string, type: string, id: ReturnType<typeof commandId>, input: Json,
    translateError: (error: unknown, isDenied: boolean) => unknown, exec = handle,
  ) {
    try { await exec({ learner: studioLearner, actor: 'learner', purpose: intakePurpose, type, id, input }); }
    catch (error) { throw translateError(error, error instanceof FactReadDeniedError); }
    return metadataFor(materialId);
  }

  async function confirmDrafts(materialId: string, input: unknown, workbookOverride = workbook) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, '拍卷确认请求格式无效。');
    const value = input as Record<string, unknown>;
    if (value.mode === 'workbook') {
      const target = workbookOverride ?? workbook;
      if (!target) throw new RequestError(500, '练习模块未启用。');
      const facts = await readFacts(materialId);
      let draft;
      try { draft = buildWorkbookDraftFromIntakeSelection(facts.document.value, value as IntakeWorkbookSelection); }
      catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '微卷选题格式无效。'); }
      const saved = await target.save({ requestId: value.requestId, title: draft.title, materialId: draft.materialId, questions: draft.questions });
      return { kind: 'workbook' as const, paperId: saved.id, href: '/papers/' + saved.id, title: draft.title, questionCount: draft.questions.length };
    }
    if (value.mode !== 'bank') throw new RequestError(400, '拍卷确认方式无效。');
    const requestId = clientRequest(value.requestId);
    let data;
    try { data = parseBankConfirmRequest(materialId, value); }
    catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '拍卷题目确认无效。'); }
    let receipt;
    try {
      receipt = await handle({ learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: confirmIntakeQuestionsCommand,
        id: commandId(stableId('intake-question-confirmation', requestId)), input: data });
    } catch (error) {
      const mapped = classifyConfirmIntakeError(error, isFactUnavailable(error));
      if (mapped) throw new RequestError(mapped.status, mapped.message);
      throw error;
    }
    const summary = await db.snapshot({ learner: studioLearner }, tx =>
      summarizeIntakeQuestionConfirmation(createCommandReadContext(tx, intakePurpose), data, receipt.wrote));
    return { kind: 'bank' as const, ...summary };
  }

  return {
    lifecycle, capture, capturePages, appendPages, confirmDrafts, metadata: metadataFor, original: originalFor,
    cloudOriginal: (materialId: string, sha256: string) => objects.read(materialId, { sha256 }),
    originalPage: async (materialId: string, page: number) => {
      const facts = await factsFor(materialId);
      const entry = intakeDocumentPages(intakeDocument(facts.document.value)).find(item => item.page === page);
      if (!entry) throw new RequestError(404, '找不到该页原件。');
      return { original: entry, bytes: await objects.readPage(facts.id, page, entry) };
    },
    paperReturn: (input: CaptureInput & Parameters<typeof paperReturnSelection>[0], papers: ReturnType<typeof openCapturePapers>) => {
      const { requestId, materialId, deletionWatermark, detected, title, original } = intakeOps.prepareIntakeCapture(input, prepareDeps);
      return objects.withOriginal(materialId, input.bytes, original, (_, install) =>
        papers.upload(intakeOps.resolvePaperReturnSelection(input, materialId, detected.kind),
          { command: intakeCaptureId(requestId), deletionWatermark, title, original, install }));
    },
    completeCloud: (ref: WorkRef, input: CloudIntakeInput, extraction: IntakeExtraction) =>
      completeIntakeWorkCommand(db, runtime, hooks, ref, input, extraction,
        { slotType: cloudIntakeSlot, commandType: completeCloudIntakeCommand, stableTag: 'intake-mineru-result' }),
    completeVision: (ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction, telemetry?: readonly VisionOcrCallTelemetry[]) =>
      completeVisionIntake(db, runtime, hooks, ref, input, extraction, telemetry),
    correct: (input: intakeOps.IntakeCorrectInput) => {
      const { materialId, requestId, data } = intakeOps.prepareIntakeCorrection(input, intakeIdFor);
      return runMaterialCommand(materialId.toString(), correctIntakeCommand, commandId(stableId('intake-correction', requestId)), data, intakeOps.translateIntakeCorrectionError);
    },
    retryVision: (input: intakeOps.IntakeRetryVisionInput) => {
      const { materialId, requestId, data } = intakeOps.prepareIntakeVisionRetry(input, intakeIdFor);
      return runMaterialCommand(materialId.toString(), retryVisionIntakeCommand, commandId(stableId('intake-vision-retry', requestId)), data,
        intakeOps.translateIntakeVisionRetryError, saveWith((tx, tick) => enqueueVisionIntake(tx, tick, data.intakeId)));
    },
    setResearch: (materialId: string, input: unknown) => {
      const { id, data } = intakeOps.prepareIntakeResearchPermission(materialId, input, intakeIdFor);
      return runMaterialCommand(id, setIntakeResearchCommand, commandId(stableId('intake-research', id, String(data.expectedRev), String(data.enabled))), data, intakeOps.translateIntakeResearchError);
    },
    questionCards: async (materialId: string) => {
      const f = await readFacts(materialId);
      return { materialId: f.id, materialRev: f.material.ref.rev, intakeRev: f.document.ref.rev,
        title: intakeOps.projectIntakeFacts(f.id, f.material.value, f.document.value, f.document.ref.rev, f.document.purpose).title,
        questionCards: projectIntakeQuestionCards(f.document.value) };
    },
  };
}

function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

export async function readBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { request.resume(); throw new RequestError(413, '请求内容过长。'); }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function handleIntakeRequest(
  intake: ReturnType<typeof openIntake>, request: IncomingMessage, response: ServerResponse, pathname: string,
  method: string | undefined, papers?: ReturnType<typeof openCapturePapers>, workbook?: { save(input: unknown): Promise<{ id: string }> },
): Promise<boolean> {
  const cardRoute = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})\/(question-cards|confirm-drafts)$/.exec(pathname);
  if (cardRoute?.[1]) {
    const isCards = cardRoute[2] === 'question-cards';
    if (method !== (isCards ? 'GET' : 'POST')) return json(response, 405, { error: '这个入口只接受指定操作。' }), true;
    try {
      const result = isCards ? await intake.questionCards(cardRoute[1])
        : await intake.confirmDrafts(cardRoute[1], JSON.parse((await readBody(request, 1_048_576)).toString('utf8')), workbook);
      return json(response, isCards ? 200 : 201, result), true;
    } catch (error) {
      const formatted = intakeOps.formatIntakeErrorResponse(error, isCards ? '这份材料的核对卡无法读取。' : '拍卷确认未能完成。',
        { syntaxMessage: error instanceof SyntaxError ? error.message : undefined });
      return json(response, formatted.status, formatted.body), true;
    }
  }
  if (!intakeOps.parseIntakeRoute(pathname, method)) return false;
  const visionOcr = method === 'GET' && pathname === '/api/intake/options' ? Boolean(await resolveVisionIntakeConfig()) : false;
  const outcome = await intakeOps.dispatchIntakeHttp(pathname, method, {
    headers: request.headers, readBody: limit => readBody(request, limit), fromArrayBuffer: buf => Buffer.from(buf),
    decodeUtf8Bytes: bytes => bytes.toString('utf8'), parseWatermark: submittedWatermark,
    readLifecycleError: (error, includeCode) => error instanceof LifecycleError
      ? { status: error.status, message: error.message, ...(includeCode ? { code: error.code } : {}) } : null,
    mineruEnabled: () => Boolean(mineruToken()), visionOcrEnabled: () => visionOcr, hasPapers: Boolean(papers),
    lifecycleState: () => intake.lifecycle.state(), erase: (id, input) => intake.lifecycle.erase(id, input),
    metadata: intake.metadata, original: intake.original, originalPage: intake.originalPage, capture: intake.capture,
    capturePages: intake.capturePages, appendPages: intake.appendPages, paperReturn: input => intake.paperReturn(input, papers!),
    correct: intake.correct, setResearch: intake.setResearch, retryVision: intake.retryVision,
  });
  if (!outcome) return false;
  if (outcome.kind === 'bytes') return response.writeHead(outcome.status, outcome.headers), response.end(outcome.bytes), true;
  if (outcome.headers) for (const [name, value] of Object.entries(outcome.headers)) response.setHeader(name, value);
  return json(response, outcome.status, outcome.body), true;
}
