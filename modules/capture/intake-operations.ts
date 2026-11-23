import { factId, FactNotFoundError, type FactId } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import {
  appendIntakePagesCommand,
  appendIntakePagesInput,
  captureIntakeCommand,
  completeCloudIntakeCommand,
  completeVisionIntakeCommand,
  correctIntakeCommand,
  correctIntakeInput,
  IntakeAppendPagesConflict,
  intakeDocument,
  intakeFactType,
  intakeFileLimit,
  intakeFilename,
  intakeMultiPageBodyLimit,
  intakeOriginal,
  IntakeResearchConflict,
  intakeResearchPermission,
  IntakeVisionRetryConflict,
  intakeTextLimit,
  intakeTitle,
  materialType,
  maxIntakePhotoPages,
  retryVisionIntakeCommand,
  retryVisionIntakeInput,
  setIntakeResearchCommand,
  type IntakeOriginal,
  type IntakePageOriginal,
  type IntakeRequestedExtraction,
} from './intake-values.ts';
import { projectIntakeMetadata, type IntakeMetadata } from './intake-view.ts';
import { visionOcrSupports } from './vision-paper-ocr.ts';
import { paperReturnSelection } from './paper.ts';
import { clientRequest, RequestError } from './request.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from './source.ts';

export type IntakeCaptureInput = {
  readonly requestId: unknown;
  readonly title?: unknown;
  readonly filename?: unknown;
  readonly declaredType?: unknown;
  readonly extraction?: unknown;
  readonly deletionWatermark?: unknown;
  readonly bytes: Uint8Array;
};

export type IntakePageFileInput<Bytes extends Uint8Array = Uint8Array> = {
  readonly filename?: unknown;
  readonly declaredType?: unknown;
  readonly bytes: Bytes;
};

export type IntakeMultiPageCaptureInput<Bytes extends Uint8Array = Uint8Array> = {
  readonly requestId: unknown;
  readonly title?: unknown;
  readonly extraction?: unknown;
  readonly deletionWatermark?: unknown;
  readonly pages: readonly IntakePageFileInput<Bytes>[];
};

export type IntakeAppendPagesInput<Bytes extends Uint8Array = Uint8Array> = {
  readonly materialId: unknown;
  readonly requestId: unknown;
  readonly expectedRev: unknown;
  readonly expectedMaterialRev?: unknown;
  readonly pages: readonly IntakePageFileInput<Bytes>[];
};

export type IntakeCorrectInput = {
  readonly expectedRev: unknown;
  readonly materialId: unknown;
  readonly requestId: unknown;
  readonly text: unknown;
};

