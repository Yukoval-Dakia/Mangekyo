import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../kernel/src/db/types.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactReadDeniedError, FactNotFoundError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { textMaterial } from '../../modules/activity/library-values.ts';
import {
  captureIntakeCommand,
  correctIntakeCommand,
  correctIntakeInput,
  intakeDocument,
  intakeFactType,
  intakeFileLimit,
  intakeMediaTypes,
  intakePurpose,
  intakeTextLimit,
  type IntakeMediaType,
} from '../../modules/activity/intake-values.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

export const intakeSwiftTimeoutMs = 120_000;

export type IntakeMetadata = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly characterCount: number;
  readonly truncated: boolean;
  readonly fullText: string | null;
  readonly extraction: {
    readonly status: 'ok' | 'partial' | 'failed' | 'corrected';
    readonly method: 'pdfkit' | 'vision' | 'pdfkit+vision' | 'utf8' | 'learner';
    readonly error: string | null;
    readonly warnings: readonly string[];
    readonly pages: number | null;
    readonly truncated: boolean;
    readonly characterCount: number;
  };
  readonly original: { readonly name: string; readonly mediaType: string; readonly size: number; readonly sha256: string };
  readonly corrected: boolean;
  readonly revision: number;
};

type CaptureInput = {
  readonly requestId: unknown;
  readonly title?: unknown;
  readonly filename?: unknown;
  readonly declaredType?: unknown;
  readonly bytes: Buffer;
};

type CorrectInput = { readonly expectedRev: unknown; readonly materialId: unknown; readonly requestId: unknown; readonly text: unknown };

type StoredOriginal = {
  readonly created: boolean;
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
  return name.slice(0, 180);
}

function extensionOf(name: string) {
  return /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

function cleanTitle(value: unknown, fallback: string) {
  let title = typeof value === 'string' ? value.trim() : '';
  title = title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
  if (!title || !title.isWellFormed() || title.includes('\u0000')) title = fallback;
  if (title.length > 240) title = title.slice(0, 240);
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

async function storeOriginal(
  base: string,
  materialId: FactId,
  bytes: Buffer,
  original: { readonly name: string; readonly mediaType: IntakeMediaType },
): Promise<StoredOriginal> {
  const value = { ...original, size: bytes.length, sha256: digest(bytes) };
  const parent = dirname(base);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, '.incoming-'));
  try {
    await writeFile(join(staging, 'original'), bytes, { mode: 0o600 });
    await writeFile(join(staging, 'meta.json'), JSON.stringify(value), { mode: 0o600 });
    try {
      await rename(staging, base);
    } catch (error) {
      if (!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const stored = await readStoredOriginal(base, materialId);
      if (stored.sha256 !== value.sha256 || stored.name !== value.name || stored.mediaType !== value.mediaType)
        throw new RequestError(409, '同一个请求标识已经用于不同文件。');
      return stored;
    }
    return { created: true, path: join(base, 'original'), ...value };
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
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
    created: false,
    path: originalPath,
    name: typeof stored.name === 'string' ? stored.name : materialId,
    mediaType: typeof stored.mediaType === 'string' ? (stored.mediaType as IntakeMediaType) : 'application/octet-stream' as IntakeMediaType,
    size: typeof stored.size === 'number' ? stored.size : originalStat.size,
    sha256: typeof stored.sha256 === 'string' ? stored.sha256 : '',
  };
}

function failure(method: 'pdfkit' | 'vision' | 'utf8', text: string) {
  return {
    status: 'failed' as const,
    method,
    text: '',
    error: text,
    warnings: [],
    pages: null,
    truncated: false,
    characterCount: 0,
  };
}

function failedFromSwift(kind: 'pdf' | 'image', message: string) {
  return failure(kind === 'pdf' ? 'pdfkit' : 'vision', message);
}

async function runSwift(args: string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.env.MANGEKYO_SWIFT?.trim() || 'swift',
      args,
      {
        timeout: intakeSwiftTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(error);
        else resolvePromise({ stdout, stderr });
      },
    );
  });
}

