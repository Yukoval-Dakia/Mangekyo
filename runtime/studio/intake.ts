import { extractLocalDocument, identifyLocalDocument } from '@mangekyo/executor-document-extraction/local';
import { mineruSupports } from '@mangekyo/executor-document-extraction/mineru';
import { openIntakeObjects, digest } from './intake-objects.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../kernel/src/db/types.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks, CrossModuleWrites } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { readReadyWork, requestWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { materialType } from '../../modules/content/text-material.ts';
import { appendIntakePagesCommand, captureIntakeCommand, completeCloudIntakeCommand, completeVisionIntakeCommand,
  correctIntakeCommand, retryVisionIntakeCommand, pendingMineruExtraction, pendingVisionExtraction, intakePurpose,
  intakeTextLimit, setIntakeResearchCommand, intakeDocument, intakeDocumentPages,
  type IntakeExtraction } from '../../modules/capture/intake-values.ts';
import { buildWorkbookDraftFromIntakeSelection, projectIntakeQuestionCards,
  type IntakeWorkbookSelection } from '../../modules/capture/intake-question-cards.ts';
import {
  assetType as questionAssetType,
  confirmIntakeQuestionsCommand,
  intakeQuestionId,
  parseConfirmIntakeQuestions,
  summarizeIntakeQuestionConfirmation,
} from '../../modules/content/intake-question-bank.ts';
import { questionMetaDraftType, questionStateType } from '../../modules/content/question-state.ts';
import * as intakeOps from '../../modules/capture/intake-operations.ts';
import type { IntakeAppendPagesInput, IntakeCaptureInput, IntakeCorrectInput, IntakeMultiPageCaptureInput,
  IntakeRetryVisionInput } from '../../modules/capture/intake-operations.ts';
import type { IntakeMetadata } from '../../modules/capture/intake-view.ts';
import type { IntakeOriginal } from '../../modules/capture/intake-values.ts';
import {
  buildIntakeWriteTargets,
  intakeCommandInput,
  intakeExtractionInput,
  intakeQuestionCardsView,
  intakeRacedConflict,
  intakeMetadataView,
  intakePrepareAdapters,
  checkIntakeReplay,
  metadataOrNullFor,
  runIntakeCardRoute,
  intakeOriginalPage,
  runIntakeAppendPages,
  writeIntakeOutcome,
  intakeDispatchAdapter,
  cloudCompletionHandler,
  intakeFactsFor,
  intakeOriginalFor,
  captureRequestedExtraction,
  stagedExtractionFor,
  completeCloudIntakeInput,
  isCommandIdentityConflict,
  multiPageIntakeCommandInput,
  parseIntakeCardRoute,
  parseIntakeConfirmDraftsInput,
  requireBankConfirmation,
  requireMineruConfigured,
  requireMultiPageVision,
  requireWorkbookAvailable,
  runIntakeStagedSave,
  runBankConfirmation,
  runHandledIntakeCommand,
  runWorkbookConfirmation,
  runIntakeRead,
} from '../../modules/capture/studio-intake-helpers.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { cloudIntakeSlot, enqueueCloudIntake, mineruToken, type CloudIntakeInput } from './intake-cloud.ts';
import { completeVisionIntake, enqueueVisionIntake, resolveVisionIntakeConfig, type VisionIntakeInput } from './intake-vision.ts';
import { visionIntakeDeriver, visionIntakeSlot } from '../../modules/capture/vision-paper-ocr.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import type { paperReturnSelection } from '../../modules/capture/paper.ts';
import type { openCapturePapers } from './capture-papers.ts';
import { intakeCaptureId, intakeIdFor, openIntakeLifecycle } from './intake-lifecycle.ts';
import { clientRequest, submittedWatermark } from '../../modules/capture/request.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';

export { intakeSwiftTimeoutMs } from '@mangekyo/executor-document-extraction/local';

export type { IntakeMetadata } from '../../modules/capture/intake-view.ts';