export type IntakeRetryVisionInput = {
  readonly materialId: unknown;
  readonly expectedRev: unknown;
  readonly requestId: unknown;
  readonly expectedMaterialRev?: unknown;
  readonly pages?: unknown;
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

function multipartFiles(form: FormData, allowMultiple = true): readonly File[] {
  const hasFile = form.getAll('file').length > 0;
  const hasFiles = form.getAll('files').length > 0;
  if (hasFile && hasFiles) {
    throw new RequestError(400, '请统一使用 file 或 files 字段上传文件，不要混用。');
  }
  const files: File[] = [];
  for (const [key, value] of form.entries()) {
    if (key !== 'file' && key !== 'files') continue;
    if (!value || typeof value === 'string') throw new RequestError(400, '文件表单字段无效。');
    files.push(value);
  }
  if (files.length === 0) throw new RequestError(400, '请选择一个文件。');
  if (!allowMultiple && files.length !== 1) throw new RequestError(400, '请选择一个文件。');
  return files;
}

export function parseMultipartIntakeForm(
  form: FormData,
  hasPapers: boolean,
  parseWatermark: (input: { deletionWatermark?: unknown }) => string,
  options?: { readonly allowMultiple?: boolean },
) {
  const files = multipartFiles(form, options?.allowMultiple ?? true);
  const watermark = parseWatermark({ deletionWatermark: intakeFormText(form, 'deletionWatermark') });
  const intent = intakeFormText(form, 'intent');
  const baseFields = {
    deletionWatermark: watermark,
    requestId: intakeFormText(form, 'requestId'),
    title: intakeFormText(form, 'title'),
    extraction: intakeFormText(form, 'extraction'),
  };
  if (intent === 'paper-return' && hasPapers) {
    if (files.length !== 1) throw new RequestError(400, '纸卷拍回单次仅支持上传一个文件。');
    const file = files[0]!;
    return {
      kind: 'paper-return' as const, file, watermark,
      fields: { ...baseFields, filename: file.name, declaredType: file.type },
      paperFields: {
        issuanceId: intakeFormText(form, 'issuanceId'), page: intakeFormText(form, 'page'),
        purpose: intakeFormText(form, 'purpose'), retryId: intakeFormText(form, 'retryId'),
      },
    };
  }
  if (intent === undefined) {
    if (files.length === 1) {
      const file = files[0]!;
      return { kind: 'capture' as const, file, files, watermark, fields: { ...baseFields, filename: file.name, declaredType: file.type } };
    }
    if (files.length > maxIntakePhotoPages) throw new RequestError(400, `单次最多合并 ${maxIntakePhotoPages} 页试卷照片。`);
    return { kind: 'capture-pages' as const, files, watermark, fields: baseFields };
  }
  throw new RequestError(400, '交入用途无效。');
}

export function parseMultipartAppendPagesForm(form: FormData) {
  const files = multipartFiles(form);
  if (files.length >= maxIntakePhotoPages) {
    throw new RequestError(400, `单次续拍最多追加 ${maxIntakePhotoPages - 1} 页照片。`);
  }
  const expectedRevRaw = intakeFormText(form, 'expectedRev');
  const expectedMaterialRevRaw = intakeFormText(form, 'expectedMaterialRev');
  const expectedRev = expectedRevRaw !== undefined && /^[1-9]\d*$/.test(expectedRevRaw) ? Number(expectedRevRaw) : NaN;
  const expectedMaterialRev = expectedMaterialRevRaw === undefined
    ? undefined
    : /^[1-9]\d*$/.test(expectedMaterialRevRaw) ? Number(expectedMaterialRevRaw) : NaN;
  return {
    files,
    requestId: intakeFormText(form, 'requestId'),
    expectedRev,
    ...(expectedMaterialRev === undefined ? {} : { expectedMaterialRev }),
  };
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

type PhotoPageDeps<Detected extends DetectedDocument> = {
  readonly isBuffer: (value: unknown) => boolean;
  readonly identify: (bytes: Uint8Array, extension: string, declaredType: unknown) => Detected | null;
  readonly sha256: (bytes: Uint8Array) => string;
};

function preparePhotoPages<Detected extends DetectedDocument, Bytes extends Uint8Array>(
  entries: readonly IntakePageFileInput<Bytes>[],
  deps: PhotoPageDeps<Detected>,
  opts: {
    readonly empty: (i: number) => string;
    readonly overFile: (i: number) => string;
    readonly overTotal: string;
    readonly unsupported: string;
    readonly invalid: string;
    readonly fallbackName: (i: number) => string;
    readonly requireVision: boolean;
  },
) {
  let totalBytes = 0;
  return entries.map((entry, index) => {
    const page = index + 1;
    if (!deps.isBuffer(entry.bytes) || entry.bytes.length === 0) throw new RequestError(400, opts.empty(page));
    if (entry.bytes.length > intakeFileLimit) throw new RequestError(413, opts.overFile(page));
    totalBytes += entry.bytes.length;
    if (totalBytes > intakeMultiPageBodyLimit) throw new RequestError(413, opts.overTotal);
    const filename = intakeFilename(entry.filename);
    const detected = deps.identify(entry.bytes, extensionOf(filename), entry.declaredType);
    if (!detected || (opts.requireVision && !visionOcrSupports(detected.mediaType))) {
      throw new RequestError(415, opts.unsupported);
    }
    const name = filename || opts.fallbackName(page);
    try {
      const original = intakeOriginal({ name, mediaType: detected.mediaType, size: entry.bytes.length, sha256: deps.sha256(entry.bytes) });
      return { page, bytes: entry.bytes, detected, original };
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : opts.invalid);
    }
  });
}

export function prepareIntakeMultiPageCapture<Detected extends DetectedDocument, Bytes extends Uint8Array = Uint8Array>(
  input: IntakeMultiPageCaptureInput<Bytes>,
  deps: PhotoPageDeps<Detected> & {
    readonly materialIdFor: (requestId: string) => FactId;
    readonly parseWatermark: (input: { deletionWatermark?: unknown }) => string;
  },
) {
  const requestId = clientRequest(input.requestId);
  if (!Array.isArray(input.pages) || input.pages.length === 0) throw new RequestError(400, '请选择要交入的文件。');
  if (input.pages.length > maxIntakePhotoPages) throw new RequestError(400, `单次最多合并 ${maxIntakePhotoPages} 页试卷照片。`);
  if (input.pages.length > 1 && input.extraction !== undefined && input.extraction !== 'vision_llm') {
    throw new RequestError(400, '多页合并拍卷仅支持视觉模型识别。');
  }
  const materialId = deps.materialIdFor(requestId);
  const deletionWatermark = deps.parseWatermark(input);
  const pages = preparePhotoPages(input.pages, deps, {
    empty: i => `第 ${i} 页文件为空。`,
    overFile: i => `第 ${i} 页文件超过 25 MB。`,
    overTotal: '多页合并文件总大小超过 60 MB。',
    unsupported: '多页合并拍卷仅支持照片（PNG/JPEG/HEIC/HEIF/AVIF/TIFF/WebP）。',
    invalid: '交入材料无效。',
    fallbackName: i => `试卷第${i}页`,
    requireVision: input.pages.length > 1,
  }).map(item => ({ ...item, original: { ...item.original, page: item.page } as IntakePageOriginal }));
  const firstOriginal = pages[0]!.original;
  const baseName = firstOriginal.name.replace(/\.[^.]+$/, '') || '多页试卷';
  const title = intakeTitle(input.title, pages.length > 1 ? `${baseName}（共 ${pages.length} 页）` : baseName);
  try {
    materialFact.schema.parse({ title, text: '原件' });
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : '交入标题无效。');
  }
  const { page: _firstPage, ...coverOriginal } = firstOriginal;
  return {
    requestId, materialId, deletionWatermark, title,
    original: coverOriginal as IntakeOriginal,
    originals: pages.map(item => item.original),
    pages,
  };
}

