import { factId, FactNotFoundError, type FactId } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import {
  correctIntakeInput,
  intakeDocument,
  intakeFileLimit,
  intakeFilename,
  intakeOriginal,
  IntakeResearchConflict,
  intakeResearchPermission,
  intakeTextLimit,
  intakeTitle,
  type IntakeOriginal,
} from './intake-values.ts';
import { projectIntakeMetadata, type IntakeMetadata } from './intake-view.ts';
import { paperReturnSelection } from './paper.ts';
import { clientRequest, RequestError } from './request.ts';
import { captureSourceType, sourceEnvelope } from './source.ts';

export type IntakeCaptureInput = {
  readonly requestId: unknown;
  readonly title?: unknown;
  readonly filename?: unknown;
  readonly declaredType?: unknown;
  readonly extraction?: unknown;
  readonly deletionWatermark?: unknown;
  readonly bytes: Uint8Array;
};

export type IntakeCorrectInput = {
  readonly expectedRev: unknown;
  readonly materialId: unknown;
  readonly requestId: unknown;
  readonly text: unknown;
};

export type DetectedDocument = { readonly kind: string; readonly mediaType: string };

export function asciiFilename(name: string): string {
  const value = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').replace(/\.+$/g, '_');
  return (value || 'document').slice(0, 120);
}

export function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