type CaptureInput = Omit<IntakeCaptureInput, 'bytes'> & { readonly bytes: Buffer };

export const intakeWriteTargets = buildIntakeWriteTargets({
  captureIntakeCommand, correctIntakeCommand, completeCloudIntakeCommand, completeVisionIntakeCommand,
  retryVisionIntakeCommand, appendIntakePagesCommand, confirmIntakeQuestionsCommand,
  materialType, questionAssetType, questionStateType, questionMetaDraftType,
}) satisfies CrossModuleWrites;

export function openIntake(db: Db, captureModule: LoadedModule, content: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks(), workbook?: { save(input: unknown): Promise<{id: string}> }) {
  const runtime = { modules: [captureModule, content], crossModuleWrites: intakeWriteTargets };
  const handle = createCommandHandler(db, { ...runtime, hooks });
  const objects = openIntakeObjects(db);
  const lifecycle = openIntakeLifecycle(db, objects.erase);

  const factsHost = {
    snapshot: <T>(read: (tx: import('../../kernel/src/db/types.ts').ReadTransaction) => Promise<T>) => db.snapshot({ learner: studioLearner }, read) as Promise<T>,
    checkCapture: (tx: import('../../kernel/src/db/types.ts').ReadTransaction, id: FactId, watermark: string) => lifecycle.checkCapture(tx, id, watermark),
    readContext: (tx: import('../../kernel/src/db/types.ts').ReadTransaction) => createCommandReadContext(tx, intakePurpose) as never,
    intakeIdFor,
    factId,
    captureSourceType,
  };
  const factsFor = (materialId: string, watermark?: string) => intakeFactsFor(factsHost as never, materialId, watermark);

  const intakeReadDeps = { isLifecycle: (error: unknown) => error instanceof LifecycleError, isDenied: (error: unknown) => error instanceof FactReadDeniedError, translate: intakeOps.translateIntakeReadError };
  async function metadataFor(materialId: string, watermark?: string): Promise<IntakeMetadata & {questionCards: ReturnType<typeof projectIntakeQuestionCards>}> {
    return runIntakeRead(async () => intakeMetadataView(await factsFor(materialId, watermark), intakeOps.projectIntakeFacts, projectIntakeQuestionCards) as IntakeMetadata & {questionCards: ReturnType<typeof projectIntakeQuestionCards>}, intakeReadDeps);
  }

  const metadataOrNull = (materialId: string, watermark: string) => metadataOrNullFor(metadataFor, materialId, watermark);

  const originalFor = (materialId: string) => intakeOriginalFor({
    factId,
    snapshot: <T>(read: (tx: import('../../kernel/src/db/types.ts').ReadTransaction) => Promise<T>) => db.snapshot({ learner: studioLearner }, read) as Promise<T>,
    readContext: (tx: import('../../kernel/src/db/types.ts').ReadTransaction) => createCommandReadContext(tx, intakePurpose) as never,
    extractPaperReturnOriginal: intakeOps.extractPaperReturnOriginal as never,
    metadataFor: (id: FactId) => metadataFor(id) as never,
    isIgnorableReadError: (error: unknown) => error instanceof FactNotFoundError || error instanceof FactReadDeniedError,
    readObject: (id: FactId, original: IntakeOriginal) => objects.read(id, original),
  }, materialId);

  const prepareAdapters = intakePrepareAdapters({
    stableId,
    factId,
    submittedWatermark,
    identify: (bytes, ext, declaredType) => identifyLocalDocument(bytes as Buffer, ext, declaredType),
    digest: (bytes) => digest(bytes as Buffer),
    isBuffer: Buffer.isBuffer,
  });

  function prepareCapture(input: CaptureInput) {
    return intakeOps.prepareIntakeCapture(input, prepareAdapters);
  }

  async function racedOrConflict(materialId: FactId, deletionWatermark: string, matches: (prior: IntakeMetadata) => boolean, error: unknown) {
    if (error instanceof LifecycleError) throw error;
    const raced = await metadataOrNull(materialId.toString(), deletionWatermark);
    if (raced && matches(raced)) return { ...raced, created: false };
    if (raced || isCommandIdentityConflict(error)) throw intakeRacedConflict();
    throw error;
  }

  async function capture(input: CaptureInput) {
    const { requestId, materialId, deletionWatermark, detected, title, original } = prepareCapture(input);
    const intakeId = intakeIdFor(materialId);
    const { requested, cloud, asyncVision } = intakeOps.resolveCaptureExtraction(
      input.extraction, detected.mediaType, mineruSupports, { asyncPhotoDefault: true },
    );
    const matches = (prior: IntakeMetadata) => intakeOps.matchesCaptureReplay(prior, original, title, detected.mediaType, requested);
    const replay = checkIntakeReplay(await metadataOrNull(materialId.toString(), deletionWatermark), matches);
    if (replay.replayed) return { ...replay.prior!, created: false };
    if (cloud) requireMineruConfigured(Boolean(mineruToken()));
    let installed = false;
    try {
      await objects.withOriginal(materialId,input.bytes,original,async (staged, install) => {
        const extraction: IntakeExtraction = await stagedExtractionFor(cloud, asyncVision,
          () => extractLocalDocument(detected.kind,staged,input.bytes,intakeTextLimit),
          pendingMineruExtraction, () => pendingVisionExtraction('queued'));
        const commandInput = intakeCommandInput({ materialId, intakeId, title, original, extraction,
          requestedExtraction: captureRequestedExtraction(cloud, asyncVision) });
        await runIntakeStagedSave(
          { createCommandHandler: createCommandHandler as unknown as (d: unknown, o: Record<string, unknown>) => (c: unknown) => Promise<unknown>, database: db, runtime, hooks, learner: studioLearner, purpose: intakePurpose,
            type: captureIntakeCommand, commandIdValue: intakeCaptureId(requestId), deletionWatermark },
          commandInput,
          async (tx, tick) => {
            if (cloud) await enqueueCloudIntake(tx, tick, intakeId);
            else if (asyncVision) await enqueueVisionIntake(tx, tick, intakeId);
          },
          install,
          () => { installed = true; },
        );
      });
    } catch (error) {
      return racedOrConflict(materialId, deletionWatermark, matches, error) as Promise<Awaited<ReturnType<typeof metadataFor>> & {created:boolean}>;
    }
    return { ...(await metadataFor(materialId)), created: installed };
  }

  type PagesCaptureInput = Omit<IntakeMultiPageCaptureInput<Buffer>, 'pages'> & {
    readonly pages: readonly { filename?: unknown; declaredType?: unknown; bytes: Buffer }[];
  };

  async function capturePages(input: PagesCaptureInput) {
    const prepared = intakeOps.prepareIntakeMultiPageCapture(input, prepareAdapters);
    const { requestId, materialId, deletionWatermark, title, original, originals, pages } = prepared;
    const intakeId = intakeIdFor(materialId);
    const { requested, asyncVision } = intakeOps.resolveCaptureExtraction(
      intakeExtractionInput(input.extraction, pages.length), original.mediaType, mineruSupports, { asyncPhotoDefault: true },
    );
    requireMultiPageVision(requested, asyncVision);
    const matches = (prior: IntakeMetadata) => intakeOps.matchesMultiPageCaptureReplay(prior, originals, title, requested);
    const replay = checkIntakeReplay(await metadataOrNull(materialId.toString(), deletionWatermark), matches);
    if (replay.replayed) return { ...replay.prior!, created: false };
    let installed = false;
    try {
      await objects.withOriginals(materialId, pages.map(item => ({ bytes: item.bytes, original: item.original })),
        async (_staged, install) => {
          const extraction: IntakeExtraction = pendingVisionExtraction('queued', { pageCount: originals.length });
          const commandInput = multiPageIntakeCommandInput({ materialId, intakeId, title, original, originals, extraction });
          await runIntakeStagedSave(
            { createCommandHandler: createCommandHandler as unknown as (d: unknown, o: Record<string, unknown>) => (c: unknown) => Promise<unknown>, database: db, runtime, hooks, learner: studioLearner, purpose: intakePurpose,
              type: captureIntakeCommand, commandIdValue: intakeCaptureId(requestId), deletionWatermark },
            commandInput,
            async (tx, tick) => { await enqueueVisionIntake(tx, tick, intakeId); },
            install,
            () => { installed = true; },
          );
        });
    } catch (error) {
      return racedOrConflict(materialId, deletionWatermark, matches, error) as Promise<Awaited<ReturnType<typeof metadataFor>> & {created:boolean}>;
    }
    return { ...(await metadataFor(materialId)), created: installed };
  }

  async function appendPages(input: IntakeAppendPagesInput<Buffer>) {
    const prepared = intakeOps.prepareIntakeAppendPages(input, intakeIdFor, {
      isBuffer: Buffer.isBuffer,
      identify: (bytes, ext, declaredType) => identifyLocalDocument(bytes as Buffer, ext, declaredType),
      sha256: (bytes) => digest(bytes as Buffer),
    });
    const { requestId, data } = prepared;
    return runIntakeAppendPages({
      factsFor,
      intakeDocumentPages: doc => intakeDocumentPages(doc as never),
      intakeDocument: intakeDocument as (value: unknown) => unknown,
      appendOriginals: (materialId, startPage, pages, staged, options) => objects.appendOriginals(materialId, startPage, pages as never, staged as never, options as never),
      runSave: (afterInstall, install, markInstalled) => runIntakeStagedSave(
        { createCommandHandler: createCommandHandler as unknown as (d: unknown, o: Record<string, unknown>) => (c: unknown) => Promise<unknown>, database: db, runtime, hooks, learner: studioLearner, purpose: intakePurpose,
          type: appendIntakePagesCommand, commandIdValue: commandId(stableId('intake-append-pages', requestId)) },
        data as unknown as Record<string, unknown>, afterInstall, install, markInstalled),
      enqueue: enqueueVisionIntake as never,
      translateError: (error, isDenied) => { throw intakeOps.translateIntakeAppendPagesError(error, isDenied); },
      isDenied: error => error instanceof FactReadDeniedError,
      metadataFor: id => metadataFor(id),
    }, prepared);
  }

  async function originalPage(materialId: string, page: number) {
    const facts = await factsFor(materialId);
    return intakeOriginalPage(facts, page, {
      intakeDocumentPages: doc => intakeDocumentPages(doc as never),
      intakeDocument: intakeDocument as (value: unknown) => unknown,
      readPage: (id, pg, entry) => objects.readPage(id, pg, entry as never) as Promise<Buffer<ArrayBuffer>>,
    }) as Promise<{ readonly original: Pick<IntakeOriginal, 'mediaType' | 'name'>; readonly bytes: Buffer<ArrayBuffer> }>;
  }

  async function paperReturn(input: CaptureInput & Parameters<typeof paperReturnSelection>[0],
    papers: ReturnType<typeof openCapturePapers>) {
    const {requestId,materialId,deletionWatermark,detected,title,original} = prepareCapture(input);
    const selection = intakeOps.resolvePaperReturnSelection(input, materialId, detected.kind);
    return objects.withOriginal(materialId, input.bytes, original, (_, install) => papers.upload(selection, { command: intakeCaptureId(requestId), deletionWatermark, title, original, install }));
  }

  async function cloudOriginal(materialId: string, expectedSha256: string) {
    return objects.read(materialId,{sha256:expectedSha256});
  }

  async function completeCloud(ref: WorkRef, input: CloudIntakeInput, extraction: IntakeExtraction) {
    const { document, material } = input;
    const complete = cloudCompletionHandler({
      createCommandHandler: createCommandHandler as unknown as (d: unknown, o: Record<string, unknown>) => (c: unknown) => Promise<unknown>,
      database: db, runtime, hooks,
      readReadyWork: ((tx: Parameters<typeof readReadyWork>[0], r: WorkRef) => readReadyWork(tx, r)) as never,
      isExpectedCloudCompletion: intakeOps.isExpectedCloudCompletion,
      cloudIntakeSlot, ref, documentRef: document.ref, materialRef: material.ref,
    });
    await complete({
      learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: completeCloudIntakeCommand,
      id: commandId(stableId('intake-mineru-result', ref.workId, ref.generation)),
      input: completeCloudIntakeInput(document.ref, material.ref, extraction) as Json,
    });
  }

  async function completeVision(ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction) {
    await completeVisionIntake(db, runtime, hooks, ref, input, extraction);
  }

  async function correct(input: IntakeCorrectInput) {
    const { materialId, requestId, data } = intakeOps.prepareIntakeCorrection(input, intakeIdFor);
    await runHandledIntakeCommand({
      handle, learner: studioLearner, purpose: intakePurpose, type: correctIntakeCommand,
      commandIdValue: commandId(stableId('intake-correction', requestId)), input: data as Json,
      translate: error => { throw intakeOps.translateIntakeCorrectionError(error, error instanceof FactReadDeniedError); },
    });
    return metadataFor(materialId.toString());
  }

  async function retryVision(input: IntakeRetryVisionInput) {
    const { materialId, requestId, data } = intakeOps.prepareIntakeVisionRetry(input, intakeIdFor);
    const retry = createCommandHandler(db, { ...runtime, hooks: { ...hooks, async onFactsChanged(tx, tick, changes) {
      await tx.query(`INSERT INTO slot_state (learner_id,slot_type,slot_key,scope_keys,changed_tick)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [tx.learner, visionIntakeSlot, data.intakeId, '{}', tick]);
      await requestWork(tx, tick, { slotType: visionIntakeSlot, slotKey: data.intakeId, deriver: visionIntakeDeriver }, 'routed_pending');
      await hooks.onFactsChanged(tx, tick, changes);
    } } });
    await runHandledIntakeCommand({
      handle: retry, learner: studioLearner, purpose: intakePurpose, type: retryVisionIntakeCommand,
      commandIdValue: commandId(stableId('intake-vision-retry', requestId)), input: data as Json,
      translate: error => { throw intakeOps.translateIntakeVisionRetryError(error, error instanceof FactReadDeniedError); },
    });
    return metadataFor(materialId.toString());
  }

  async function questionCards(materialId: string) {
    const facts = await runIntakeRead(() => factsFor(materialId), intakeReadDeps);
    return intakeQuestionCardsView(facts,
      intakeOps.projectIntakeFacts(facts.id, facts.material.value, facts.document.value, facts.document.ref.rev, facts.document.purpose).title,
      projectIntakeQuestionCards(facts.document.value));
  }

  async function confirmDrafts(materialId: string, input: unknown, workbookOverride = workbook) {
    const value = parseIntakeConfirmDraftsInput(input);
    if (value.mode === 'workbook') {
      const targetWorkbook = workbookOverride ?? workbook;
      requireWorkbookAvailable(targetWorkbook);
      return runWorkbookConfirmation({
        factsFor,
        buildDraft: (document, selection) => buildWorkbookDraftFromIntakeSelection(document, selection as IntakeWorkbookSelection) as never,
        save: input => targetWorkbook.save(input),
        ...intakeReadDeps,
      }, { materialId, value, documentValue: facts => facts.document.value });
    }
    requireBankConfirmation(value);
    const requestId = clientRequest(value.requestId);
    return runBankConfirmation<import('../../kernel/src/db/types.ts').ReadTransaction>({
      parseConfirmIntakeQuestions,
      intakeQuestionId,
      handle,
      snapshot: read => db.snapshot({ learner: studioLearner }, read),
      isNotFound: (error: unknown) => error instanceof FactNotFoundError,
      isDenied: (error: unknown) => error instanceof FactReadDeniedError,
      summarize: (tx, data, wrote) => summarizeIntakeQuestionConfirmation(createCommandReadContext(tx as never, intakePurpose), data as never, wrote as never),
      commandIdOf: commandId,
      stableIdOf: stableId,
    }, { materialId, requestId, learner: studioLearner, purpose: intakePurpose, confirmIntakeQuestionsCommand, value });
  }

  return {
    lifecycle, capture, correct,
    retryVision, questionCards, confirmDrafts, capturePages, appendPages, originalPage,
    async setResearch(materialId: string, input: unknown) {
      const { id, data } = intakeOps.prepareIntakeResearchPermission(materialId, input, intakeIdFor);
      await runHandledIntakeCommand({
        handle, learner: studioLearner, purpose: intakePurpose, type: setIntakeResearchCommand,
        commandIdValue: commandId(stableId('intake-research', id, String(data.expectedRev), String(data.enabled))), input: data as Json,
        translate: error => { throw intakeOps.translateIntakeResearchError(error, error instanceof FactReadDeniedError); },
      });
      return metadataFor(id);
    },
    metadata: metadataFor,
    original: originalFor,
    paperReturn,
    cloudOriginal,
    completeCloud,
    completeVision,
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
    if (size > limit) {
      request.resume();
      throw new RequestError(413, '请求内容过长。');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function handleIntakeRequest(
  intake: ReturnType<typeof openIntake>,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  method: string | undefined,
  papers?: ReturnType<typeof openCapturePapers>, _workbook?: { save(input: unknown): Promise<{id: string}> },
): Promise<boolean> {
  const cardRoute = parseIntakeCardRoute(pathname);
  if (cardRoute) {
    return runIntakeCardRoute({
      json: (status, data) => json(response, status, data),
      readBody: limit => readBody(request, limit) as Promise<{ readonly toString: (encoding?: string) => string }>,
      questionCards: id => intake.questionCards(id),
      confirmDrafts: (id, body) => intake.confirmDrafts(id, body, _workbook),
      RequestError,
    }, cardRoute, method);
  }
  const visionOcr = method === 'GET' && pathname === '/api/intake/options' ? Boolean(await resolveVisionIntakeConfig()) : false;
  const outcome = await intakeOps.dispatchIntakeHttp(pathname, method, intakeDispatchAdapter({
    headers: request.headers,
    readBody: (limit) => readBody(request, limit),
    fromArrayBuffer: (buffer) => Buffer.from(buffer),
    lifecycleError: (error, includeCode) => error instanceof LifecycleError
      ? { status: error.status, message: error.message, ...(includeCode ? { code: error.code } : {}) } : null,
    mineruEnabled: () => Boolean(mineruToken()),
    visionOcrEnabled: () => visionOcr,
    hasPapers: Boolean(papers),
    lifecycleState: () => intake.lifecycle.state(),
    erase: (id, input) => intake.lifecycle.erase(id, input),
    metadata: (id) => intake.metadata(id),
    original: (id) => intake.original(id),
    originalPage: (id, page) => intake.originalPage(id, page),
    capture: (input) => intake.capture(input),
    capturePages: (input) => intake.capturePages(input),
    appendPages: (input) => intake.appendPages(input),
    paperReturn: (input) => intake.paperReturn(input, papers!),
    correct: (input) => intake.correct(input),
    setResearch: (id, input) => intake.setResearch(id, input),
    retryVision: (input) => intake.retryVision(input),
  }));
  return writeIntakeOutcome(outcome, {
    writeHead: (status: number, headers: Record<string, string>) => response.writeHead(status, headers),
    end: (bytes: Uint8Array) => { response.end(bytes); },
    setHeader: (name: string, value: string) => response.setHeader(name, value),
    json: (status: number, body: unknown) => json(response, status, body),
  });
}