export function matchesMultiPageCaptureReplay(
  prior: IntakeMetadata,
  originals: readonly IntakePageOriginal[],
  title: string,
  requested: 'local' | 'mineru' | 'vision_llm',
): boolean {
  const priorPages: readonly IntakePageOriginal[] = prior.originals && prior.originals.length > 0
    ? prior.originals
    : [{ ...prior.original, mediaType: prior.original.mediaType as IntakeOriginal['mediaType'], page: 1 }];
  if (prior.title !== title || (prior.requestedExtraction ?? 'local') !== requested || priorPages.length !== originals.length) return false;
  return originals.every((page, index) => {
    const existing = priorPages[index]!;
    return existing.page === page.page && existing.sha256 === page.sha256 &&
      existing.name === page.name && existing.mediaType === page.mediaType && existing.size === page.size;
  });
}

export function prepareIntakeAppendPages<Detected extends DetectedDocument, Bytes extends Uint8Array = Uint8Array>(
  input: IntakeAppendPagesInput<Bytes>,
  intakeIdFor: (id: FactId) => FactId,
  deps: PhotoPageDeps<Detected>,
) {
  const requestId = clientRequest(input.requestId);
  let materialId: FactId;
  try { materialId = factId(input.materialId as string); }
  catch { throw new RequestError(400, '材料标识无效。'); }
  if (!Array.isArray(input.pages) || input.pages.length === 0 || input.pages.length >= maxIntakePhotoPages) {
    throw new RequestError(400, `单次续拍可追加 1 到 ${maxIntakePhotoPages - 1} 页照片。`);
  }
  const prepared = preparePhotoPages(input.pages, deps, {
    empty: i => `第 ${i} 张续拍照片为空。`,
    overFile: i => `第 ${i} 张续拍照片超过 25 MB。`,
    overTotal: '续拍照片总大小超过 60 MB。',
    unsupported: '续拍加页仅支持照片（PNG/JPEG/HEIC/HEIF/AVIF/TIFF/WebP）。',
    invalid: '续拍照片无效。',
    fallbackName: i => `续拍第${i}页`,
    requireVision: true,
  }).map(({ bytes, original }) => ({ bytes, original }));
  try {
    const data = appendIntakePagesInput({
      materialId, intakeId: intakeIdFor(materialId), expectedRev: input.expectedRev,
      ...(input.expectedMaterialRev === undefined ? {} : { expectedMaterialRev: input.expectedMaterialRev }),
      pages: prepared.map(item => item.original),
    });
    return { materialId, requestId, data, pages: prepared };
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : '续拍加页请求无效。');
  }
}

