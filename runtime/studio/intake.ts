import { extractLocalDocument, identifyLocalDocument } from '@mangekyo/executor-document-extraction/local';
import { mineruSupports } from '@mangekyo/executor-document-extraction/mineru';
import { openIntakeObjects, digest } from './intake-objects.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../kernel/src/db/types.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks, CrossModuleWrites } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, FactReadDeniedError, FactNotFoundError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { readReadyWork, requestWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { materialType } from '../../modules/content/text-material.ts';
import { captureIntakeCommand, completeCloudIntakeCommand, completeVisionIntakeCommand, correctIntakeCommand,
  retryVisionIntakeCommand, pendingMineruExtraction, pendingVisionExtraction, intakePurpose, intakeTextLimit,
  setIntakeResearchCommand, type IntakeExtraction } from '../../modules/capture/intake-values.ts';
import { buildWorkbookDraftFromIntakeSelection, projectIntakeQuestionCards,
  type IntakeWorkbookSelection } from '../../modules/capture/intake-question-cards.ts';
import {
  assetType as questionAssetType,
  confirmIntakeQuestionsCommand,
  intakeQuestionId,
  parseConfirmIntakeQuestions,
} from '../../modules/content/intake-question-bank.ts';
import { questionMetaDraftType, questionStateType } from '../../modules/content/question-state.ts';
import * as intakeOps from '../../modules/capture/intake-operations.ts';
import type { IntakeCaptureInput, IntakeCorrectInput, IntakeRetryVisionInput } from '../../modules/capture/intake-operations.ts';
import type { IntakeMetadata } from '../../modules/capture/intake-view.ts';
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

export const intakeWriteTargets = {
  [captureIntakeCommand]: { create: [materialType] },
  [correctIntakeCommand]: { correct: [materialType] },
  [completeCloudIntakeCommand]: { correct: [materialType] },
  [completeVisionIntakeCommand]: { correct: [materialType] },
  [retryVisionIntakeCommand]: { correct: [materialType] },
  [confirmIntakeQuestionsCommand]: { create: [questionAssetType, questionStateType, questionMetaDraftType] },
} satisfies CrossModuleWrites;

