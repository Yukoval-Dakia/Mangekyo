import { extractLocalDocument } from '@mangekyo/executor-document-extraction/local';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../kernel/src/db/types.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
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
  intakeOriginal,
  intakePurpose,
  IntakeResearchConflict,
  intakeResearchPermission,
  intakeResearchPurpose,
  intakeTextLimit,
  setIntakeResearchCommand,
  type IntakeExtraction,
  type IntakeMediaType,
  type IntakeOriginal,
} from '../../modules/capture/intake-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { cloudIntakeSlot, enqueueCloudIntake, mineruSupports, mineruToken, type CloudIntakeInput } from './intake-cloud.ts';

import { captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { paperReturnSelection, type openCapturePapers } from './capture-papers.ts';
import { intakeCaptureId, intakeIdFor, openIntakeLifecycle } from './intake-lifecycle.ts';
import { submittedWatermark } from './deletion-watermark.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';

export { intakeSwiftTimeoutMs } from '@mangekyo/executor-document-extraction/local';

export type IntakeMetadata = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly characterCount: number;
  readonly truncated: boolean;
  readonly fullText: string | null;
  readonly extraction: IntakeExtraction;
  readonly requestedExtraction?: 'mineru';
  readonly original: { readonly name: string; readonly mediaType: string; readonly size: number; readonly sha256: string };
  readonly corrected: boolean;
  readonly backgroundResearch?: 'allowed' | 'private' | 'all';
  readonly revision: number;
};

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

type StoredOriginal = {
  readonly path: string;
  readonly name: string;
  readonly mediaType: IntakeMediaType;
  readonly size: number;
  readonly sha256: string;
};

type Detected = { readonly kind: 'pdf' | 'image' | 'text'; readonly mediaType: IntakeMediaType };

function dataRoot() {
  const override = process.env.MANGEKYO_INTAKE_DATA_DIR;
  if (override && override.trim()) return resolve(override.trim());
  const home = homedir();
  if (platform() === 'darwin') return resolve(home, 'Library/Application Support/Mangekyō');
  if (platform() === 'win32') return resolve(process.env.LOCALAPPDATA || home, 'Mangekyō');
  return resolve(process.env.XDG_DATA_HOME || resolve(home, '.local/share'), 'mangekyo');
}

function materialBase() {
  const root = resolve(dataRoot(), 'intake');
  return (materialId: string) => {
    const id = factId(materialId);
    const base = resolve(root, id);
    if (!base.startsWith(root + sep)) throw new Error('材料路径无效');
    return base;
  };
}

function digest(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read the immutable original identified by an authorized intake fact. */
export async function readIntakeOriginalBytes(materialId: string, expected: Pick<IntakeOriginal, 'size' | 'sha256'>) {
  if (!Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > intakeFileLimit)
    throw new Error('Invalid intake original size');
  const base = materialBase()(materialId);
  if (!(await lstat(base)).isDirectory()) throw new Error('Invalid intake directory');
  const file = await open(join(base, 'original'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expected.size) throw new Error('Intake original changed');
    const bytes = Buffer.alloc(expected.size);
    if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length || digest(bytes) !== expected.sha256)
      throw new Error('Intake original changed');
    return bytes;
  } finally {
    await file.close();
  }
}

function asciiFilename(name: string) {
  const value = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').replace(/\.+$/g, '_');
  return (value || 'document').slice(0, 120);
}

function encodeRfc5987(value: string) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function cleanName(value: unknown) {
  let name = typeof value === 'string' ? value : '';
  name = name.replace(/\\/g, '/').split('/').at(-1) ?? '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 180).toWellFormed();
}