function translateIntakeCommandError(
  error: unknown,
  isDenied: boolean,
  opts: {
    readonly conflict?: (error: unknown) => string | null;
    readonly revConflict?: string;
    readonly duplicateCommand?: string;
  },
): unknown {
  const custom = opts.conflict?.(error);
  if (custom) return new RequestError(409, custom);
  if (opts.revConflict && error instanceof Error && error.message.startsWith('Fact revision conflict')) {
    return new RequestError(409, opts.revConflict);
  }
  if (error instanceof FactNotFoundError || isDenied) return new RequestError(404, '找不到这份原件。');
  if (opts.duplicateCommand && error instanceof Error && error.message === 'Command ID already used with a different command identity') {
    return new RequestError(409, opts.duplicateCommand);
  }
  return error;
}

export function translateIntakeAppendPagesError(error: unknown, isDenied: boolean): unknown {
  return translateIntakeCommandError(error, isDenied, {
    conflict: err => err instanceof IntakeAppendPagesConflict ? err.message : null,
    revConflict: '原文版本已经变更，请刷新后再续拍加页。',
    duplicateCommand: '同一个续拍标识已经用于不同照片。',
  });
}

export function resolveCaptureExtraction(
  extraction: unknown,
  mediaType: string,
  mineruSupports: (mediaType: string) => boolean,
  options?: { readonly asyncPhotoDefault?: boolean },
): { readonly requested: 'local' | 'mineru' | 'vision_llm'; readonly cloud: boolean; readonly asyncVision: boolean } {
  const requested = extraction ?? 'local';
  if (requested !== 'local' && requested !== 'mineru' && requested !== 'vision_llm')
    throw new RequestError(400, '请选择有效的识别方式。');
  if (requested === 'vision_llm') {
    if (!visionOcrSupports(mediaType))
      throw new RequestError(415, '强视觉识别只支持照片（PNG/JPEG/HEIC/HEIF/AVIF/TIFF/WebP）。');
    return { requested: 'vision_llm', cloud: false, asyncVision: true };
  }
  const cloud = requested === 'mineru';
  if (cloud && !mineruSupports(mediaType)) throw new RequestError(415, 'MinerU 支持 PDF、PNG 和 JPEG。');
  if (!cloud && extraction === undefined && options?.asyncPhotoDefault === true && visionOcrSupports(mediaType)) {
    return { requested: 'vision_llm', cloud: false, asyncVision: true };
  }
  return { requested: requested as 'local' | 'mineru', cloud, asyncVision: false };
}