async function extract(detected: Detected, storedPath: string, bytes: Buffer) {
  if (detected.kind === 'text') {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
      text = text.replace(/\r\n?/g, '\n');
      if (text.includes('\u0000')) throw new Error('文本包含无效控制字符。');
      if (!text.trim()) throw new Error('这个文本文件没有可读内容。');
      let truncated = false;
      if (text.length > intakeTextLimit) {
        text = text.slice(0, intakeTextLimit);
        truncated = true;
      }
      return {
        status: 'ok' as const,
        method: 'utf8' as const,
        text,
        error: null,
        warnings: truncated ? ['文本超过本地抽取上限，已保存前 200 万字。'] : [],
        pages: null,
        truncated,
        characterCount: text.length,
      };
    } catch (error) {
      return failure('utf8', error instanceof Error ? error.message : '文本抽取失败。');
    }
  }
  if (platform() !== 'darwin') {
    return failedFromSwift(detected.kind, '当前系统只支持 UTF-8 文本原样读取；原件已保存。');
  }
  const script = fileURLToPath(new URL('./extract-document.swift', import.meta.url));
  try {
    const { stdout, stderr } = await runSwift([script, detected.kind, storedPath]);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    if (result.ok !== true) {
      return failedFromSwift(detected.kind, typeof result.error === 'string' && result.error ? result.error : '本地文字抽取失败。');
    }
    try {
      return intakeExtractionFromSwift(result, detected);
    } catch (error) {
      return failedFromSwift(detected.kind, error instanceof Error ? error.message : '本地文字抽取结果无效。');
    }
  } catch (error) {
    if (error instanceof Error && (('killed' in error && error.killed === true) || ('code' in error && error.code === 'ETIMEDOUT'))) {
      return failedFromSwift(detected.kind, '本地文字抽取超时（120 秒）；原件已保存。');
    }
    const message = '本地文字抽取失败。';
    return failedFromSwift(detected.kind, message || '本地文字抽取失败；原件已保存。');
  }
}

function intakeExtractionFromSwift(result: Record<string, unknown>, detected: Detected) {
  const text = typeof result.text === 'string' ? result.text : '';
  if (!text.trim()) throw new Error('本地抽取没有得到可读文字。');
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((item) => typeof item === 'string').slice(0, 8) : [];
  return {
    status: (warnings.length > 0 || result.truncated === true ? 'partial' : 'ok') as 'ok' | 'partial',
    method: typeof result.method === 'string' ? (result.method as 'pdfkit' | 'vision' | 'pdfkit+vision') : detected.kind === 'pdf' ? 'pdfkit' : 'vision',
    text,
    error: null,
    warnings,
    pages: typeof result.pages === 'number' && Number.isSafeInteger(result.pages) ? result.pages : null,
    truncated: result.truncated === true,
    characterCount: text.length,
  };
}

function intakeIdFor(materialId: FactId): FactId {
  return factId(stableId('intake-document', materialId));
}

export function openIntake(db: Db, activity: LoadedModule) {
  const handle = createCommandHandler(db, {
    modules: [activity],
    hooks: { async onFactsChanged() {} },
  });
  const base = materialBase();

  async function factsFor(materialId: string) {
    const id = factId(materialId);
    const intakeId = intakeIdFor(id);
    return db.snapshot({ learner: studioLearner }, async (tx) => {
      const read = createCommandReadContext(tx, intakePurpose);
      const material = await read.fact(id, { mode: 'following' });
      const document = await read.fact(intakeId, { mode: 'following' });
      return { id, material, document, intakeId };
    });
  }

  async function metadataFor(materialId: string): Promise<IntakeMetadata> {
    let facts;
    try {
      facts = await factsFor(materialId);
    } catch (error) {
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) {
        throw new RequestError(404, '这份材料或它的交入记录不存在。');
      }
      throw new RequestError(500, '这份材料的交入记录无法读取。');
    }
    const material = textMaterial(facts.material.value);
    const document = intakeDocument(facts.document.value);
    if (document.materialId.toString() !== facts.id) throw new RequestError(404, '这份材料的交入记录不匹配。');
    const fullText = document.extraction.status === 'failed' ? null : document.extraction.text;
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
      original: document.original,
      corrected: document.extraction.status === 'corrected',
    };
  }

  async function metadataOrNull(materialId: string) {
    try {
      return await metadataFor(materialId);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return null;
      throw error;
    }
  }

  async function originalFor(materialId: string) {
    const metadata = await metadataFor(materialId);
    const stored = await readStoredOriginal(base(metadata.id), factId(metadata.id));
    if (stored.mediaType !== metadata.original.mediaType || stored.size !== metadata.original.size ||
        stored.sha256 !== metadata.original.sha256 || stored.name !== metadata.original.name ||
        digest(await readFile(stored.path)) !== metadata.original.sha256)
      throw new RequestError(500, '本地原件与记录不一致。');
    return { metadata, stored };
  }

  async function capture(input: CaptureInput) {
    const requestId = clientRequest(input.requestId);
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) throw new RequestError(400, '请选择要交入的文件。');
    if (input.bytes.length > intakeFileLimit) throw new RequestError(413, '文件超过 25 MB。');
    const materialId = factId(stableId('intake-material', requestId));
    const intakeId = intakeIdFor(materialId);
    const detected = detect(input.bytes, cleanName(input.filename), input.declaredType);
    const name = cleanName(input.filename) || '材料原件';
    const title = cleanTitle(input.title, name.replace(/\.[^.]+$/, '') || '材料原件');
    const sha256 = digest(input.bytes);
    const matches = (prior: IntakeMetadata) => prior.original.sha256 === sha256 && prior.original.name === name &&
      prior.title === title && prior.original.mediaType === detected.mediaType;
    const prior = await metadataOrNull(materialId.toString());
    if (prior) {
      if (!matches(prior)) throw new RequestError(409, '同一个请求标识已经用于不同文件或标题。');
      return { ...prior, created: false };
    }
    const stored = await storeOriginal(base(materialId), materialId, input.bytes, { name, mediaType: detected.mediaType });
    const extraction = await extract(detected, stored.path, input.bytes);
    const commandInput = {
      materialId: materialId.toString(),
      intakeId: intakeId.toString(),
      title,
      original: { name, mediaType: detected.mediaType, size: input.bytes.length, sha256 },
      extraction,
    };
    try {
      await handle({
        learner: studioLearner,
        actor: 'learner',
        purpose: intakePurpose,
        type: captureIntakeCommand,
        id: commandId(stableId('intake-capture', requestId)),
        input: commandInput,
      });
    } catch (error) {
      const raced = await metadataOrNull(materialId.toString());
      if (raced) {
        if (matches(raced)) return { ...raced, created: false };
      }
      if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
        throw new RequestError(409, '同一个请求标识已经用于不同内容。');
      }
      throw error;
    }
    return { ...(await metadataFor(materialId.toString())), created: true };
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
    capture,
    correct,
    metadata: metadataFor,
    original: originalFor,
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

