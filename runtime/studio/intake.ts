import { extractLocalDocument, identifyLocalDocument } from '@mangekyo/executor-document-extraction/local';
import { mineruSupports } from '@mangekyo/executor-document-extraction/mineru';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CrossModuleWrites } from '../../kernel/src/commands/contracts.ts';
import {commandId, factId, isFactUnavailable, isKernelErrorKind, LifecycleError, type CommandHooks, type Db, type DbTransaction, type FactId, type Json, type Tick} from '../../kernel/src/index.ts';
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
import { sendJson } from './http.ts';
import { parseRequest, stableId, studioHost, ulidPattern } from './identity.ts';
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
  const host = studioHost(db), runtime = { modules: [captureModule, content], crossModuleWrites: intakeWriteTargets };
  const exec = host.boundHandler(runtime.modules, hooks, undefined, { crossModuleWrites: intakeWriteTargets });
  const objects = openIntakeObjects(db), lifecycle = openIntakeLifecycle(db, objects.erase);
  const saveWith = (before: (tx: DbTransaction, tick: Tick) => Promise<void>) => host.boundHandler(runtime.modules, {
    async onFactsChanged(tx, tick, changes) { await before(tx, tick); await hooks.onFactsChanged(tx, tick, changes); },
  }, undefined, { crossModuleWrites: intakeWriteTargets });
  const factsFor = (materialId: string, watermark?: string) => {
    const id = factId(materialId), intakeId = intakeIdFor(id);
    return host.snapshot(async tx => {
      if (watermark !== undefined) await lifecycle.checkCapture(tx, id, watermark);
      const read = host.read(tx, intakePurpose), material = await read.fact(id, { mode: 'following' });
      if (watermark !== undefined && material.type === captureSourceType) throw new RequestError(409, '同一个请求标识已用于纸卷拍回。');
      return { id, material, document: await read.fact(intakeId, { mode: 'following' }), intakeId };
    });
  };
  const readFacts = (materialId: string, watermark?: string) => factsFor(materialId, watermark)
    .catch(e => { throw intakeOps.translateIntakeReadError(e, e instanceof LifecycleError, isFactUnavailable(e)); });
  const projectFacts = (f: Awaited<ReturnType<typeof factsFor>>) =>
    intakeOps.projectIntakeFacts(f.id, f.material.value, f.document.value, f.document.ref.rev, f.document.purpose);
  const metadataFor = async (materialId: string, watermark?: string):
    Promise<IntakeMetadata & { questionCards: ReturnType<typeof projectIntakeQuestionCards> }> => {
    const f = await readFacts(materialId, watermark);
    return { ...projectFacts(f), questionCards: projectIntakeQuestionCards(f.document.value) };
  };
  const metadataOrNull = (materialId: string, watermark: string) => metadataFor(materialId, watermark)
    .catch(e => e instanceof RequestError && e.status === 404 ? null : Promise.reject(e));
  const runCommand = async (materialId: string, type: string, id: ReturnType<typeof commandId>, input: Json,
    translate: (e: unknown, unavailable: boolean) => unknown, runner = exec) => {
    try { await runner({ purpose: intakePurpose, type, id, input }); } catch (error) { throw translate(error, isFactUnavailable(error)); }
    return metadataFor(materialId);
  };
  async function commitCapture(
    materialId: FactId, requestId: string, deletionWatermark: string, matches: (prior: IntakeMetadata) => boolean,
    stage: (commit: (install: () => Promise<void>, commandInput: Json, enqueue?: (tx: DbTransaction, tick: Tick) => Promise<void>) => Promise<void>) => Promise<void>,
  ) {
    const prior = await metadataOrNull(materialId, deletionWatermark);
    if (prior) { if (!matches(prior)) throw new RequestError(409, '同一个请求标识已经用于不同文件或标题。'); return { ...prior, created: false }; }
    let installed = false;
    try {
      await stage((install, commandInput, enqueue) => saveWith(async (tx, tick) => {
        await install(); installed = true; await enqueue?.(tx, tick);
      })({ purpose: intakePurpose, type: captureIntakeCommand, id: intakeCaptureId(requestId), deletionWatermark, input: commandInput }).then(() => undefined));
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      const raced = await metadataOrNull(materialId, deletionWatermark);
      if (raced && matches(raced)) return { ...raced, created: false };
      if (raced || isKernelErrorKind(error, 'duplicate_command')) throw new RequestError(409, '同一个请求标识已经用于不同内容。');
      throw error;
    }
    return { ...(await metadataFor(materialId)), created: installed };
  }
  return {
    lifecycle, metadata: metadataFor,
    cloudOriginal: (materialId: string, sha256: string) => objects.read(materialId, { sha256 }),
    original: async (materialId: string) => {
      const id = factId(materialId);
      const original = await host.snapshot(async tx => {
        const fact = await host.readOrNull(tx, intakePurpose, id, { mode: 'following' });
        return fact ? intakeOps.extractPaperReturnOriginal(fact, id) : null;
      });
      const metadata = original ? { original } : await metadataFor(id);
      return { metadata, stored: metadata.original, bytes: await objects.read(id, metadata.original) };
    },
    originalPage: async (materialId: string, page: number) => {
      const facts = await factsFor(materialId), entry = intakeDocumentPages(intakeDocument(facts.document.value)).find(item => item.page === page);
      if (!entry) throw new RequestError(404, '找不到该页原件。');
      return { original: entry, bytes: await objects.readPage(facts.id, page, entry) };
    },
    capture: async (input: CaptureInput) => {
      const { requestId, materialId, deletionWatermark, detected, title, original } = intakeOps.prepareIntakeCapture(input, prepareDeps);
      const intakeId = intakeIdFor(materialId);
      const { requested, cloud, asyncVision } = intakeOps.resolveCaptureExtraction(input.extraction, detected.mediaType, mineruSupports,
        { asyncPhotoDefault: true });
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
    },
    capturePages: async (input: PagesCaptureInput) => {
      const { requestId, materialId, deletionWatermark, title, original, originals, pages } =
        intakeOps.prepareIntakeMultiPageCapture(input, prepareDeps);
      const intakeId = intakeIdFor(materialId), { requested, asyncVision } = intakeOps.resolveCaptureExtraction(
        input.extraction === undefined && pages.length === 1 ? 'vision_llm' : input.extraction, original.mediaType, mineruSupports, { asyncPhotoDefault: true });
      if (requested === 'mineru' || !asyncVision) throw new RequestError(requested === 'mineru' ? 400 : 415, '多页合并拍卷仅支持视觉模型识别。');
      return commitCapture(materialId, requestId, deletionWatermark,
        prior => intakeOps.matchesMultiPageCaptureReplay(prior, originals, title, requested),
        commit => objects.withOriginals(materialId, pages.map(item => ({ bytes: item.bytes as Buffer, original: item.original })),
          (_staged, install) => commit(install, {
            materialId, intakeId, title, original, originals, extraction: pendingVisionExtraction('queued', { pageCount: originals.length }),
            savedAt: new Date().toISOString(), requestedExtraction: 'vision_llm',
          }, (tx, tick) => enqueueVisionIntake(tx, tick, intakeId))));
    },
    appendPages: async (input: intakeOps.IntakeAppendPagesInput<Buffer>) => {
      const { materialId, requestId, data, pages } = intakeOps.prepareIntakeAppendPages(input, intakeIdFor, prepareDeps);
      let installed = false;
      try {
        const current = await factsFor(materialId), startPage = intakeDocumentPages(intakeDocument(current.document.value)).length + 1;
        if (current.document.ref.rev !== data.expectedRev) throw new RequestError(409, '原文版本已经变更，请刷新后再续拍加页。');
        await objects.appendOriginals(materialId, startPage, pages.map(p => ({ bytes: p.bytes as Buffer, original: p.original })),
          (_staged, install) => saveWith(async (tx, tick) => { await install(); installed = true; await enqueueVisionIntake(tx, tick, data.intakeId); })({
            purpose: intakePurpose, type: appendIntakePagesCommand, id: commandId(stableId('intake-append-pages', requestId)), input: data,
          }), { whenUncommitted: async undo => {
            const now = await factsFor(materialId).catch(() => null);
            if (!(now ? intakeDocumentPages(intakeDocument(now.document.value)) : []).some(p => p.page >= startPage)) await undo();
          } });
      } catch (error) { throw intakeOps.translateIntakeAppendPagesError(error, isFactUnavailable(error)); }
      return { ...(await metadataFor(materialId)), created: installed };
    },
    confirmDrafts: async (materialId: string, input: unknown, workbookOverride = workbook) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, '拍卷确认请求格式无效。');
      const value = input as Record<string, unknown>;
      if (value.mode === 'workbook') {
        const target = workbookOverride ?? workbook;
        if (!target) throw new RequestError(500, '练习模块未启用。');
        const facts = await readFacts(materialId);
        const draft = parseRequest(() => buildWorkbookDraftFromIntakeSelection(facts.document.value, value as IntakeWorkbookSelection), '微卷选题格式无效。');
        const saved = await target.save({ requestId: value.requestId, title: draft.title, materialId: draft.materialId, questions: draft.questions });
        return { kind: 'workbook' as const, paperId: saved.id, href: '/papers/' + saved.id, title: draft.title, questionCount: draft.questions.length };
      }
      if (value.mode !== 'bank') throw new RequestError(400, '拍卷确认方式无效。');
      const requestId = clientRequest(value.requestId), data = parseRequest(() => parseBankConfirmRequest(materialId, value), '拍卷题目确认无效。');
      const receipt = await exec({ purpose: intakePurpose, type: confirmIntakeQuestionsCommand,
        id: commandId(stableId('intake-question-confirmation', requestId)), input: data }).catch(error => {
        const mapped = classifyConfirmIntakeError(error, isFactUnavailable(error));
        throw mapped ? new RequestError(mapped.status, mapped.message) : error;
      });
      return { kind: 'bank' as const, ...await host.snapshot(tx => summarizeIntakeQuestionConfirmation(host.read(tx, intakePurpose), data, receipt.wrote)) };
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
      return runCommand(materialId, correctIntakeCommand, commandId(stableId('intake-correction', requestId)), data,
        intakeOps.translateIntakeCorrectionError);
    },
    retryVision: (input: intakeOps.IntakeRetryVisionInput) => {
      const { materialId, requestId, data } = intakeOps.prepareIntakeVisionRetry(input, intakeIdFor);
      return runCommand(materialId, retryVisionIntakeCommand, commandId(stableId('intake-vision-retry', requestId)), data,
        intakeOps.translateIntakeVisionRetryError, saveWith((tx, tick) => enqueueVisionIntake(tx, tick, data.intakeId)));
    },
    setResearch: (materialId: string, input: unknown) => {
      const { id, data } = intakeOps.prepareIntakeResearchPermission(materialId, input, intakeIdFor);
      return runCommand(id, setIntakeResearchCommand, commandId(stableId('intake-research', id, String(data.expectedRev), String(data.enabled))),
        data, intakeOps.translateIntakeResearchError);
    },
    questionCards: async (materialId: string) => {
      const f = await readFacts(materialId);
      return { materialId: f.id, materialRev: f.material.ref.rev, intakeRev: f.document.ref.rev,
        title: projectFacts(f).title, questionCards: projectIntakeQuestionCards(f.document.value) };
    },
  };
}
export async function readBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if ((size += chunk.length) > limit) { request.resume(); throw new RequestError(413, '请求内容过长。'); }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
const cardRouteRegex = new RegExp(`^/api/materials/(${ulidPattern})/(question-cards|confirm-drafts)$`);
export async function handleIntakeRequest(
  intake: ReturnType<typeof openIntake>, request: IncomingMessage, response: ServerResponse, pathname: string,
  method: string | undefined, papers?: ReturnType<typeof openCapturePapers>, workbook?: { save(input: unknown): Promise<{ id: string }> },
): Promise<boolean> {
  const cardRoute = cardRouteRegex.exec(pathname);
  if (cardRoute?.[1]) {
    const isCards = cardRoute[2] === 'question-cards';
    if (method !== (isCards ? 'GET' : 'POST')) return sendJson(response, 405, { error: '这个入口只接受指定操作。' }), true;
    try {
      const result = isCards ? await intake.questionCards(cardRoute[1])
        : await intake.confirmDrafts(cardRoute[1], JSON.parse((await readBody(request, 1_048_576)).toString('utf8')), workbook);
      return sendJson(response, isCards ? 200 : 201, result), true;
    } catch (error) {
      const formatted = intakeOps.formatIntakeErrorResponse(error, isCards ? '这份材料的核对卡无法读取。' : '拍卷确认未能完成。',
        { syntaxMessage: error instanceof SyntaxError ? error.message : undefined });
      return sendJson(response, formatted.status, formatted.body), true;
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
    ...intake, paperReturn: input => intake.paperReturn(input, papers!),
  });
  if (!outcome) return false;
  if (outcome.kind === 'bytes') return response.writeHead(outcome.status, outcome.headers), response.end(outcome.bytes), true;
  if (outcome.headers) for (const [name, value] of Object.entries(outcome.headers)) response.setHeader(name, value);
  return sendJson(response, outcome.status, outcome.body), true;
}