export function matchesCaptureReplay(
  prior: IntakeMetadata,
  original: IntakeOriginal,
  title: string,
  mediaType: string,
  requested: 'local' | 'mineru' | 'vision_llm',
): boolean {
  return (
    (prior.originals?.length ?? 1) === 1 &&
    prior.original.sha256 === original.sha256 &&
    prior.original.size === original.size &&
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

const intakeEraseCommands = [
  captureIntakeCommand, correctIntakeCommand, completeCloudIntakeCommand, completeVisionIntakeCommand,
  retryVisionIntakeCommand, appendIntakePagesCommand, setIntakeResearchCommand,
];

export function parseIntakeErasureRequest(id: string, input: Record<string, unknown>) {
  const root = factId(id);
  if (input.confirmation !== 'permanently-delete-original') throw new RequestError(403, '请明确确认永久删除原件和历次抽取。');
  const rev = input.expectedRev;
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) throw new RequestError(400, '材料版本无效。');
  return { root, rev, requestKey: clientRequest(input.requestId) };
}

export function planIntakeErasureTarget(
  root: FactId, rev: number,
  material: { readonly type: string; readonly rev: number; readonly value: unknown },
  document?: { readonly id: FactId; readonly type: string; readonly rev: number; readonly value: unknown },
): { readonly kind: 'ok'; readonly ids: FactId[]; readonly commandTypes: string[] } | { readonly kind: 'conflict'; readonly message: string } {
  if (material.type === captureSourceType) {
    const source = sourceEnvelope(material.value);
    if ((source.kind !== 'paper-return' && !source.workbookAttachment) || source.originals.length !== 1 || source.originals[0]?.blobRef !== root)
      throw new RequestError(404, '找不到这份交入原件。');
    return material.rev !== rev
      ? { kind: 'conflict', message: '原件已有新版本。请重新查看后确认。' }
      : { kind: 'ok', ids: [root], commandTypes: [captureSourceCommand] };
  }
  if (!document || material.type !== materialType || document.type !== intakeFactType || intakeDocument(document.value).materialId !== root)
    throw new RequestError(404, '找不到这份交入原件。');
  return document.rev !== rev
    ? { kind: 'conflict', message: '材料已有新版本。请重新查看后确认。' }
    : { kind: 'ok', ids: [root, document.id], commandTypes: intakeEraseCommands };
}

export function extractPaperReturnOriginal(source: { readonly type: string; readonly value: unknown }, id: FactId) {
  if (source.type !== captureSourceType) return null;
  const envelope = sourceEnvelope(source.value);
  return (envelope.kind === 'paper-return' || envelope.workbookAttachment) && envelope.originals.length === 1 && envelope.originals[0]?.blobRef === id ? envelope.originals[0] : null;
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

export const isExpectedVisionCompletion = isExpectedCloudCompletion;

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

export function prepareIntakeVisionRetry(input: IntakeRetryVisionInput, intakeIdFor: (id: FactId) => FactId) {
  const requestId = clientRequest(input.requestId);
  try {
    const materialId = factId(input.materialId as string);
    const data = retryVisionIntakeInput({
      materialId,
      intakeId: intakeIdFor(materialId),
      expectedRev: input.expectedRev,
      ...(input.expectedMaterialRev === undefined ? {} : { expectedMaterialRev: input.expectedMaterialRev }),
      ...(input.pages === undefined ? {} : { pages: input.pages }),
    });
    return { materialId, requestId, data };
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : '视觉重识别请求无效。');
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
  return translateIntakeCommandError(error, isDenied, {
    conflict: err => err instanceof Error && err.message === '原文版本已经变更。' ? '这份文字已有新版本，请打开原文核对后再保存。' : null,
    revConflict: '这份文字已有新版本，请打开原文核对后再保存。',
    duplicateCommand: '同一个更正标识已经用于不同文字。',
  });
}

export function translateIntakeVisionRetryError(error: unknown, isDenied: boolean): unknown {
  return translateIntakeCommandError(error, isDenied, {
    conflict: err => err instanceof IntakeVisionRetryConflict ? err.message : null,
    revConflict: '原文版本已经变更，请刷新后再重试视觉识别。',
    duplicateCommand: '同一个重试标识已经用于不同请求。',
  });
}

export function translateIntakeResearchError(error: unknown, isDenied: boolean): unknown {
  return translateIntakeCommandError(error, isDenied, {
    conflict: err => err instanceof IntakeResearchConflict ? err.message : null,
  });
}

export type IntakeRoute =
  | { readonly kind: 'lifecycle' }
  | { readonly kind: 'options' }
  | { readonly kind: 'intake' }
  | { readonly kind: 'material-read'; readonly id: string }
  | { readonly kind: 'erasure'; readonly id: string }
  | { readonly kind: 'original'; readonly id: string }
  | { readonly kind: 'original-page'; readonly id: string; readonly page: number }
  | { readonly kind: 'append-pages'; readonly id: string }
  | { readonly kind: 'correction'; readonly id: string }
  | { readonly kind: 'research-permission'; readonly id: string }
  | { readonly kind: 'retry-vision'; readonly id: string }
  | { readonly kind: 'method-not-allowed'; readonly error: string };

const materialPathPattern = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(import|original|pages|correction|research-permission|retry-vision|erasure))?$/;
const materialPageOriginalPattern = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})\/pages\/([1-9]\d*)\/original$/;