async function sendOriginal(response: ServerResponse, metadata: IntakeMetadata, stored: StoredOriginal) {
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
): Promise<boolean> {
  const match = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(import|original|correction))?$/.exec(pathname);
  if (pathname === '/api/intake') {
    if (method !== 'POST') {
      json(response, 405, { error: '这个入口只接受交入请求。' });
      return true;
    }
    try {
      const contentType = request.headers['content-type']?.split(';')[0]?.toLowerCase() ?? '';
      let result;
      if (contentType === 'multipart/form-data') {
        const bytes = await readBody(request, intakeFileLimit + 512 * 1024);
        let form: FormData;
        try { form = await new Response(new Uint8Array(bytes), {headers: {'Content-Type': request.headers['content-type']!}}).formData(); }
        catch { throw new RequestError(400, '文件表单无法读取。'); }
        const file = form.get('file');
        if (!file || typeof file === 'string' || form.getAll('file').length !== 1)
          throw new RequestError(400, '请选择一个文件。');
        result = await intake.capture({requestId: form.get('requestId'), title: form.get('title'),
          filename: file.name, declaredType: file.type, bytes: Buffer.from(await file.arrayBuffer())});
      } else {
        const requestId = request.headers['x-request-id'];
        if (typeof requestId !== 'string' || requestId.trim() === '') throw new RequestError(400, '请求标识无效。');
        const bytes = await readBody(request, intakeFileLimit);
        result = await intake.capture({
          requestId,
          title:
            typeof request.headers['x-title'] === 'string'
              ? decodeUtf8(request.headers['x-title'])
              : undefined,
          filename:
            typeof request.headers['x-filename'] === 'string'
              ? decodeUtf8(request.headers['x-filename'])
              : undefined,
          declaredType: contentType,
          bytes,
        });
      }
      return json(response, 201, result), true;
    } catch (error) {
      json(response, error instanceof RequestError ? error.status : 500, {
        error: error instanceof RequestError ? error.message : '交入未能完成。',
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
          json(response, error instanceof RequestError ? error.status : 500, {
            error: error instanceof RequestError ? error.message : '这份材料的交入记录无法读取。',
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
          json(response, error instanceof RequestError ? error.status : 500, {
            error: error instanceof RequestError ? error.message : '这份材料的交入记录无法读取。',
          });
          return true;
        }
      }
      json(response, 405, { error: '这份材料的元数据只接受读取。' });
      return true;
    }
    if (action === 'original') {
      if (method === 'GET') {
        try {
          const { metadata, stored } = await intake.original(id);
          await sendOriginal(response, metadata, stored);
          return true;
        } catch (error) {
          if (!response.headersSent) {
            json(response, error instanceof RequestError ? error.status : 500, {
              error: error instanceof RequestError ? error.message : '原件未能读取。',
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
        json(response, error instanceof RequestError ? error.status : 500, {
          error: error instanceof RequestError ? error.message : '更正未能保存。',
        });
        return true;
      }
    }
    if (action === 'correction') {
      json(response, 405, { error: '更正只接受提交。' });
      return true;
    }
  }
  return false;
}