export function openIntake(db: Db, captureModule: LoadedModule, content: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks(), workbook?: { save(input: unknown): Promise<{id: string}> }) {
  const runtime = { modules: [captureModule, content], crossModuleWrites: intakeWriteTargets };
  const handle = createCommandHandler(db, { ...runtime, hooks });
  const objects = openIntakeObjects(db);
  const lifecycle = openIntakeLifecycle(db, objects.erase);

  async function factsFor(materialId: string, watermark?: string) {
    const id = factId(materialId);
    const intakeId = intakeIdFor(id);
    return db.snapshot({ learner: studioLearner }, async (tx) => {
      if (watermark !== undefined) await lifecycle.checkCapture(tx,id,watermark);
      const read = createCommandReadContext(tx, intakePurpose);
      const material = await read.fact(id, { mode: 'following' });
      if (watermark !== undefined && material.type === captureSourceType)
        throw new RequestError(409, '同一个请求标识已用于纸卷拍回。');
      const document = await read.fact(intakeId, { mode: 'following' });
      return { id, material, document, intakeId };
    });
  }

  async function metadataFor(materialId: string, watermark?: string): Promise<IntakeMetadata & {questionCards: ReturnType<typeof projectIntakeQuestionCards>}> {
    try {
      const facts = await factsFor(materialId, watermark);
      return { ...intakeOps.projectIntakeFacts(facts.id, facts.material.value, facts.document.value, facts.document.ref.rev, facts.document.purpose),
        questionCards: projectIntakeQuestionCards(facts.document.value) };
    } catch (error) {
      throw intakeOps.translateIntakeReadError(error, error instanceof LifecycleError, error instanceof FactReadDeniedError);
    }
  }

  async function metadataOrNull(materialId: string, watermark: string) {
    try {
      return await metadataFor(materialId,watermark);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return null;
      throw error;
    }
  }

  async function originalFor(materialId: string) {
    const id = factId(materialId);
    const original = await db.snapshot({ learner: studioLearner }, async (tx) => {
      const read = createCommandReadContext(tx, intakePurpose);
      try {
        return intakeOps.extractPaperReturnOriginal(await read.fact(id, { mode: 'following' }), id);
      } catch (error) {
        if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
      }
      return null;
    });
    const metadata = original ? {original} : await metadataFor(id);
    const bytes = await objects.read(id,metadata.original);
    return {metadata, stored:metadata.original, bytes};
  }

  function prepareCapture(input: CaptureInput) {
    return intakeOps.prepareIntakeCapture(input, {
      isBuffer: Buffer.isBuffer,
      materialIdFor: (requestId) => factId(stableId('intake-material', requestId)),
      parseWatermark: submittedWatermark,
      identify: (bytes, ext, declaredType) => identifyLocalDocument(bytes as Buffer, ext, declaredType),
      sha256: (bytes) => digest(bytes as Buffer),
    });
  }

  async function capture(input: CaptureInput) {
    const { requestId, materialId, deletionWatermark, detected, title, original } = prepareCapture(input);
    const intakeId = intakeIdFor(materialId);
    const { requested, cloud, asyncVision } = intakeOps.resolveCaptureExtraction(
      input.extraction, detected.mediaType, mineruSupports, { asyncPhotoDefault: true },
    );
    const matches = (prior: IntakeMetadata) => intakeOps.matchesCaptureReplay(prior, original, title, detected.mediaType, requested);
    const prior = await metadataOrNull(materialId.toString(), deletionWatermark);
    if (prior) {
      if (!matches(prior)) throw new RequestError(409, '同一个请求标识已经用于不同文件或标题。');
      return { ...prior, created: false };
    }
    if (cloud && !mineruToken()) throw new RequestError(503, 'MinerU 云识别尚未配置。');
    let installed = false;
    try {
      await objects.withOriginal(materialId,input.bytes,original,async (staged, install) => {
        const extraction: IntakeExtraction = cloud ? pendingMineruExtraction()
          : asyncVision ? pendingVisionExtraction('queued')
          : await extractLocalDocument(detected.kind,staged,input.bytes,intakeTextLimit);
        const commandInput = {
          materialId, intakeId, title, original, extraction,
          savedAt: new Date().toISOString(),
          ...(cloud ? { requestedExtraction: 'mineru' } : asyncVision ? { requestedExtraction: 'vision_llm' } : {}),
        };
        const save = createCommandHandler(db, {
          ...runtime,
          hooks: {
            async onFactsChanged(tx, tick, changes) {
              await install();
              installed = true;
              if (cloud) await enqueueCloudIntake(tx, tick, intakeId);
              else if (asyncVision) await enqueueVisionIntake(tx, tick, intakeId);
              await hooks.onFactsChanged(tx, tick, changes);
            },
          },
        });
        await save({
          learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: captureIntakeCommand,
          id: intakeCaptureId(requestId), deletionWatermark, input: commandInput,
        });
      });
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      const raced = await metadataOrNull(materialId.toString(), deletionWatermark);
      if (raced && matches(raced)) return { ...raced, created: false };
      if (raced || (error instanceof Error && error.message === 'Command ID already used with a different command identity')) {
        throw new RequestError(409, '同一个请求标识已经用于不同内容。');
      }
      throw error;
    }
    return { ...(await metadataFor(materialId)), created: installed };
  }

  async function paperReturn(input: CaptureInput & Parameters<typeof paperReturnSelection>[0],
    papers: ReturnType<typeof openCapturePapers>) {
    const {requestId,materialId,deletionWatermark,detected,title,original} = prepareCapture(input);
    const selection = intakeOps.resolvePaperReturnSelection(input, materialId, detected.kind);
    return objects.withOriginal(materialId, input.bytes, original, (_, install) =>
      papers.upload(selection, { command: intakeCaptureId(requestId), deletionWatermark, title, original, install }));
  }

  async function cloudOriginal(materialId: string, expectedSha256: string) {
    return objects.read(materialId,{sha256:expectedSha256});
  }

  async function completeCloud(ref: WorkRef, input: CloudIntakeInput, extraction: IntakeExtraction) {
    const { document, material } = input;
    const complete = createCommandHandler(db, {
      ...runtime,
      hooks: {
        ...hooks,
        async onFactsChanged(tx, tick, changes) {
          const work = await readReadyWork(tx, ref);
          if (!intakeOps.isExpectedCloudCompletion(work, cloudIntakeSlot, document.ref, material.ref, changes)) throw new RequestError(409, '交入工作已更改。');
          await hooks.onFactsChanged(tx, tick, changes);
        },
      },
    });
    await complete({
      learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: completeCloudIntakeCommand,
      id: commandId(stableId('intake-mineru-result', ref.workId, ref.generation)),
      input: { intakeId: document.ref.id, expectedRev: document.ref.rev, expectedMaterialRev: material.ref.rev, extraction },
    });
  }

  async function completeVision(ref: WorkRef, input: VisionIntakeInput, extraction: IntakeExtraction) {
    await completeVisionIntake(db, runtime, hooks, ref, input, extraction);
  }

  async function correct(input: IntakeCorrectInput) {
    const { materialId, requestId, data } = intakeOps.prepareIntakeCorrection(input, intakeIdFor);
    try {
      await handle({
        learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: correctIntakeCommand,
        id: commandId(stableId('intake-correction', requestId)), input: data,
      });
    } catch (error) {
      throw intakeOps.translateIntakeCorrectionError(error, error instanceof FactReadDeniedError);
    }
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
    try {
      await retry({ learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: retryVisionIntakeCommand,
        id: commandId(stableId('intake-vision-retry', requestId)), input: data });
    } catch (error) {
      throw intakeOps.translateIntakeVisionRetryError(error, error instanceof FactReadDeniedError);
    }
    return metadataFor(materialId.toString());
  }

  async function questionCards(materialId: string) {
    let facts;
    try { facts = await factsFor(materialId); } catch (error) {
      throw intakeOps.translateIntakeReadError(error, error instanceof LifecycleError, error instanceof FactReadDeniedError);
    }
    return { materialId: facts.id, materialRev: facts.material.ref.rev, intakeRev: facts.document.ref.rev,
      title: intakeOps.projectIntakeFacts(facts.id, facts.material.value, facts.document.value, facts.document.ref.rev, facts.document.purpose).title,
      questionCards: projectIntakeQuestionCards(facts.document.value) };
  }

  async function confirmDrafts(materialId: string, input: unknown, workbookOverride = workbook) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, '拍卷确认请求格式无效。');
    const value = input as Record<string, unknown>;
    if (value.mode === 'workbook') {
      const targetWorkbook = workbookOverride ?? workbook;
      if (!targetWorkbook) throw new RequestError(500, '练习模块未启用。');
      let facts;
      try { facts = await factsFor(materialId); } catch (error) {
        throw intakeOps.translateIntakeReadError(error, error instanceof LifecycleError, error instanceof FactReadDeniedError);
      }
      let draft;
      try { draft = buildWorkbookDraftFromIntakeSelection(facts.document.value, value as IntakeWorkbookSelection); }
      catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '微卷选题格式无效。'); }
      const saved = await targetWorkbook.save({requestId: value.requestId, title: draft.title, materialId: draft.materialId, questions: draft.questions});
      return {kind: 'workbook' as const, paperId: saved.id, href: '/papers/' + saved.id, title: draft.title, questionCount: draft.questions.length};
    }
    if (value.mode !== 'bank') throw new RequestError(400, '拍卷确认方式无效。');
    if (value.confirmedByLearner !== true) throw new RequestError(400, '加入题库需要学习者显式确认。');
    const requestId = clientRequest(value.requestId);
    let data;
    try { data = parseConfirmIntakeQuestions({ confirmedByLearner: true, materialId, expectedMaterialRev: value.expectedMaterialRev,
      items: value.items, ...(value.purpose === undefined ? {} : {purpose: value.purpose}) }); }
    catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '拍卷题目确认无效。'); }
    const questionIds = await Promise.all(data.items.map(item => intakeQuestionId(data.materialId, item.draftId)));
    let receipt;
    try {
      receipt = await handle({
        learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: confirmIntakeQuestionsCommand,
        id: commandId(stableId('intake-question-confirmation', requestId)), input: data,
      });
    } catch (error) {
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) throw new RequestError(404, '找不到这份拍卷材料。');
      if (error instanceof Error && (error.message.startsWith('材料版本已变化') || error.message.startsWith('Fact revision conflict') ||
          error.message === 'Command ID already used with a different command identity')) throw new RequestError(409, '拍卷题目或材料版本已变化，请重新核对。');
      throw error;
    }
    const wrote = new Set(receipt.wrote.map(ref => ref.id));
    return { kind: 'bank' as const, questionIds, savedCount: questionIds.filter(id => wrote.has(id)).length, skippedCount: questionIds.filter(id => !wrote.has(id)).length };
  }

  return {
    lifecycle, capture, correct,
    retryVision, questionCards, confirmDrafts,
    async setResearch(materialId: string, input: unknown) {
      const { id, data } = intakeOps.prepareIntakeResearchPermission(materialId, input, intakeIdFor);
      try {
        await handle({
          learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: setIntakeResearchCommand,
          id: commandId(stableId('intake-research', id, String(data.expectedRev), String(data.enabled))), input: data,
        });
      } catch (error) {
        throw intakeOps.translateIntakeResearchError(error, error instanceof FactReadDeniedError);
      }
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
  const cardRoute = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})\/(question-cards|confirm-drafts)$/.exec(pathname);
  if (cardRoute?.[1]) {
    const expected = cardRoute[2] === 'question-cards' ? 'GET' : 'POST';
    if (method !== expected) return json(response, 405, {error: '这个入口只接受指定操作。'}), true;
    try {
      const result = cardRoute[2] === 'question-cards' ? await intake.questionCards(cardRoute[1])
        : await intake.confirmDrafts(cardRoute[1], JSON.parse((await readBody(request, 1_048_576)).toString('utf8')), _workbook);
      if (result) return json(response, cardRoute[2] === 'question-cards' ? 200 : 201, result), true;
    } catch (error) {
      const status = error instanceof RequestError ? error.status : error instanceof SyntaxError ? 400 : 500;
      const message = error instanceof RequestError || error instanceof SyntaxError ? error.message : cardRoute[2] === 'question-cards' ? '这份材料的核对卡无法读取。' : '拍卷确认未能完成。';
      return json(response, status, {error: message}), true;
    }
    return json(response, 405, {error: '这个入口只接受指定操作。'}), true;
  }
  const visionOcr = method === 'GET' && pathname === '/api/intake/options' ? Boolean(await resolveVisionIntakeConfig()) : false;
  const outcome = await intakeOps.dispatchIntakeHttp(pathname, method, {
    headers: request.headers,
    readBody: (limit) => readBody(request, limit),
    fromArrayBuffer: (buffer) => Buffer.from(buffer),
    decodeUtf8Bytes: (bytes) => bytes.toString('utf8'),
    parseWatermark: submittedWatermark,
    readLifecycleError: (error, includeCode) => error instanceof LifecycleError
      ? { status: error.status, message: error.message, ...(includeCode ? { code: error.code } : {}) } : null,
    mineruEnabled: () => Boolean(mineruToken()),
    visionOcrEnabled: () => visionOcr,
    hasPapers: Boolean(papers),
    lifecycleState: () => intake.lifecycle.state(),
    erase: (id, input) => intake.lifecycle.erase(id, input),
    metadata: (id) => intake.metadata(id),
    original: (id) => intake.original(id),
    capture: (input) => intake.capture(input),
    paperReturn: (input) => intake.paperReturn(input, papers!),
    correct: (input) => intake.correct(input),
    setResearch: (id, input) => intake.setResearch(id, input),
    retryVision: (input) => intake.retryVision(input),
  });
  if (!outcome) return false;
  if (outcome.kind === 'bytes') {
    response.writeHead(outcome.status, outcome.headers);
    return response.end(outcome.bytes), true;
  }
  if (outcome.headers) {
    for (const [name, value] of Object.entries(outcome.headers)) response.setHeader(name, value);
  }
  return json(response, outcome.status, outcome.body), true;
}