const materialActions = {
  '': { method: 'GET', kind: 'material-read', denied: '这个材料入口只接受读取。' },
  import: { method: 'GET', kind: 'material-read', denied: '这份材料的元数据只接受读取。' },
  original: { method: 'GET', kind: 'original', denied: '原件只接受下载。' },
  pages: { method: 'POST', kind: 'append-pages', denied: '续拍加页只接受提交。' },
  correction: { method: 'POST', kind: 'correction', denied: '更正只接受提交。' },
  'research-permission': { method: 'PUT', kind: 'research-permission', denied: '这个入口只接受用途设置。' },
  'retry-vision': { method: 'POST', kind: 'retry-vision', denied: '视觉重识别只接受提交。' },
} as const;

export function parseIntakeRoute(pathname: string, method: string | undefined): IntakeRoute | null {
  if (pathname === '/api/lifecycle' && method === 'GET') return { kind: 'lifecycle' };
  if (pathname === '/api/intake/options' && method === 'GET') return { kind: 'options' };
  if (pathname === '/api/intake') return method === 'POST' ? { kind: 'intake' } : { kind: 'method-not-allowed', error: '这个入口只接受交入请求。' };
  const pageMatch = materialPageOriginalPattern.exec(pathname);
  if (pageMatch?.[1] && pageMatch[2]) {
    const page = Number(pageMatch[2]);
    if (!Number.isSafeInteger(page) || page < 1 || page > maxIntakePhotoPages) return null;
    return method === 'GET' ? { kind: 'original-page', id: pageMatch[1], page } : { kind: 'method-not-allowed', error: '分页原件只接受下载。' };
  }
  const match = materialPathPattern.exec(pathname);
  if (!match?.[1]) return null;
  const id = match[1], action = match[2] ?? '';
  if (action === 'erasure') return method === 'POST' ? { kind: 'erasure', id } : null;
  const entry = materialActions[action as keyof typeof materialActions];
  if (!entry) return null;
  return method === entry.method ? { kind: entry.kind, id } : { kind: 'method-not-allowed', error: entry.denied };
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
  readonly visionOcrEnabled?: () => boolean;
  readonly hasPapers: boolean;
  readonly lifecycleState: () => Promise<{ readonly watermark: string }>;
  readonly erase: (id: string, input: Record<string, unknown>) => Promise<unknown>;
  readonly metadata: (id: string) => Promise<unknown>;
  readonly original: (id: string) => Promise<{ readonly metadata: Pick<IntakeMetadata, 'original'>; readonly bytes: Bytes }>;
  readonly originalPage?: (id: string, page: number) => Promise<{ readonly original: Pick<IntakeOriginal, 'name' | 'mediaType'>; readonly bytes: Bytes }>;
  readonly capture: (input: Omit<IntakeCaptureInput, 'bytes'> & { readonly bytes: Bytes }) => Promise<unknown>;
  readonly capturePages?: (input: IntakeMultiPageCaptureInput<Bytes>) => Promise<unknown>;
  readonly appendPages?: (input: IntakeAppendPagesInput<Bytes>) => Promise<unknown>;
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
  readonly retryVision?: (input: IntakeRetryVisionInput) => Promise<unknown>;
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
  if (route.kind === 'options') {
    const vision = adapter.visionOcrEnabled?.();
    return {
      kind: 'json', status: 200,
      body: vision === undefined ? { mineru: adapter.mineruEnabled() }
        : { mineru: adapter.mineruEnabled(), visionOcr: vision },
    };
  }
  const rawContentType = typeof adapter.headers['content-type'] === 'string' ? adapter.headers['content-type'] : '';
  const mediaType = rawContentType.split(';')[0]?.toLowerCase() ?? '';
  const readMultipart = async (limit: number, invalidMessage: string) => {
    const bytes = await adapter.readBody(limit);
    try { return await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': rawContentType } }).formData(); }
    catch { throw new RequestError(400, invalidMessage); }
  };
  const readPages = (files: readonly File[]) => Promise.all(files.map(async file => ({
    filename: file.name, declaredType: file.type, bytes: adapter.fromArrayBuffer(await file.arrayBuffer()),
  })));
  const readJson = async (limit: number, requireObject?: string): Promise<Record<string, unknown>> => {
    const value: unknown = JSON.parse(adapter.decodeUtf8Bytes(await adapter.readBody(limit)));
    if (requireObject && (!value || typeof value !== 'object' || Array.isArray(value))) throw new RequestError(400, requireObject);
    return value as Record<string, unknown>;
  };
  const sendOriginal = async (
    load: () => Promise<{ readonly original: Pick<IntakeMetadata['original'], 'name' | 'mediaType'>; readonly bytes: Bytes }>,
    fallback: string,
  ): Promise<IntakeHttpResult<Bytes>> => {
    try {
      const { original, bytes } = await load();
      return { kind: 'bytes', status: 200, headers: originalDownloadHeaders(original, bytes.length), bytes };
    } catch (error) {
      return fail(error, fallback);
    }
  };
  if (route.kind === 'intake') {
    try {
      let result: unknown;
      let watermark: string;
      if (mediaType === 'multipart/form-data') {
        const allowMultiPage = Boolean(adapter.capturePages);
        const form = await readMultipart((allowMultiPage ? intakeMultiPageBodyLimit : intakeFileLimit) + 512 * 1024, '文件表单无法读取。');
        const parsed = parseMultipartIntakeForm(form, adapter.hasPapers, adapter.parseWatermark, { allowMultiple: allowMultiPage });
        watermark = parsed.watermark;
        if (parsed.kind === 'capture-pages') {
          if (!adapter.capturePages) throw new RequestError(400, '当前宿主尚未启用多页合并拍卷。');
          result = await adapter.capturePages({ ...parsed.fields, pages: await readPages(parsed.files) });
        } else {
          const upload = { ...parsed.fields, bytes: adapter.fromArrayBuffer(await parsed.file.arrayBuffer()) };
          result = parsed.kind === 'paper-return'
            ? await adapter.paperReturn({ ...upload, ...parsed.paperFields })
            : await adapter.capture(upload);
        }
      } else {
        const requestId = requireHeaderRequestId(adapter.headers);
        const bytes = await adapter.readBody(intakeFileLimit);
        const parsed = buildHeaderIntakeInput(adapter.headers, requestId, mediaType, adapter.parseWatermark);
        watermark = parsed.watermark;
        result = await adapter.capture({ ...parsed.fields, bytes });
      }
      const asyncReceipt = typeof result === 'object' && result !== null &&
        (result as { requestedExtraction?: unknown }).requestedExtraction === 'vision_llm' &&
        (result as { extraction?: { status?: unknown } }).extraction?.status === 'pending';
      return { kind: 'json', status: asyncReceipt ? 202 : 201, headers: { 'X-Deletion-Watermark': watermark }, body: result };
    } catch (error) {
      return fail(error, '交入未能完成。', { includeCode: true });
    }
  }
  if (route.kind === 'material-read') {
    try { return { kind: 'json', status: 200, body: await adapter.metadata(route.id) }; }
    catch (error) { return fail(error, '这份材料的交入记录无法读取。'); }
  }
  if (route.kind === 'erasure') {
    if (rawContentType.split(';')[0] !== 'application/json') return { kind: 'json', status: 415, body: { error: '需要 JSON 请求。' } };
    try { return { kind: 'json', status: 200, body: await adapter.erase(route.id, await readJson(4096, '删除请求格式无效。')) }; }
    catch (error) { return fail(error, '删除未能完成。', { notFoundAs404: true }); }
  }
  if (route.kind === 'original') {
    return sendOriginal(async () => {
      const { metadata, bytes } = await adapter.original(route.id);
      return { original: metadata.original, bytes };
    }, '原件未能读取。');
  }
  if (route.kind === 'original-page') {
    if (adapter.originalPage) return sendOriginal(() => adapter.originalPage!(route.id, route.page), '分页原件未能读取。');
    if (route.page !== 1) return { kind: 'json', status: 404, body: { error: '找不到该页原件。' } };
    return sendOriginal(async () => {
      const { metadata, bytes } = await adapter.original(route.id);
      return { original: metadata.original, bytes };
    }, '原件未能读取。');
  }
  if (route.kind === 'append-pages') {
    if (!adapter.appendPages) return { kind: 'json', status: 404, body: { error: '找不到这份原件。' } };
    if (mediaType !== 'multipart/form-data') return { kind: 'json', status: 415, body: { error: '续拍加页需要 multipart/form-data 表单。' } };
    try {
      const parsed = parseMultipartAppendPagesForm(await readMultipart(intakeMultiPageBodyLimit + 512 * 1024, '续拍表单无法读取。'));
      const result = await adapter.appendPages({
        materialId: route.id, requestId: parsed.requestId, expectedRev: parsed.expectedRev,
        ...(parsed.expectedMaterialRev === undefined ? {} : { expectedMaterialRev: parsed.expectedMaterialRev }),
        pages: await readPages(parsed.files),
      });
      return { kind: 'json', status: 202, body: result };
    } catch (error) {
      return fail(error, '续拍加页未能完成。');
    }
  }
  if (route.kind === 'correction') {
    try {
      const value = await readJson(intakeTextLimit * 4 + 4096);
      return { kind: 'json', status: 200, body: await adapter.correct({ materialId: route.id, requestId: value.requestId, expectedRev: value.expectedRev, text: value.text }) };
    } catch (error) {
      return fail(error, '更正未能保存。', { syntaxMessage: '更正请求格式无效。' });
    }
  }
  if (route.kind === 'retry-vision') {
    if (!adapter.retryVision) return { kind: 'json', status: 404, body: { error: '找不到这份原件。' } };
    try {
      const body = await readJson(4096, '视觉重识别请求格式无效。');
      const result = await adapter.retryVision({
        materialId: route.id, requestId: body.requestId, expectedRev: body.expectedRev,
        ...(body.expectedMaterialRev === undefined ? {} : { expectedMaterialRev: body.expectedMaterialRev }),
        ...(body.pages === undefined ? {} : { pages: body.pages }),
      });
      return { kind: 'json', status: 202, body: result };
    } catch (error) {
      return fail(error, '视觉重识别未能排队。', { syntaxMessage: '视觉重识别请求格式无效。' });
    }
  }
  try {
    return { kind: 'json', status: 200, body: await adapter.setResearch(route.id, await readJson(4096)) };
  } catch (error) {
    return fail(error, '原件用途未能更新。', { syntaxMessage: '用途请求格式无效。' });
  }
}