function extensionOf(name: string) {
  return /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

function cleanTitle(value: unknown, fallback: string) {
  let title = typeof value === 'string' ? value.trim() : '';
  title = title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
  if (!title || !title.isWellFormed() || title.includes('\u0000')) title = fallback;
  title = title.slice(0, 240).toWellFormed();
  return title || '未命名材料';
}

function detect(bytes: Buffer, filename: string, declaredType: unknown): Detected {
  const name = cleanName(filename);
  const extension = extensionOf(name);
  const first = (bytes.length > 0 ? bytes[0] : -1) as number;
  if (bytes.length > 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { kind: 'pdf', mediaType: 'application/pdf' };
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  )
    return { kind: 'image', mediaType: 'image/png' };
  if (first === 0xff && bytes.length >= 3 && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', mediaType: 'image/jpeg' };
  }
  if (
    bytes.length >= 12 &&
    (bytes.subarray(0, 4).toString('latin1') === 'II*\0' || bytes.subarray(0, 4).toString('latin1') === 'MM\0*')
  )
    return { kind: 'image', mediaType: 'image/tiff' };
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') return { kind: 'image', mediaType: 'image/heic' };
    if (brand === 'mif1' || brand === 'msf1') return { kind: 'image', mediaType: 'image/heif' };
    if (brand === 'avif') return { kind: 'image', mediaType: 'image/avif' };
  }
  if (extension === 'txt') return { kind: 'text', mediaType: 'text/plain' };
  if (extension === 'md' || extension === 'markdown') return { kind: 'text', mediaType: 'text/markdown' };
  if (declaredType === 'text/plain' || declaredType === 'text/markdown') {
    return { kind: 'text', mediaType: declaredType === 'text/markdown' ? 'text/markdown' : 'text/plain' };
  }
  throw new RequestError(415, '只支持 PDF、照片（PNG/JPEG/HEIC/HEIF/AVIF/TIFF）和 UTF-8 的 txt/Markdown。');
}

async function stageOriginal(base: string, bytes: Buffer, original: IntakeOriginal) {
  const parent = dirname(base);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, '.incoming-'));
  const path = join(directory, 'original');
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    await writeFile(join(directory, 'meta.json'), JSON.stringify(original), { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, path };
}

