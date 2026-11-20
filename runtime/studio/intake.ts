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
import { materialType, textMaterial } from '../../modules/content/text-material.ts';
import {
  captureIntakeCommand,
  completeCloudIntakeCommand,
  correctIntakeCommand,
  correctIntakeInput,
  intakeDocument,
  intakeFileLimit,
  intakeFilename,
  intakeTitle,
  pendingMineruExtraction,
  intakeOriginal,
  intakePurpose,
  IntakeResearchConflict,
  intakeResearchPermission,
  intakeTextLimit,
  setIntakeResearchCommand,
  type IntakeExtraction,
  type IntakeOriginal,
} from '../../modules/capture/intake-values.ts';
import { projectIntakeMetadata, type IntakeMetadata } from '../../modules/capture/intake-view.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { cloudIntakeSlot, enqueueCloudIntake, mineruToken, type CloudIntakeInput } from './intake-cloud.ts';

import { captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { paperReturnSelection } from '../../modules/capture/paper.ts';
import type { openCapturePapers } from './capture-papers.ts';
import { intakeCaptureId, intakeIdFor, openIntakeLifecycle } from './intake-lifecycle.ts';
import { submittedWatermark } from './deletion-watermark.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';

export { intakeSwiftTimeoutMs } from '@mangekyo/executor-document-extraction/local';

export type { IntakeMetadata } from '../../modules/capture/intake-view.ts';

type CaptureInput = {
  readonly requestId: unknown;
  readonly title?: unknown;
  readonly filename?: unknown;
  readonly declaredType?: unknown;
  readonly extraction?: unknown;
  readonly deletionWatermark?: unknown;
  readonly bytes: Buffer;
};

type CorrectInput = { readonly expectedRev: unknown; readonly materialId: unknown; readonly requestId: unknown; readonly text: unknown };

function asciiFilename(name: string) {
  const value = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').replace(/\.+$/g, '_');
  return (value || 'document').slice(0, 120);
}

function encodeRfc5987(value: string) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function extensionOf(name: string) {
  return /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

function detect(bytes: Buffer, filename: string, declaredType: unknown) {
  const detected = identifyLocalDocument(bytes, extensionOf(intakeFilename(filename)), declaredType);
  if (detected) return detected;
  throw new RequestError(415, '只支持 PDF、照片（PNG/JPEG/HEIC/HEIF/AVIF/TIFF）和 UTF-8 的 txt/Markdown。');
}

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
    let facts;
    try {
      facts = await factsFor(materialId,watermark);
    } catch (error) {
      if (error instanceof LifecycleError || error instanceof RequestError) throw error;
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) {
        throw new RequestError(404, '这份材料或它的交入记录不存在。');
      }
      throw new RequestError(500, '这份材料的交入记录无法读取。');
    }
    const material = textMaterial(facts.material.value);
    const document = intakeDocument(facts.document.value);
    if (document.materialId.toString() !== facts.id) throw new RequestError(404, '这份材料的交入记录不匹配。');
    return projectIntakeMetadata(document, material, facts.document.ref.rev, facts.document.purpose);
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
    const original = await db.snapshot({learner:studioLearner},async tx => {
      const read = createCommandReadContext(tx,intakePurpose);
      try {
        const source = await read.fact(id,{mode:'following'});
        if (source.type === captureSourceType) {
          const envelope = sourceEnvelope(source.value);
          if (envelope.kind === 'paper-return' && envelope.originals[0]?.blobRef === id)
            return envelope.originals[0];
        }
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
    const requestId = clientRequest(input.requestId);
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) throw new RequestError(400, '请选择要交入的文件。');
    if (input.bytes.length > intakeFileLimit) throw new RequestError(413, '文件超过 25 MB。');
    const materialId = factId(stableId('intake-material', requestId));
    const deletionWatermark = submittedWatermark(input);
    const filename = intakeFilename(input.filename);
    const detected = detect(input.bytes, filename, input.declaredType);
    const name = filename || '材料原件';
    const title = intakeTitle(input.title, name.replace(/\.[^.]+$/, '') || '材料原件');
    const sha256 = digest(input.bytes);
    let original: IntakeOriginal;
    try {
      original = intakeOriginal({ name, mediaType: detected.mediaType, size: input.bytes.length, sha256 });
      textMaterial({ title, text: '原件' });
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : '交入材料无效。');
    }
    return {requestId,materialId,deletionWatermark,detected,title,original};
  }

  async function capture(input: CaptureInput) {
    const {requestId,materialId,deletionWatermark,detected,title,original} = prepareCapture(input);
    const intakeId = intakeIdFor(materialId);
    const requested = input.extraction ?? 'local';
    if (requested !== 'local' && requested !== 'mineru') throw new RequestError(400, '请选择有效的识别方式。');
    const cloud = requested === 'mineru';
    if (cloud && !mineruSupports(detected.mediaType)) throw new RequestError(415, 'MinerU 支持 PDF、PNG 和 JPEG。');
    const matches = (prior: IntakeMetadata) => prior.original.sha256 === original.sha256 && prior.original.name === original.name &&
      prior.title === title && prior.original.mediaType === detected.mediaType &&
      (prior.requestedExtraction ?? 'local') === requested;
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
    if (detected.kind === 'text') throw new RequestError(415,'纸卷拍回需要照片或 PDF。');
    if (input.extraction !== undefined) throw new RequestError(400,'纸卷拍回只保存原件，请移除识别选项。');
    let selection;
    try { selection = paperReturnSelection(input,materialId); }
    catch { throw new RequestError(400,'请选择已发行纸卷、页码和原件用途。'); }
    return objects.withOriginal(materialId,input.bytes,original,(_,install) => papers.upload(selection,{
      command:intakeCaptureId(requestId),deletionWatermark,title,original,install,
    }));
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
          if (work?.slotType !== cloudIntakeSlot || work.slotKey !== document.ref.id ||
              ![document,material].every(({ref}) => changes.some(change => change.kind === 'correct' &&
                change.ref.id === ref.id && change.ref.rev === ref.rev + 1)))
            throw new RequestError(409, '交入工作已更改。');
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

  async function correct(input: CorrectInput) {
    const materialId = factId(input.materialId as string);
    const requestId = clientRequest(input.requestId);
    let data;
    try { data = correctIntakeInput({ materialId, intakeId: intakeIdFor(materialId), expectedRev: input.expectedRev, text: input.text }); }
    catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '更正无效。'); }
    try {
      await handle({
        learner: studioLearner,
        actor: 'learner',
        purpose: intakePurpose,
        type: correctIntakeCommand,
        id: commandId(stableId('intake-correction', requestId)),
        input: data,
      });
    } catch (error) {
      if (error instanceof Error && (error.message === '原文版本已经变更。' || error.message.startsWith('Fact revision conflict'))) throw new RequestError(409, '这份文字已有新版本，请打开原文核对后再保存。');
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) throw new RequestError(404, '找不到这份原件。');
      if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
        throw new RequestError(409, '同一个更正标识已经用于不同文字。');
      }
      throw error;
    }
    return metadataFor(materialId.toString());
  }

  return {
    lifecycle, capture,
    correct,
    async setResearch(materialId: string, input: unknown) {
      const id = factId(materialId);
      let data;
      try { data = intakeResearchPermission({ ...(input as object), materialId, intakeId: intakeIdFor(id) }); }
      catch { throw new RequestError(400, '原件版本或后台用途无效。'); }
      try {
        await handle({learner: studioLearner, actor: 'learner', purpose: intakePurpose, type: setIntakeResearchCommand,
          id: commandId(stableId('intake-research', id, String(data.expectedRev), String(data.enabled))), input: data});
      } catch (error) {
        if (error instanceof IntakeResearchConflict) throw new RequestError(409, error.message);
        if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) throw new RequestError(404, '找不到这份原件。');
        throw error;
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

async function readBody(request: IncomingMessage, limit: number) {
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

function decodeUtf8(value: string) {
  return Buffer.from(value, 'latin1').toString('utf8');
}

function intakeFormText(form: FormData, field: string) {
  const values = form.getAll(field);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new RequestError(400, '交入表单包含重复或无效的字段：' + field);
  }
  return values[0];
}

function sendOriginal(response: ServerResponse, metadata: Pick<IntakeMetadata,'original'>, bytes: Buffer) {
  response.writeHead(200, {
    'Content-Type': metadata.original.mediaType,
    'Content-Disposition': `attachment; filename="${asciiFilename(metadata.original.name)}"; filename*=UTF-8''${encodeRfc5987(metadata.original.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Length': String(bytes.length),
  });
  response.end(bytes);
}

export async function handleIntakeRequest(
  intake: ReturnType<typeof openIntake>,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  method: string | undefined,
  papers?: ReturnType<typeof openCapturePapers>,
): Promise<boolean> {
  if (pathname === '/api/lifecycle' && method === 'GET') {
    const state = await intake.lifecycle.state();
    response.setHeader('X-Deletion-Watermark',state.watermark);
    return json(response,200,state), true;
  }
  const match = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(import|original|correction|research-permission|erasure))?$/.exec(pathname);
  if (pathname === '/api/intake/options' && method === 'GET')
    return json(response, 200, { mineru: Boolean(mineruToken()) }), true;
  if (pathname === '/api/intake') {
    if (method !== 'POST') {
      json(response, 405, { error: '这个入口只接受交入请求。' });
      return true;
    }
    try {
      const contentType = request.headers['content-type']?.split(';')[0]?.toLowerCase() ?? '';
      let result;
      let watermark: string;
      if (contentType === 'multipart/form-data') {
        const bytes = await readBody(request, intakeFileLimit + 512 * 1024);
        let form: FormData;
        try { form = await new Response(new Uint8Array(bytes), {headers: {'Content-Type': request.headers['content-type']!}}).formData(); }
        catch { throw new RequestError(400, '文件表单无法读取。'); }
        const file = form.get('file');
        if (!file || typeof file === 'string' || form.getAll('file').length !== 1)
          throw new RequestError(400, '请选择一个文件。');
        watermark = submittedWatermark({deletionWatermark:intakeFormText(form,'deletionWatermark')});
        const intent = intakeFormText(form,'intent');
        const upload = {
          deletionWatermark:watermark,
          requestId: intakeFormText(form, 'requestId'),
          title: intakeFormText(form, 'title'),
          extraction: intakeFormText(form, 'extraction'),
          filename: file.name, declaredType: file.type, bytes: Buffer.from(await file.arrayBuffer()),
        };
        if (intent === 'paper-return' && papers) result = await intake.paperReturn({
          ...upload, issuanceId:intakeFormText(form,'issuanceId'), page:intakeFormText(form,'page'),
          purpose:intakeFormText(form,'purpose'), retryId:intakeFormText(form,'retryId'),
        },papers);
        else if (intent === undefined) result = await intake.capture(upload);
        else throw new RequestError(400,'交入用途无效。');
      } else {
        const requestId = request.headers['x-request-id'];
        if (typeof requestId !== 'string' || requestId.trim() === '') throw new RequestError(400, '请求标识无效。');
        const bytes = await readBody(request, intakeFileLimit);
        watermark = submittedWatermark({deletionWatermark:request.headers['x-deletion-watermark']});
        result = await intake.capture({
          requestId, deletionWatermark:watermark,
          title:
            typeof request.headers['x-title'] === 'string'
              ? decodeUtf8(request.headers['x-title'])
              : undefined,
          filename:
            typeof request.headers['x-filename'] === 'string'
              ? decodeUtf8(request.headers['x-filename'])
              : undefined,
          declaredType: contentType,
          extraction: request.headers['x-intake-extraction'],
          bytes,
        });
      }
      response.setHeader('X-Deletion-Watermark',watermark);
      return json(response, 201, result), true;
    } catch (error) {
      json(response, error instanceof RequestError || error instanceof LifecycleError ? error.status : 500, {
        error: error instanceof RequestError || error instanceof LifecycleError ? error.message : '交入未能完成。',
        ...(error instanceof LifecycleError && error.code ? {code:error.code} : {}),
      });
      return true;
    }
  }
  if (match?.[1]) {
    const id = match[1];
    const action = match[2];
    if (!action) {
      if (method === 'GET') {
        try {
          return json(response, 200, await intake.metadata(id)), true;
        } catch (error) {
          json(response, error instanceof RequestError || error instanceof LifecycleError ? error.status : 500, {
            error: error instanceof RequestError || error instanceof LifecycleError ? error.message : '这份材料的交入记录无法读取。',
          });
          return true;
        }
      }
      json(response, 405, { error: '这个材料入口只接受读取。' });
      return true;
    }
    if (action === 'import') {
      if (method === 'GET') {
        try {
          return json(response, 200, await intake.metadata(id)), true;
        } catch (error) {
          json(response, error instanceof RequestError || error instanceof LifecycleError ? error.status : 500, {
            error: error instanceof RequestError || error instanceof LifecycleError ? error.message : '这份材料的交入记录无法读取。',
          });
          return true;
        }
      }
      json(response, 405, { error: '这份材料的元数据只接受读取。' });
      return true;
    }
    if (action === 'erasure' && method === 'POST') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json')
        return json(response,415,{error:'需要 JSON 请求。'}), true;
      try {
        const input = JSON.parse((await readBody(request,4096)).toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400,'删除请求格式无效。');
        return json(response,200,await intake.lifecycle.erase(id,input)), true;
      } catch (error) {
        const status = error instanceof LifecycleError || error instanceof RequestError ? error.status :
          error instanceof SyntaxError ? 400 : error instanceof FactNotFoundError ? 404 : 500;
        return json(response,status,{error:status === 500 ? '删除未能完成。' : error instanceof Error ? error.message : '无效请求。'}), true;
      }
    }
    if (action === 'original') {
      if (method === 'GET') {
        try {
          const { metadata, bytes } = await intake.original(id);
          sendOriginal(response, metadata, bytes);
          return true;
        } catch (error) {
          if (!response.headersSent) {
            json(response, error instanceof RequestError || error instanceof LifecycleError ? error.status : 500, {
              error: error instanceof RequestError || error instanceof LifecycleError ? error.message : '原件未能读取。',
            });
          } else response.destroy();
          return true;
        }
      }
      json(response, 405, { error: '原件只接受下载。' });
      return true;
    }
    if (action === 'correction' && method === 'POST') {
      try {
        const bytes = await readBody(request, intakeTextLimit * 4 + 4096);
        const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        const result = await intake.correct({ materialId: id, requestId: value.requestId, expectedRev: value.expectedRev, text: value.text });
        return json(response, 200, result), true;
      } catch (error) {
        if (error instanceof SyntaxError) {
          json(response, 400, { error: '更正请求格式无效。' });
          return true;
        }
        json(response, error instanceof RequestError || error instanceof LifecycleError ? error.status : 500, {
          error: error instanceof RequestError || error instanceof LifecycleError ? error.message : '更正未能保存。',
        });
        return true;
      }
    }
    if (action === 'correction') {
      json(response, 405, { error: '更正只接受提交。' });
      return true;
    }
    if (action === 'research-permission') {
      if (method !== 'PUT') return json(response, 405, { error: '这个入口只接受用途设置。' }), true;
      try {
        const value: unknown = JSON.parse((await readBody(request, 4096)).toString('utf8'));
        return json(response, 200, await intake.setResearch(id, value)), true;
      } catch (error) {
        if (error instanceof SyntaxError) return json(response, 400, { error: '用途请求格式无效。' }), true;
        json(response, error instanceof RequestError || error instanceof LifecycleError ? error.status : 500, {
          error: error instanceof RequestError || error instanceof LifecycleError ? error.message : '原件用途未能更新。',
        });
        return true;
      }
    }
  }
  return false;
}
