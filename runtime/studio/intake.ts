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
import { readReadyWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { materialType } from '../../modules/content/text-material.ts';
import {
  captureIntakeCommand,
  completeCloudIntakeCommand,
  correctIntakeCommand,
  pendingMineruExtraction,
  intakePurpose,
  intakeTextLimit,
  setIntakeResearchCommand,
  type IntakeExtraction,
} from '../../modules/capture/intake-values.ts';
import * as intakeOps from '../../modules/capture/intake-operations.ts';
import type { IntakeCaptureInput, IntakeCorrectInput } from '../../modules/capture/intake-operations.ts';
import type { IntakeMetadata } from '../../modules/capture/intake-view.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { cloudIntakeSlot, enqueueCloudIntake, mineruToken, type CloudIntakeInput } from './intake-cloud.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import type { paperReturnSelection } from '../../modules/capture/paper.ts';
import type { openCapturePapers } from './capture-papers.ts';
import { intakeCaptureId, intakeIdFor, openIntakeLifecycle } from './intake-lifecycle.ts';
import { submittedWatermark } from './deletion-watermark.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';

export { intakeSwiftTimeoutMs } from '@mangekyo/executor-document-extraction/local';

export type { IntakeMetadata } from '../../modules/capture/intake-view.ts';

type CaptureInput = Omit<IntakeCaptureInput, 'bytes'> & { readonly bytes: Buffer };

export const intakeWriteTargets = {
  [captureIntakeCommand]: { create: [materialType] },
  [correctIntakeCommand]: { correct: [materialType] },
  [completeCloudIntakeCommand]: { correct: [materialType] },
} satisfies CrossModuleWrites;

export function openIntake(db: Db, captureModule: LoadedModule, content: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks()) {
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

  async function metadataFor(materialId: string, watermark?: string): Promise<IntakeMetadata> {
    try {
      const facts = await factsFor(materialId, watermark);
      return intakeOps.projectIntakeFacts(facts.id, facts.material.value, facts.document.value, facts.document.ref.rev, facts.document.purpose);
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
    const { requested, cloud } = intakeOps.resolveCaptureExtraction(input.extraction, detected.mediaType, mineruSupports);
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
        const extraction: IntakeExtraction = cloud ? pendingMineruExtraction() : await extractLocalDocument(detected.kind,staged,input.bytes,intakeTextLimit);
        const commandInput = {
          materialId, intakeId, title, original, extraction,
          ...(cloud ? { requestedExtraction: 'mineru' } : {}),
        };
        const save = createCommandHandler(db, {
          ...runtime,
          hooks: {
            async onFactsChanged(tx, tick, changes) {
              await install();
              installed = true;
              if (cloud) await enqueueCloudIntake(tx, tick, intakeId);
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

  return {
    lifecycle, capture, correct,
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
  papers?: ReturnType<typeof openCapturePapers>,
): Promise<boolean> {
  const outcome = await intakeOps.dispatchIntakeHttp(pathname, method, {
    headers: request.headers,
    readBody: (limit) => readBody(request, limit),
    fromArrayBuffer: (buffer) => Buffer.from(buffer),
    decodeUtf8Bytes: (bytes) => bytes.toString('utf8'),
    parseWatermark: submittedWatermark,
    readLifecycleError: (error, includeCode) => error instanceof LifecycleError
      ? { status: error.status, message: error.message, ...(includeCode ? { code: error.code } : {}) } : null,
    mineruEnabled: () => Boolean(mineruToken()),
    hasPapers: Boolean(papers),
    lifecycleState: () => intake.lifecycle.state(),
    erase: (id, input) => intake.lifecycle.erase(id, input),
    metadata: (id) => intake.metadata(id),
    original: (id) => intake.original(id),
    capture: (input) => intake.capture(input),
    paperReturn: (input) => intake.paperReturn(input, papers!),
    correct: (input) => intake.correct(input),
    setResearch: (id, input) => intake.setResearch(id, input),
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