async function readStoredOriginal(base: string, materialId: FactId): Promise<StoredOriginal> {
  const originalPath = join(base, 'original');
  const [originalStat, meta] = await Promise.all([
    stat(originalPath).catch(() => null),
    readFile(join(base, 'meta.json'), 'utf8').catch(() => null),
  ]);
  if (!originalStat || !meta) throw new RequestError(404, '原件暂不可读取。');
  const stored: Record<string, unknown> = JSON.parse(meta) as Record<string, unknown>;
  return {
    path: originalPath,
    name: typeof stored.name === 'string' ? stored.name : materialId,
    mediaType: typeof stored.mediaType === 'string' ? (stored.mediaType as IntakeMediaType) : 'application/octet-stream' as IntakeMediaType,
    size: typeof stored.size === 'number' ? stored.size : originalStat.size,
    sha256: typeof stored.sha256 === 'string' ? stored.sha256 : '',
  };
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
  const base = materialBase();
  const lifecycle = openIntakeLifecycle(db, base);

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
    const fullText = document.extraction.status === 'failed' || document.extraction.status === 'pending'
      ? null : document.extraction.text;
    const truncated = document.extraction.truncated || (fullText !== null && fullText.length > 4000);
    return {
      id: facts.id,
      title: material.title,
      text: material.text,
      characterCount: document.extraction.characterCount,
      truncated,
      fullText,
      revision: facts.document.ref.rev,
      extraction: document.extraction,
      ...(document.requestedExtraction ? { requestedExtraction: document.requestedExtraction } : {}),
      original: document.original,
      corrected: document.extraction.status === 'corrected',
      ...(document.extraction.status === 'corrected' && document.extraction.method === 'learner' ? {
        backgroundResearch: facts.document.purpose.includes('all') ? 'all' : facts.document.purpose.includes(intakeResearchPurpose) ? 'allowed' : 'private',
      } : {}),
    };
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
    const stored = await readStoredOriginal(base(id),id);
    if (stored.mediaType !== metadata.original.mediaType || stored.size !== metadata.original.size ||
        stored.sha256 !== metadata.original.sha256 || stored.name !== metadata.original.name ||
        digest(await readFile(stored.path)) !== metadata.original.sha256)
      throw new RequestError(500, '本地原件与记录不一致。');
    return { metadata, stored };
  }

  function prepareCapture(input: CaptureInput) {
    const requestId = clientRequest(input.requestId);
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) throw new RequestError(400, '请选择要交入的文件。');
    if (input.bytes.length > intakeFileLimit) throw new RequestError(413, '文件超过 25 MB。');
    const materialId = factId(stableId('intake-material', requestId));
    const deletionWatermark = submittedWatermark(input);
    const detected = detect(input.bytes, cleanName(input.filename), input.declaredType);
    const name = cleanName(input.filename) || '材料原件';
    const title = cleanTitle(input.title, name.replace(/\.[^.]+$/, '') || '材料原件');
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
      await withOriginal(materialId,input.bytes,original,async (staged, install) => {
        const extraction: IntakeExtraction = cloud ? {
          status: 'pending', method: 'mineru', text: '', error: null, warnings: [],
          pages: null, truncated: false, characterCount: 0,
        } : await extractLocalDocument(detected.kind,staged,input.bytes,intakeTextLimit);
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

  async function withOriginal<T>(id: FactId, bytes: Buffer, original: IntakeOriginal,
    save: (staged: string, install: () => Promise<void>) => Promise<T>) {
    const destination = base(id);
    const staged = await stageOriginal(destination,bytes,original);
    let installed = false;
    try {
      await writeFile(join(staged.directory,'store-id'), (await lifecycle.storeId()) + ':' + id, {mode:0o600});
      return await save(staged.path,async () => {
        // Installation runs under the learner lock after the original's commands succeed.
        await rm(destination,{recursive:true,force:true});
        await rename(staged.directory,destination);
        installed = true;
      });
    } catch (error) {
      if (installed) {
        await db.tx({ learner: studioLearner }, async tx => {
          await lockLearner(tx, studioLearner);
          const committed = await tx.query('SELECT id FROM facts WHERE learner_id=$1 AND id=$2', [studioLearner, id]);
          if (committed.rows.length === 0) await rm(destination, { recursive: true, force: true });
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(staged.directory,{recursive:true,force:true});
    }
  }

  async function paperReturn(input: CaptureInput & Parameters<typeof paperReturnSelection>[0],
    papers: ReturnType<typeof openCapturePapers>) {
    const {requestId,materialId,deletionWatermark,detected,title,original} = prepareCapture(input);
    if (detected.kind === 'text') throw new RequestError(415,'纸卷拍回需要照片或 PDF。');
    if (input.extraction !== undefined) throw new RequestError(400,'纸卷拍回只保存原件，请移除识别选项。');
    let selection;
    try { selection = paperReturnSelection(input,materialId); }
    catch { throw new RequestError(400,'请选择已发行纸卷、页码和原件用途。'); }
    return withOriginal(materialId,input.bytes,original,(_,install) => papers.upload(selection,{
      command:intakeCaptureId(requestId),deletionWatermark,title,original,install,
    }));
  }

  async function cloudOriginal(materialId: string, expectedSha256: string) {
    const stored = await readStoredOriginal(base(materialId), factId(materialId));
    const bytes = await readFile(stored.path);
    if (stored.size !== bytes.length || digest(bytes) !== expectedSha256) throw new Error('Intake original changed');
    return bytes;
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

async function sendOriginal(response: ServerResponse, metadata: Pick<IntakeMetadata,'original'>, stored: StoredOriginal) {
  const stream = createReadStream(stored.path);
  stream.on('error', () => response.destroy());
  response.writeHead(200, {
    'Content-Type': metadata.original.mediaType,
    'Content-Disposition': `attachment; filename="${asciiFilename(metadata.original.name)}"; filename*=UTF-8''${encodeRfc5987(metadata.original.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Length': String(stored.size),
  });
  stream.pipe(response);
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
          const { metadata, stored } = await intake.original(id);
          await sendOriginal(response, metadata, stored);
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