export function extensionOf(name: string): string {
  return /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

export function decodeLatin1Utf8(value: string): string {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return new TextDecoder('utf-8').decode(bytes);
}

export function originalDownloadHeaders(
  original: { readonly name: string; readonly mediaType: string },
  byteLength: number,
): Record<string, string> {
  return {
    'Content-Type': original.mediaType,
    'Content-Disposition': `attachment; filename="${asciiFilename(original.name)}"; filename*=UTF-8''${encodeRfc5987(original.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Length': String(byteLength),
  };
}

export function intakeFormText(form: FormData, field: string): string | undefined {
  const values = form.getAll(field);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new RequestError(400, '交入表单包含重复或无效的字段：' + field);
  }
  return values[0];
}

export function parseMultipartIntakeForm(
  form: FormData,
  hasPapers: boolean,
  parseWatermark: (input: { deletionWatermark?: unknown }) => string,
) {
  const file = form.get('file');
  if (!file || typeof file === 'string' || form.getAll('file').length !== 1) {
    throw new RequestError(400, '请选择一个文件。');
  }
  const watermark = parseWatermark({ deletionWatermark: intakeFormText(form, 'deletionWatermark') });
  const intent = intakeFormText(form, 'intent');
  const fields = {
    deletionWatermark: watermark,
    requestId: intakeFormText(form, 'requestId'),
    title: intakeFormText(form, 'title'),
    extraction: intakeFormText(form, 'extraction'),
    filename: file.name,
    declaredType: file.type,
  };
  if (intent === 'paper-return' && hasPapers) {
    return {
      kind: 'paper-return' as const,
      file,
      watermark,
      fields,
      paperFields: {
        issuanceId: intakeFormText(form, 'issuanceId'),
        page: intakeFormText(form, 'page'),
        purpose: intakeFormText(form, 'purpose'),
        retryId: intakeFormText(form, 'retryId'),
      },
    };
  }
  if (intent === undefined) {
    return { kind: 'capture' as const, file, watermark, fields };
  }
  throw new RequestError(400, '交入用途无效。');
}

export function requireHeaderRequestId(headers: Record<string, string | string[] | undefined>): string {
  const requestId = headers['x-request-id'];
  if (typeof requestId !== 'string' || requestId.trim() === '') {
    throw new RequestError(400, '请求标识无效。');
  }
  return requestId;
}

export function buildHeaderIntakeInput(
  headers: Record<string, string | string[] | undefined>,
  requestId: string,
  contentType: string,
  parseWatermark: (input: { deletionWatermark?: unknown }) => string,
) {
  const watermark = parseWatermark({ deletionWatermark: headers['x-deletion-watermark'] });
  return {
    watermark,
    fields: {
      requestId,
      deletionWatermark: watermark,
      title: typeof headers['x-title'] === 'string' ? decodeLatin1Utf8(headers['x-title']) : undefined,
      filename: typeof headers['x-filename'] === 'string' ? decodeLatin1Utf8(headers['x-filename']) : undefined,
      declaredType: contentType,
      extraction: headers['x-intake-extraction'],
    },
  };
}

export function prepareIntakeCapture<Detected extends DetectedDocument>(
  input: IntakeCaptureInput,
  deps: {
    readonly isBuffer: (value: unknown) => boolean;
    readonly materialIdFor: (requestId: string) => FactId;
    readonly parseWatermark: (input: { deletionWatermark?: unknown }) => string;
    readonly identify: (bytes: Uint8Array, extension: string, declaredType: unknown) => Detected | null;
    readonly sha256: (bytes: Uint8Array) => string;
  },
) {
  const requestId = clientRequest(input.requestId);
  if (!deps.isBuffer(input.bytes) || input.bytes.length === 0) throw new RequestError(400, '请选择要交入的文件。');
  if (input.bytes.length > intakeFileLimit) throw new RequestError(413, '文件超过 25 MB。');
  const materialId = deps.materialIdFor(requestId);
  const deletionWatermark = deps.parseWatermark(input);
  const filename = intakeFilename(input.filename);
  const detected = deps.identify(input.bytes, extensionOf(intakeFilename(filename)), input.declaredType);
  if (!detected) {
    throw new RequestError(415, '只支持 PDF、照片（PNG/JPEG/HEIC/HEIF/AVIF/TIFF）和 UTF-8 的 txt/Markdown。');
  }
  const name = filename || '材料原件';
  const title = intakeTitle(input.title, name.replace(/\.[^.]+$/, '') || '材料原件');
  const sha256 = deps.sha256(input.bytes);
  let original: IntakeOriginal;
  try {
    original = intakeOriginal({ name, mediaType: detected.mediaType, size: input.bytes.length, sha256 });
    materialFact.schema.parse({ title, text: '原件' });
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : '交入材料无效。');
  }
  return { requestId, materialId, deletionWatermark, detected, title, original };
}

export function resolveCaptureExtraction(
  extraction: unknown,
  mediaType: string,
  mineruSupports: (mediaType: string) => boolean,
): { readonly requested: 'local' | 'mineru'; readonly cloud: boolean } {
  const requested = extraction ?? 'local';
  if (requested !== 'local' && requested !== 'mineru') throw new RequestError(400, '请选择有效的识别方式。');
  const cloud = requested === 'mineru';
  if (cloud && !mineruSupports(mediaType)) throw new RequestError(415, 'MinerU 支持 PDF、PNG 和 JPEG。');
  return { requested, cloud };
}

export function matchesCaptureReplay(
  prior: IntakeMetadata,
  original: IntakeOriginal,
  title: string,
  mediaType: string,
  requested: 'local' | 'mineru',
): boolean {
  return (
    prior.original.sha256 === original.sha256 &&
    prior.original.name === original.name &&
    prior.title === title &&
    prior.original.mediaType === mediaType &&
    (prior.requestedExtraction ?? 'local') === requested
  );
}

export function resolvePaperReturnSelection(
  input: Parameters<typeof paperReturnSelection>[0] & { readonly extraction?: unknown },
  materialId: FactId,
  detectedKind: string,
) {
  if (detectedKind === 'text') throw new RequestError(415, '纸卷拍回需要照片或 PDF。');
  if (input.extraction !== undefined) throw new RequestError(400, '纸卷拍回只保存原件，请移除识别选项。');
  try {
    return paperReturnSelection(input, materialId);
  } catch {
    throw new RequestError(400, '请选择已发行纸卷、页码和原件用途。');
  }
}

export function projectIntakeFacts(
  materialId: FactId,
  materialValue: unknown,
  documentValue: unknown,
  documentRev: number,
  documentPurpose: readonly string[],
): IntakeMetadata {
  const material = materialFact.schema.parse(materialValue);
  const document = intakeDocument(documentValue);
  if (document.materialId.toString() !== materialId) throw new RequestError(404, '这份材料的交入记录不匹配。');
  return projectIntakeMetadata(document, material, documentRev, documentPurpose);
}

export function extractPaperReturnOriginal(source: { readonly type: string; readonly value: unknown }, id: FactId) {
  if (source.type !== captureSourceType) return null;
  const envelope = sourceEnvelope(source.value);
  return envelope.kind === 'paper-return' && envelope.originals[0]?.blobRef === id ? envelope.originals[0] : null;
}

export function isExpectedCloudCompletion(
  work: { readonly slotType: string; readonly slotKey: string } | null | undefined,
  expectedSlotType: string,
  documentRef: { readonly id: string; readonly rev: number },
  materialRef: { readonly id: string; readonly rev: number },
  changes: readonly { readonly kind: string; readonly ref: { readonly id: string; readonly rev: number } }[],
): boolean {
  if (work?.slotType !== expectedSlotType || work.slotKey !== documentRef.id) return false;
  return [documentRef, materialRef].every((target) =>
    changes.some((change) => change.kind === 'correct' && change.ref.id === target.id && change.ref.rev === target.rev + 1),
  );
}

export function prepareIntakeCorrection(input: IntakeCorrectInput, intakeIdFor: (id: FactId) => FactId) {
  const materialId = factId(input.materialId as string);
  const requestId = clientRequest(input.requestId);
  try {
    const data = correctIntakeInput({
      materialId,
      intakeId: intakeIdFor(materialId),
      expectedRev: input.expectedRev,
      text: input.text,
    });
    return { materialId, requestId, data };
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : '更正无效。');
  }
}

export function prepareIntakeResearchPermission(materialId: string, input: unknown, intakeIdFor: (id: FactId) => FactId) {
  const id = factId(materialId);
  try {
    const data = intakeResearchPermission({ ...(input as object), materialId, intakeId: intakeIdFor(id) });
    return { id, data };
  } catch {
    throw new RequestError(400, '原件版本或后台用途无效。');
  }
}

export function translateIntakeReadError(error: unknown, isLifecycle: boolean, isDenied: boolean): Error {
  if (isLifecycle || error instanceof RequestError) return error as Error;
  if (error instanceof FactNotFoundError || isDenied) return new RequestError(404, '这份材料或它的交入记录不存在。');
  return new RequestError(500, '这份材料的交入记录无法读取。');
}

export function translateIntakeCorrectionError(error: unknown, isDenied: boolean): unknown {
  if (error instanceof Error && (error.message === '原文版本已经变更。' || error.message.startsWith('Fact revision conflict'))) {
    return new RequestError(409, '这份文字已有新版本，请打开原文核对后再保存。');
  }
  if (error instanceof FactNotFoundError || isDenied) return new RequestError(404, '找不到这份原件。');
  if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
    return new RequestError(409, '同一个更正标识已经用于不同文字。');
  }
  return error;
}

export function translateIntakeResearchError(error: unknown, isDenied: boolean): unknown {
  if (error instanceof IntakeResearchConflict) return new RequestError(409, error.message);
  if (error instanceof FactNotFoundError || isDenied) return new RequestError(404, '找不到这份原件。');
  return error;
}

export type IntakeRoute =
  | { readonly kind: 'lifecycle' }
  | { readonly kind: 'options' }
  | { readonly kind: 'intake' }
  | { readonly kind: 'material-read'; readonly id: string }
  | { readonly kind: 'erasure'; readonly id: string }
  | { readonly kind: 'original'; readonly id: string }
  | { readonly kind: 'correction'; readonly id: string }
  | { readonly kind: 'research-permission'; readonly id: string }
  | { readonly kind: 'method-not-allowed'; readonly error: string };

const materialPathPattern = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(import|original|correction|research-permission|erasure))?$/;

export function parseIntakeRoute(pathname: string, method: string | undefined): IntakeRoute | null {
  if (pathname === '/api/lifecycle' && method === 'GET') return { kind: 'lifecycle' };
  if (pathname === '/api/intake/options' && method === 'GET') return { kind: 'options' };
  if (pathname === '/api/intake') {
    return method === 'POST'
      ? { kind: 'intake' }
      : { kind: 'method-not-allowed', error: '这个入口只接受交入请求。' };
  }
  const match = materialPathPattern.exec(pathname);
  if (!match?.[1]) return null;
  const id = match[1];
  const action = match[2];
  if (!action) {
    return method === 'GET'
      ? { kind: 'material-read', id }
      : { kind: 'method-not-allowed', error: '这个材料入口只接受读取。' };
  }
  if (action === 'import') {
    return method === 'GET'
      ? { kind: 'material-read', id }
      : { kind: 'method-not-allowed', error: '这份材料的元数据只接受读取。' };
  }
  if (action === 'erasure') return method === 'POST' ? { kind: 'erasure', id } : null;
  if (action === 'original') {
    return method === 'GET'
      ? { kind: 'original', id }
      : { kind: 'method-not-allowed', error: '原件只接受下载。' };
  }
  if (action === 'correction') {
    return method === 'POST'
      ? { kind: 'correction', id }
      : { kind: 'method-not-allowed', error: '更正只接受提交。' };
  }
  if (action === 'research-permission') {
    return method === 'PUT'
      ? { kind: 'research-permission', id }
      : { kind: 'method-not-allowed', error: '这个入口只接受用途设置。' };
  }
  return null;
}

export function formatIntakeErrorResponse(
  error: unknown,
  fallback: string,
  options?: {
    readonly lifecycle?: { readonly status: number; readonly message: string; readonly code?: string | undefined } | null;
    readonly syntaxMessage?: string | undefined;
    readonly notFoundAs404?: boolean | undefined;
  },
): { readonly status: number; readonly body: { readonly error: string; readonly code?: string } } {
  if (options?.syntaxMessage && error instanceof SyntaxError) {
    return { status: 400, body: { error: options.syntaxMessage } };
  }
  if (error instanceof RequestError) {
    return { status: error.status, body: { error: error.message } };
  }
  if (options?.lifecycle) {
    return {
      status: options.lifecycle.status,
      body: {
        error: options.lifecycle.message,
        ...(options.lifecycle.code ? { code: options.lifecycle.code } : {}),
      },
    };
  }
  if (options?.notFoundAs404) {
    if (error instanceof SyntaxError) return { status: 400, body: { error: error.message } };
    if (error instanceof FactNotFoundError) return { status: 404, body: { error: error.message } };
  }
  return { status: 500, body: { error: fallback } };
}

export type IntakeHttpResult<Bytes extends Uint8Array> =
  | { readonly kind: 'json'; readonly status: number; readonly headers?: Record<string, string>; readonly body: unknown }
  | { readonly kind: 'bytes'; readonly status: number; readonly headers: Record<string, string>; readonly bytes: Bytes };

export type IntakeHttpAdapter<Bytes extends Uint8Array> = {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly readBody: (limit: number) => Promise<Bytes>;
  readonly fromArrayBuffer: (buffer: ArrayBuffer) => Bytes;
  readonly decodeUtf8Bytes: (bytes: Bytes) => string;
  readonly parseWatermark: (input: { deletionWatermark?: unknown }) => string;
  readonly readLifecycleError: (error: unknown, includeCode: boolean) =>
    { readonly status: number; readonly message: string; readonly code?: string | undefined } | null;
  readonly mineruEnabled: () => boolean;
  readonly hasPapers: boolean;
  readonly lifecycleState: () => Promise<{ readonly watermark: string }>;
  readonly erase: (id: string, input: Record<string, unknown>) => Promise<unknown>;
  readonly metadata: (id: string) => Promise<unknown>;
  readonly original: (id: string) => Promise<{ readonly metadata: Pick<IntakeMetadata, 'original'>; readonly bytes: Bytes }>;
  readonly capture: (input: Omit<IntakeCaptureInput, 'bytes'> & { readonly bytes: Bytes }) => Promise<unknown>;
  readonly paperReturn: (
    input: Omit<IntakeCaptureInput, 'bytes'> & {
      readonly bytes: Bytes;
      readonly issuanceId: unknown;
      readonly page: unknown;
      readonly purpose: unknown;
      readonly retryId?: unknown;
    },
  ) => Promise<unknown>;
  readonly correct: (input: IntakeCorrectInput) => Promise<unknown>;
  readonly setResearch: (id: string, input: unknown) => Promise<unknown>;
};

export async function dispatchIntakeHttp<Bytes extends Uint8Array>(
  pathname: string,
  method: string | undefined,
  adapter: IntakeHttpAdapter<Bytes>,
): Promise<IntakeHttpResult<Bytes> | null> {
  const route = parseIntakeRoute(pathname, method);
  if (!route) return null;
  const fail = (
    error: unknown,
    fallback: string,
    options?: { readonly includeCode?: boolean; readonly syntaxMessage?: string; readonly notFoundAs404?: boolean },
  ): IntakeHttpResult<Bytes> => {
    const formatted = formatIntakeErrorResponse(error, fallback, {
      ...options,
      lifecycle: adapter.readLifecycleError(error, Boolean(options?.includeCode)),
    });
    return { kind: 'json', status: formatted.status, body: formatted.body };
  };
  if (route.kind === 'method-not-allowed') return { kind: 'json', status: 405, body: { error: route.error } };
  if (route.kind === 'lifecycle') {
    const state = await adapter.lifecycleState();
    return { kind: 'json', status: 200, headers: { 'X-Deletion-Watermark': state.watermark }, body: state };
  }
  if (route.kind === 'options') return { kind: 'json', status: 200, body: { mineru: adapter.mineruEnabled() } };
  if (route.kind === 'intake') {
    try {
      const rawContentType = typeof adapter.headers['content-type'] === 'string' ? adapter.headers['content-type'] : '';
      const contentType = rawContentType.split(';')[0]?.toLowerCase() ?? '';
      let result: unknown;
      let watermark: string;
      if (contentType === 'multipart/form-data') {
        const bytes = await adapter.readBody(intakeFileLimit + 512 * 1024);
        let form: FormData;
        try {
          form = await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': rawContentType } }).formData();
        } catch {
          throw new RequestError(400, '文件表单无法读取。');
        }
        const parsed = parseMultipartIntakeForm(form, adapter.hasPapers, adapter.parseWatermark);
        watermark = parsed.watermark;
        const upload = { ...parsed.fields, bytes: adapter.fromArrayBuffer(await parsed.file.arrayBuffer()) };
        result = parsed.kind === 'paper-return'
          ? await adapter.paperReturn({ ...upload, ...parsed.paperFields })
          : await adapter.capture(upload);
      } else {
        const requestId = requireHeaderRequestId(adapter.headers);
        const bytes = await adapter.readBody(intakeFileLimit);
        const parsed = buildHeaderIntakeInput(adapter.headers, requestId, contentType, adapter.parseWatermark);
        watermark = parsed.watermark;
        result = await adapter.capture({ ...parsed.fields, bytes });
      }
      return { kind: 'json', status: 201, headers: { 'X-Deletion-Watermark': watermark }, body: result };
    } catch (error) {
      return fail(error, '交入未能完成。', { includeCode: true });
    }
  }
  if (route.kind === 'material-read') {
    try { return { kind: 'json', status: 200, body: await adapter.metadata(route.id) }; }
    catch (error) { return fail(error, '这份材料的交入记录无法读取。'); }
  }
  if (route.kind === 'erasure') {
    const rawContentType = typeof adapter.headers['content-type'] === 'string' ? adapter.headers['content-type'] : '';
    if (rawContentType.split(';')[0] !== 'application/json') {
      return { kind: 'json', status: 415, body: { error: '需要 JSON 请求。' } };
    }
    try {
      const input = JSON.parse(adapter.decodeUtf8Bytes(await adapter.readBody(4096)));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, '删除请求格式无效。');
      return { kind: 'json', status: 200, body: await adapter.erase(route.id, input as Record<string, unknown>) };
    } catch (error) {
      return fail(error, '删除未能完成。', { notFoundAs404: true });
    }
  }
  if (route.kind === 'original') {
    try {
      const { metadata, bytes } = await adapter.original(route.id);
      return { kind: 'bytes', status: 200, headers: originalDownloadHeaders(metadata.original, bytes.length), bytes };
    } catch (error) {
      return fail(error, '原件未能读取。');
    }
  }
  if (route.kind === 'correction') {
    try {
      const value = JSON.parse(adapter.decodeUtf8Bytes(await adapter.readBody(intakeTextLimit * 4 + 4096))) as Record<string, unknown>;
      const result = await adapter.correct({ materialId: route.id, requestId: value.requestId, expectedRev: value.expectedRev, text: value.text });
      return { kind: 'json', status: 200, body: result };
    } catch (error) {
      return fail(error, '更正未能保存。', { syntaxMessage: '更正请求格式无效。' });
    }
  }
  try {
    const value: unknown = JSON.parse(adapter.decodeUtf8Bytes(await adapter.readBody(4096)));
    return { kind: 'json', status: 200, body: await adapter.setResearch(route.id, value) };
  } catch (error) {
    return fail(error, '原件用途未能更新。', { syntaxMessage: '用途请求格式无效。' });
  }
}
