import { factId, type FactId } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import { sourceEnvelope, type SourceEnvelope } from './source.ts';
import {
  renderStructuredPaperMarkdown,
  structuredPaperToDrafts,
  validateStructuredPaperDrafts,
  visionOcrSupports,
  visionPaperDraftsVersion,
  type StructuredPaperDraftQuestion,
  type StructuredPaperDrafts,
  type StructuredPaperOcr,
} from './vision-paper-ocr.ts';

export { completeVisionIntakeCommand } from './vision-paper-ocr.ts';

export const intakePurpose = 'storage';
export const intakeResearchPurpose = 'background-research';
export const materialType = materialFact.type;
export const captureMaterial = 'activity.captureTextMaterial';
export const intakeFactType = 'activity.intakeDocument';
export const captureIntakeCommand = 'activity.captureIntake';
export const correctIntakeCommand = 'activity.correctIntakeText';
export const setIntakeResearchCommand = 'capture.setIntakeResearch';
export const completeCloudIntakeCommand = 'activity.completeCloudIntake';
export const retryVisionIntakeCommand = 'activity.retryVisionIntake';
export const appendIntakePagesCommand = 'activity.appendIntakePages';

export const materialTextLimit = 4000;
export const intakeTextLimit = 2_000_000;
export const intakeFileLimit = 25 * 1024 * 1024;
export const maxIntakePhotoPages = 6;
export const intakeMultiPageBodyLimit = 60 * 1024 * 1024;

export class IntakeResearchConflict extends Error {}
export class IntakeVisionRetryConflict extends Error {}
export class IntakeAppendPagesConflict extends Error {}

export function intakeResearchPermission(input: unknown) {
  const { materialId, intakeId, expectedRev, enabled } = object(input);
  if (typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) || expectedRev < 1 || typeof enabled !== 'boolean')
    throw new Error('原件版本或后台用途无效。');
  return { materialId: factId(String(materialId)), intakeId: factId(String(intakeId)), expectedRev, enabled };
}

export const intakeMediaTypes = [
  'application/pdf',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'text/markdown',
  'text/plain',
] as const;

export type IntakeMediaType = (typeof intakeMediaTypes)[number];

export const intakeFailureText =
  '这份原件已保存，但未能自动抽取文字。请打开材料详情下载原件，或在这里手动补充文字。';

const intakePendingText = '原件已保存，正在由 MinerU 云识别。';
const intakeVisionPendingText = '原件已保存，正在由视觉模型识别公式与手写内容。';

export type IntakeExtractionStatus = 'ok' | 'partial' | 'failed' | 'corrected' | 'pending';
export type IntakeExtractionMethod = 'pdfkit' | 'vision' | 'pdfkit+vision' | 'utf8' | 'learner' | 'mineru' | 'vision_llm' | 'vision_fallback';
export type IntakeRequestedExtraction = 'mineru' | 'vision_llm';
export type IntakeExtractionStage = 'queued' | 'extracting' | 'ready' | 'fallback' | 'failed';

export type IntakeOriginal = {
  readonly name: string;
  readonly mediaType: IntakeMediaType;
  readonly size: number;
  readonly sha256: string;
};

export type IntakePageOriginal = IntakeOriginal & {
  readonly page: number;
};

export type IntakePageExtractionStatus = 'pending' | 'ready' | 'fallback' | 'failed';

export type IntakePageExtraction = {
  readonly page: number;
  readonly status: IntakePageExtractionStatus;
  readonly method: 'vision_llm' | 'vision_fallback';
  readonly text: string;
  readonly error: string | null;
  readonly warnings: readonly string[];
  readonly questionCount: number;
  readonly paperTitle?: string | null;
  readonly subject?: string | null;
};

export type IntakeExtraction = {
  readonly status: IntakeExtractionStatus;
  readonly method: IntakeExtractionMethod;
  readonly text: string;
  readonly error: string | null;
  readonly warnings: readonly string[];
  readonly pages: number | null;
  readonly truncated: boolean;
  readonly characterCount: number;
  readonly stage?: IntakeExtractionStage;
  readonly drafts?: StructuredPaperDrafts;
  readonly pageExtractions?: readonly IntakePageExtraction[];
};

export type IntakeDocument = {
  readonly materialId: FactId;
  readonly title: string;
  readonly original: IntakeOriginal;
  readonly originals?: readonly IntakePageOriginal[];
  readonly extraction: IntakeExtraction;
  readonly requestedExtraction?: IntakeRequestedExtraction;
};

export function intakeDocumentPages(document: IntakeDocument): readonly IntakePageOriginal[] {
  return document.originals && document.originals.length > 0
    ? document.originals
    : [{ ...document.original, page: 1 }];
}

export function retryableVisionPages(document: IntakeDocument): readonly number[] {
  const { extraction } = document;
  if (!visionOcrSupports(document.original.mediaType)) return [];
  if (extraction.status === 'corrected' || extraction.method === 'learner') return [];
  if (extraction.status === 'pending') return [];
  if (extraction.pageExtractions && extraction.pageExtractions.length > 0) {
    return extraction.pageExtractions
      .filter(item => item.status === 'fallback' || item.status === 'failed')
      .map(item => item.page);
  }
  if (extraction.method === 'vision_fallback' || extraction.stage === 'fallback' || extraction.status === 'failed') {
    return intakeDocumentPages(document).map(item => item.page);
  }
  return [];
}

export function canRetryVisionExtraction(document: IntakeDocument): boolean {
  return retryableVisionPages(document).length > 0;
}

export function archivedIntake(input: unknown): IntakeDocument & { readonly envelope: SourceEnvelope } {
  const document = intakeDocument(input);
  const { original, materialId, extraction, title } = document;
  const kind = original.mediaType.startsWith('image/') ? 'photo'
    : original.mediaType === 'application/pdf' ? 'pdf' : 'text';
  const pages = intakeDocumentPages(document);
  return {
    ...document,
    envelope: sourceEnvelope({
      kind, occurredAt: null, recordedAt: null, retentionPolicy: 'retained',
      originals: pages.map(({ page, ...meta }) => ({
        ...meta,
        blobRef: page === 1 ? `intake:${materialId}` : `intake:${materialId}:page:${page}`,
      })),
      unit: {
        kind: 'capture',
        title,
        blocks: kind === 'text' && extraction.text ? [{
          id: 'text', parentId: null, body: {
            kind: 'capture', layer: 'source', status: 'known', text: extraction.text,
            ...(extraction.status === 'corrected' ? { author: 'learner', sticky: true } : {}),
          },
        }] : [],
      },
    }),
  };
}

export type CaptureIntakeInput = {
  readonly materialId: FactId;
  readonly intakeId: FactId;
  readonly data: {
    readonly material: { readonly title: string; readonly text: string };
    readonly document: IntakeDocument;
  };
};

export type CorrectIntakeInput = {
  readonly expectedRev: number;
  readonly materialId: FactId;
  readonly intakeId: FactId;
  readonly text: string;
};

export type RetryVisionIntakeInput = {
  readonly materialId: FactId;
  readonly intakeId: FactId;
  readonly expectedRev: number;
  readonly expectedMaterialRev?: number;
  readonly pages?: readonly number[];
};

export type AppendIntakePagesInput = {
  readonly materialId: FactId;
  readonly intakeId: FactId;
  readonly expectedRev: number;
  readonly expectedMaterialRev?: number;
  readonly pages: readonly IntakeOriginal[];
};

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('交入记录格式无效。');
  }
  return input as Record<string, unknown>;
}

function text(input: unknown, label: string, limit = 1_000, allowEmpty = false): string {
  if (typeof input !== 'string') throw new Error(`${label}必须是文本。`);
  if (!input.isWellFormed() || input.includes('\u0000')) throw new Error(`${label}包含无效字符。`);
  if (!allowEmpty && !input.trim()) throw new Error(`${label}不能为空。`);
  if (input.length > limit) throw new Error(`${label}超过 ${limit} 字。`);
  return input;
}

function hex(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) {
    throw new Error('原件摘要必须是 64 位小写十六进制数。');
  }
  return input;
}

function mediaType(input: unknown): IntakeMediaType {
  if (typeof input !== 'string' || !(intakeMediaTypes as readonly string[]).includes(input)) {
    throw new Error('原件类型不受支持。');
  }
  return input as IntakeMediaType;
}

export function intakeFilename(value: unknown) {
  let name = typeof value === 'string' ? value : '';
  name = name.replace(/\\/g, '/').split('/').at(-1) ?? '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 180).toWellFormed();
}

export function intakeTitle(value: unknown, fallback: string) {
  let title = typeof value === 'string' ? value.trim() : '';
  title = title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
  if (!title || !title.isWellFormed() || title.includes('\u0000')) title = fallback;
  title = title.slice(0, 240).toWellFormed();
  return title || '未命名材料';
}

function originalName(input: unknown): string {
  const name = text(input, '原件名称', 180, true);
  if (!name.trim() || /[\u0000-\u001f\u007f/\\:*?"<>|]/.test(name)) {
    throw new Error('原件名称包含无效字符。');
  }
  return name.trim();
}

function size(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > intakeFileLimit) {
    throw new Error('原件大小无效。');
  }
  return input;
}

export function intakeOriginal(input: unknown): IntakeOriginal {
  const value = object(input);
  return {
    name: originalName(value.name),
    mediaType: mediaType(value.mediaType),
    size: size(value.size),
    sha256: hex(value.sha256),
  };
}

export function intakePageOriginal(input: unknown): IntakePageOriginal {
  const value = object(input);
  const page = value.page;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > maxIntakePhotoPages) {
    throw new Error('多页原件页码无效。');
  }
  return { ...intakeOriginal(value), page };
}

function intakePageExtraction(input: unknown): IntakePageExtraction {
  const value = object(input);
  const page = value.page;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > maxIntakePhotoPages) {
    throw new Error('分页识别页码无效。');
  }
  const status = value.status;
  if (status !== 'pending' && status !== 'ready' && status !== 'fallback' && status !== 'failed') {
    throw new Error('分页识别状态无效。');
  }
  const method = value.method;
  if (method !== 'vision_llm' && method !== 'vision_fallback') {
    throw new Error('分页识别方式无效。');
  }
  const awaitingText = status === 'pending' || status === 'failed';
  const pageText = text(value.text, '分页识别文字', intakeTextLimit, awaitingText);
  if (awaitingText && pageText.length !== 0) throw new Error('未完成或失败页面不能保存正文。');
  if (!awaitingText && !pageText.trim()) throw new Error('识别成功的页面必须包含文字。');
  const error = value.error === null ? null : text(value.error, '分页识别错误', 1_000, true);
  if (status === 'failed' && (error === null || !error.trim())) throw new Error('失败页面必须说明原因。');
  if (status !== 'failed' && error !== null) throw new Error('非失败页面不能附带错误。');
  const warnings = value.warnings;
  if (!Array.isArray(warnings) || warnings.length > 8) throw new Error('分页识别提示无效。');
  const warningTexts = warnings.map(item => text(item, '分页识别提示', 500, true));
  const questionCount = value.questionCount;
  if (typeof questionCount !== 'number' || !Number.isSafeInteger(questionCount) || questionCount < 0 || questionCount > 120) {
    throw new Error('分页题目数量无效。');
  }
  const paperTitle = value.paperTitle === undefined ? undefined
    : value.paperTitle === null ? null : text(value.paperTitle, '分页标题', 240, true);
  const subject = value.subject === undefined ? undefined
    : value.subject === null ? null : text(value.subject, '分页科目', 40, true);
  return {
    page,
    status,
    method,
    text: pageText,
    error,
    warnings: warningTexts,
    questionCount,
    ...(paperTitle !== undefined ? { paperTitle } : {}),
    ...(subject !== undefined ? { subject } : {}),
  };
}

function validatePageExtractions(input: unknown, status: IntakeExtractionStatus, pages: number | null): readonly IntakePageExtraction[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length === 0 || input.length > maxIntakePhotoPages) {
    throw new Error('分页识别记录数量无效。');
  }
  const items = input.map(intakePageExtraction);
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.page !== index + 1) throw new Error('分页识别页码必须从 1 起连续递增。');
  }
  if (status === 'pending') {
    if (!items.some(item => item.status === 'pending')) throw new Error('待识别多页记录至少需要一个待识别页面。');
  } else {
    if (items.some(item => item.status === 'pending')) throw new Error('已完成记录不能包含待识别页面。');
    if (pages !== null && pages !== items.length) throw new Error('分页识别页数与总页数不匹配。');
  }
  return items;
}

export function pendingMineruExtraction(): IntakeExtraction {
  return {status:'pending', method:'mineru', text:'', error:null, warnings:[], pages:null, truncated:false, characterCount:0};
}

export function failedMineruExtraction(error: string): IntakeExtraction {
  const message = error.replaceAll(String.fromCharCode(0), '').trim().slice(0, 1_000).toWellFormed();
  return {
    status: 'failed', method: 'mineru', error: message || 'MinerU 识别失败。',
    text: '', characterCount: 0, pages: null, warnings: [], truncated: false,
  };
}

export function completeMineruExtraction(text: string, pages: number | null): IntakeExtraction {
  if (!text.trim() || !text.isWellFormed() || text.includes('\u0000'))
    return failedMineruExtraction('MinerU 没有返回可用正文。');
  const truncated = text.length > intakeTextLimit;
  const content = truncated ? text.slice(0, intakeTextLimit).toWellFormed() : text;
  if (!content.trim()) return failedMineruExtraction('MinerU 没有返回可用正文。');
  return {
    status: truncated ? 'partial' : 'ok', method: 'mineru', text: content,
    pages: pages !== null && Number.isSafeInteger(pages) && pages >= 0 && pages <= 1_000 ? pages : null, error: null,
    warnings: truncated ? ['识别正文超过保存上限，已保留前 200 万字。'] : [],
    truncated, characterCount: content.length,
  };
}

export function intakeExtraction(input: unknown): IntakeExtraction {
  const value = object(input);
  const status = value.status;
  const method = value.method;
  if (status !== 'ok' && status !== 'partial' && status !== 'failed' && status !== 'corrected' && status !== 'pending') {
    throw new Error('抽取状态无效。');
  }
  if (method !== 'pdfkit' && method !== 'vision' && method !== 'pdfkit+vision' &&
      method !== 'utf8' && method !== 'learner' && method !== 'mineru' &&
      method !== 'vision_llm' && method !== 'vision_fallback') {
    throw new Error('抽取方式无效。');
  }
  const warnings = value.warnings;
  if (!Array.isArray(warnings) || warnings.length > 8) throw new Error('抽取提示无效。');
  const warningTexts = warnings.map((item) => text(item, '抽取提示', 500, true));
  const awaitingText = status === 'failed' || status === 'pending';
  const textValue = text(value.text, '抽取文字', intakeTextLimit, awaitingText);
  if (awaitingText && textValue.length !== 0) throw new Error('尚无抽取结果时不能保存正文。');
  if (!awaitingText && !textValue.trim()) throw new Error('成功的抽取必须包含文字。');
  const pageNumber = value.pages;
  if (pageNumber !== null && (typeof pageNumber !== 'number' || !Number.isSafeInteger(pageNumber) || pageNumber < 0 || pageNumber > 1_000)) {
    throw new Error('页数无效。');
  }
  const error = value.error === null ? null : text(value.error, '抽取错误', 1_000, true);
  const stage = value.stage;
  if (stage !== undefined && stage !== 'queued' && stage !== 'extracting' && stage !== 'ready' &&
      stage !== 'fallback' && stage !== 'failed')
    throw new Error('抽取阶段无效。');
  const drafts = value.drafts === undefined ? undefined : validateStructuredPaperDrafts(value.drafts);
  const pageExtractions = validatePageExtractions(value.pageExtractions, status, pageNumber);
  if (status === 'pending' && ((method !== 'mineru' && method !== 'vision_llm') || pageNumber !== null || value.truncated !== false))
    throw new Error('待识别结果格式无效。');
  if (status === 'pending' && stage !== undefined && stage !== 'queued' && stage !== 'extracting')
    throw new Error('待识别结果阶段无效。');
  if (status === 'ok' || status === 'corrected' || status === 'pending') {
    if (error !== null) throw new Error('成功状态不能有抽取错误。');
  }
  if (status === 'failed' && (error === null || !error.trim())) throw new Error('失败状态必须说明原因。');
  if (status === 'partial' && error !== null) throw new Error('部分成功状态不能用错误掩盖。');
  if (value.truncated !== true && value.truncated !== false) throw new Error('抽取截断标记无效。');
  if (value.characterCount !== textValue.length) throw new Error('抽取字数与文字不匹配。');
  const allowsPendingPreservedDrafts = status === 'pending' && method === 'vision_llm' &&
    Boolean(pageExtractions?.some(item => item.status === 'ready'));
  if (drafts !== undefined) {
    if (!allowsPendingPreservedDrafts &&
        (status === 'pending' || status === 'failed' || status === 'corrected' ||
         (method !== 'vision_llm' && method !== 'vision_fallback'))) {
      throw new Error('切题草案只能附在成功的视觉识别结果上。');
    }
    if (allowsPendingPreservedDrafts && pageExtractions) {
      const readyPages = new Set(pageExtractions.filter(item => item.status === 'ready').map(item => item.page));
      if (drafts.questions.some(question => question.pageNumber === undefined || !readyPages.has(question.pageNumber))) {
        throw new Error('保留的切题草案只能归属已完成页面。');
      }
    }
  }
  return {
    status,
    method,
    text: textValue,
    error,
    warnings: warningTexts,
    pages: pageNumber,
    truncated: value.truncated as boolean,
    characterCount: textValue.length,
    ...(stage !== undefined ? { stage } : {}),
    ...(drafts !== undefined ? { drafts } : {}),
    ...(pageExtractions !== undefined ? { pageExtractions } : {}),
  };
}

export function intakeDocument(input: unknown): IntakeDocument {
  const value = object(input);
  if (value.requestedExtraction !== undefined && value.requestedExtraction !== 'mineru' &&
      value.requestedExtraction !== 'vision_llm')
    throw new Error('交入识别方式无效。');
  const extraction = intakeExtraction(value.extraction);
  if (extraction.method === 'mineru' && value.requestedExtraction !== 'mineru')
    throw new Error('云识别结果缺少对应的交入请求。');
  if ((extraction.method === 'vision_llm' || extraction.method === 'vision_fallback') &&
      value.requestedExtraction !== 'vision_llm')
    throw new Error('视觉识别结果缺少对应的交入请求。');
  const original = intakeOriginal(value.original);
  let originals: readonly IntakePageOriginal[] | undefined;
  if (value.originals !== undefined) {
    if (!Array.isArray(value.originals) || value.originals.length === 0 || value.originals.length > maxIntakePhotoPages) {
      throw new Error(`多页拍卷支持 1 到 ${maxIntakePhotoPages} 页照片。`);
    }
    originals = value.originals.map(intakePageOriginal);
    for (let index = 0; index < originals.length; index += 1) {
      const page = originals[index]!;
      if (page.page !== index + 1) throw new Error('多页原件页码必须从 1 起连续递增。');
      if (originals.length > 1 && !visionOcrSupports(page.mediaType)) {
        throw new Error('多页合并拍卷仅支持照片文件。');
      }
    }
    const first = originals[0]!;
    if (first.name !== original.name || first.mediaType !== original.mediaType ||
        first.size !== original.size || first.sha256 !== original.sha256) {
      throw new Error('多页原件首页必须与主原件信息一致。');
    }
    if (extraction.pageExtractions && extraction.pageExtractions.length !== originals.length) {
      throw new Error('分页识别页数与原件页数不匹配。');
    }
  } else if (extraction.pageExtractions && extraction.pageExtractions.length !== 1) {
    throw new Error('单页原件不能包含多页识别记录。');
  }
  const document: IntakeDocument = {
    materialId: factId(text(value.materialId, '材料标识', 26, false)),
    title: materialFact.schema.parse({ title: value.title, text: '占位' }).title,
    original,
    ...(originals !== undefined ? { originals } : {}),
    extraction,
    ...(value.requestedExtraction === 'mineru' || value.requestedExtraction === 'vision_llm'
      ? { requestedExtraction: value.requestedExtraction } : {}),
  };
  if (document.materialId.length !== 26) throw new Error('材料标识无效。');
  return document;
}

export function materialPreview(text: string): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= materialTextLimit) return { text, truncated: false };
  let prefixLength = materialTextLimit;
  while (prefixLength >= 0) {
    const suffix =
      `\n\n…（全文共 ${text.length} 字；材料卡片只显示前 ${prefixLength} 字，完整抽取与原件见材料详情。）`;
    if (prefixLength + suffix.length <= materialTextLimit && text.slice(0, prefixLength).isWellFormed()) {
      return { text: text.slice(0, prefixLength) + suffix, truncated: true };
    }
    prefixLength--;
  }
  return { text: text.slice(0, materialTextLimit).toWellFormed(), truncated: true };
}

export function intakePreview(extraction: IntakeExtraction): string {
  if (extraction.status === 'pending')
    return extraction.method === 'vision_llm' ? intakeVisionPendingText : intakePendingText;
  if (extraction.status === 'failed') return intakeFailureText;
  return materialPreview(extraction.text).text;
}

export function pendingVisionExtraction(
  stage: 'queued' | 'extracting' = 'queued',
  options?: {
    readonly pageCount?: number;
    readonly pageExtractions?: readonly IntakePageExtraction[];
    readonly preservedDrafts?: StructuredPaperDrafts;
  },
): IntakeExtraction {
  let pageExtractions = options?.pageExtractions;
  if (!pageExtractions && options?.pageCount !== undefined && options.pageCount > 1) {
    pageExtractions = Array.from({ length: options.pageCount }, (_, index) => ({
      page: index + 1,
      status: 'pending' as const,
      method: 'vision_llm' as const,
      text: '',
      error: null,
      warnings: [],
      questionCount: 0,
    }));
  }
  return {
    status: 'pending', method: 'vision_llm', text: '', error: null, warnings: [],
    pages: null, truncated: false, characterCount: 0, stage,
    ...(pageExtractions ? { pageExtractions } : {}),
    ...(options?.preservedDrafts ? { drafts: options.preservedDrafts } : {}),
  };
}

export function failedVisionExtraction(
  error: string,
  method: 'vision_llm' | 'vision_fallback' = 'vision_llm',
  pageCount?: number,
): IntakeExtraction {
  const message = error.replaceAll(String.fromCharCode(0), '').trim().slice(0, 1_000).toWellFormed();
  const safeError = message || '视觉识别失败。';
  const multiPage = pageCount !== undefined && Number.isSafeInteger(pageCount) && pageCount > 1 && pageCount <= maxIntakePhotoPages;
  return {
    status: 'failed', method, error: safeError,
    text: '', characterCount: 0, pages: multiPage ? pageCount : null, warnings: [], truncated: false, stage: 'failed',
    ...(multiPage ? {
      pageExtractions: Array.from({ length: pageCount }, (_, index) => ({
        page: index + 1,
        status: 'failed' as const,
        method,
        text: '',
        error: safeError,
        warnings: [],
        questionCount: 0,
      })),
    } : {}),
  };
}

export function completeVisionExtraction(ocr: StructuredPaperOcr, pages: number | null = null): IntakeExtraction {
  const rendered = renderStructuredPaperMarkdown(ocr);
  if (!rendered.trim() || !rendered.isWellFormed() || rendered.includes('\u0000')) {
    return failedVisionExtraction('视觉模型没有返回可用正文。');
  }
  const truncated = rendered.length > intakeTextLimit;
  const content = truncated ? rendered.slice(0, intakeTextLimit).toWellFormed() : rendered;
  if (!content.trim()) return failedVisionExtraction('视觉模型没有返回可用正文。');
  const warnings = [...ocr.warnings];
  if (truncated) warnings.unshift('识别正文超过保存上限，已保留前 200 万字。');
  return {
    status: truncated ? 'partial' : 'ok',
    method: 'vision_llm',
    text: content,
    pages: pages !== null && Number.isSafeInteger(pages) && pages >= 0 && pages <= 1_000 ? pages : null,
    error: null,
    warnings: warnings.slice(0, 8),
    truncated,
    characterCount: content.length,
    stage: 'ready',
    drafts: structuredPaperToDrafts(ocr),
  };
}

export function fallbackVisionExtraction(
  local: {
    readonly status: 'ok' | 'partial' | 'failed';
    readonly text: string;
    readonly error: string | null;
    readonly warnings: readonly string[];
    readonly pages: number | null;
    readonly truncated: boolean;
  },
  fallbackReason: string,
): IntakeExtraction {
  const reason = fallbackReason.replaceAll(String.fromCharCode(0), '').trim().slice(0, 500).toWellFormed();
  const notice = reason || '视觉识别不可用，已改用本地识别。';
  const cleanedLocalText = local.text.replaceAll(String.fromCharCode(0), '').toWellFormed();
  const truncatedByLimit = cleanedLocalText.length > intakeTextLimit;
  const safeLocalText = truncatedByLimit
    ? cleanedLocalText.slice(0, intakeTextLimit).toWellFormed()
    : cleanedLocalText;
  if (local.status === 'failed' || !safeLocalText.trim()) {
    const detail = local.error?.replaceAll(String.fromCharCode(0), '').trim().slice(0, 400).toWellFormed();
    const errorMessage = detail ? `${notice}；本地识别也失败：${detail}` : `${notice}，本地识别也没有可用结果。`;
    return {
      status: 'failed',
      method: 'vision_fallback',
      error: errorMessage.slice(0, 1_000).toWellFormed(),
      text: '',
      characterCount: 0,
      pages: null,
      warnings: [],
      truncated: false,
      stage: 'failed',
    };
  }
  const truncated = local.truncated || truncatedByLimit;
  const warnings = [
    notice,
    ...(truncatedByLimit ? ['本地回退识别正文超过保存上限，已保留前 200 万字。'] : []),
    ...local.warnings,
  ]
    .slice(0, 8)
    .map(item => item.replaceAll(String.fromCharCode(0), '').slice(0, 500).toWellFormed());
  return {
    status: truncated ? 'partial' : local.status,
    method: 'vision_fallback',
    text: safeLocalText,
    error: null,
    warnings,
    pages: local.pages,
    truncated,
    characterCount: safeLocalText.length,
    stage: 'fallback',
  };
}

export function captureIntakeInput(input: unknown): CaptureIntakeInput {
  const value = object(input);
  const materialId = factId(text(value.materialId, '材料标识', 26));
  const intakeId = factId(text(value.intakeId, '交入记录标识', 26));
  const document = intakeDocument({ ...value, materialId });
  const material = materialFact.schema.parse({
    title: document.title,
    text: intakePreview(document.extraction),
    ...(value.savedAt === undefined ? {} : { savedAt: value.savedAt }),
  });
  return { materialId, intakeId, data: { material, document } };
}

export function correctIntakeInput(input: unknown): CorrectIntakeInput {
  const value = object(input);
  const expectedRev = value.expectedRev;
  if (typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) || expectedRev < 1) throw new Error('缺少有效的原文版本。');
  return {
    expectedRev,
    materialId: factId(text(value.materialId, '材料标识', 26)),
    intakeId: factId(text(value.intakeId, '交入记录标识', 26)),
    text: text(value.text, '更正文字', intakeTextLimit),
  };
}

export type MultiPageVisionLocalInput = {
  readonly status: 'ok' | 'partial' | 'failed';
  readonly text: string;
  readonly error: string | null;
  readonly warnings: readonly string[];
  readonly pages: number | null;
  readonly truncated: boolean;
};

export type MultiPageVisionOutcomeInput =
  | { readonly page: number; readonly kind: 'vision_llm'; readonly ocr: StructuredPaperOcr }
  | { readonly page: number; readonly kind: 'vision_fallback'; readonly fallbackReason: string; readonly local: MultiPageVisionLocalInput }
  | { readonly page: number; readonly kind: 'preserved'; readonly extraction: IntakePageExtraction; readonly questions: readonly StructuredPaperDraftQuestion[] };

export type MultiPageVisionWorkPlan = {
  readonly totalPages: number;
  readonly pagesToRun: readonly IntakePageOriginal[];
  readonly preservedPages: readonly Extract<MultiPageVisionOutcomeInput, { readonly kind: 'preserved' }>[];
};

export function planMultiPageVisionWork(document: IntakeDocument): MultiPageVisionWorkPlan {
  const allPages = intakeDocumentPages(document);
  const existing = document.extraction.pageExtractions;
  if (!existing || existing.length !== allPages.length) {
    return { totalPages: allPages.length, pagesToRun: allPages, preservedPages: [] };
  }
  const byPage = new Map(existing.map(item => [item.page, item]));
  const pagesToRun: IntakePageOriginal[] = [];
  const preservedPages: Extract<MultiPageVisionOutcomeInput, { readonly kind: 'preserved' }>[] = [];
  const draftQuestions = document.extraction.drafts?.questions ?? [];
  for (const page of allPages) {
    const state = byPage.get(page.page);
    if (!state || state.status === 'pending') {
      pagesToRun.push(page);
      continue;
    }
    preservedPages.push({
      page: page.page,
      kind: 'preserved',
      extraction: state,
      questions: draftQuestions.filter(question => question.pageNumber === page.page),
    });
  }
  return { totalPages: allPages.length, pagesToRun, preservedPages };
}

function stripLeadingMarkdownTitle(markdown: string): string {
  return markdown.replace(/^#\s+[^\n]*\n+(?:>\s+[^\n]*\n+)?/, '').trim();
}

function uniqueDraftId(base: string, seen: Set<string>): string {
  const cleaned = base.replaceAll(String.fromCharCode(0), '').trim().slice(0, 80).toWellFormed();
  const seed = cleaned || 'draft-q';
  if (!seen.has(seed)) {
    seen.add(seed);
    return seed;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tag = `-${suffix}`;
    const candidate = `${seed.slice(0, 80 - tag.length).toWellFormed()}${tag}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }
}

export function completeMultiPageVisionExtraction(
  outcomes: readonly MultiPageVisionOutcomeInput[],
  options?: { readonly titleHint?: string },
): IntakeExtraction {
  if (outcomes.length === 0 || outcomes.length > maxIntakePhotoPages) {
    throw new Error(`多页识别结果页数必须在 1 到 ${maxIntakePhotoPages} 之间。`);
  }
  const sorted = [...outcomes].sort((left, right) => left.page - right.page);
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index]!.page !== index + 1) throw new Error('多页识别结果页码必须从 1 起连续递增。');
  }
  const safeTitleHint = typeof options?.titleHint === 'string'
    ? options.titleHint.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240).toWellFormed()
    : '';
  if (sorted.length === 1) {
    const single = sorted[0]!;
    if (single.kind === 'vision_llm') return completeVisionExtraction(single.ocr, 1);
    if (single.kind === 'vision_fallback') return fallbackVisionExtraction(single.local, single.fallbackReason);
    if (single.extraction.status === 'pending') throw new Error('已完成合并不能包含待识别页面。');
    if (single.extraction.status === 'failed') {
      return failedVisionExtraction(single.extraction.error ?? '视觉识别失败。', single.extraction.method);
    }
    const safeSingleText = single.extraction.text.replaceAll(String.fromCharCode(0), '').toWellFormed();
    if (!safeSingleText.trim()) {
      return failedVisionExtraction('保留页面缺少可用正文。', single.extraction.method);
    }
    return {
      status: single.extraction.status === 'fallback' ? 'partial' : 'ok',
      method: single.extraction.method,
      text: safeSingleText,
      error: null,
      warnings: single.extraction.warnings,
      pages: 1,
      truncated: false,
      characterCount: safeSingleText.length,
      stage: single.extraction.status === 'fallback' ? 'fallback' : 'ready',
      ...(single.questions.length > 0 ? {
        drafts: validateStructuredPaperDrafts({
          version: visionPaperDraftsVersion,
          confirmationRequired: true,
          paperTitle: single.extraction.paperTitle ?? (safeTitleHint || null),
          subject: single.extraction.subject ?? null,
          questions: single.questions.map((question, index) => ({ ...question, index: index + 1 })),
          pendingConfirmationCount: single.questions.length,
        }),
      } : {}),
    };
  }

  const totalPages = sorted.length;
  const pageExtractions: IntakePageExtraction[] = [];
  const mergedQuestions: StructuredPaperDraftQuestion[] = [];
  const seenDraftIds = new Set<string>();
  const collectedWarnings: string[] = [];
  const fallbackPages: number[] = [];
  const failedPages: number[] = [];
  let readyPages = 0;
  let truncatedQuestions = false;
  let paperTitle: string | null = null;
  let subject: string | null = null;

  for (const item of sorted) {
    if (item.kind === 'vision_llm') {
      const rendered = renderStructuredPaperMarkdown(item.ocr);
      const validBody = rendered.trim() && rendered.isWellFormed() && !rendered.includes('\u0000');
      if (!validBody) {
        failedPages.push(item.page);
        pageExtractions.push({
          page: item.page, status: 'failed', method: 'vision_llm',
          text: '', error: '视觉模型没有返回可用正文。', warnings: [], questionCount: 0,
        });
        continue;
      }
      readyPages += 1;
      if (!paperTitle && item.ocr.paperTitle) paperTitle = item.ocr.paperTitle;
      if (!subject && item.ocr.subject) subject = item.ocr.subject;
      const pageDrafts = structuredPaperToDrafts(item.ocr, { pageNumber: item.page });
      for (const question of pageDrafts.questions) {
        if (mergedQuestions.length >= 120) {
          truncatedQuestions = true;
          break;
        }
        const draftId = uniqueDraftId(question.draftId, seenDraftIds);
        mergedQuestions.push({
          ...question,
          draftId,
          index: mergedQuestions.length + 1,
          pageNumber: item.page,
        });
      }
      for (const warning of item.ocr.warnings) {
        collectedWarnings.push(`第 ${item.page} 页：${warning}`);
      }
      pageExtractions.push({
        page: item.page,
        status: 'ready',
        method: 'vision_llm',
        text: rendered.length > intakeTextLimit ? rendered.slice(0, intakeTextLimit).toWellFormed() : rendered,
        error: null,
        warnings: item.ocr.warnings.slice(0, 8),
        questionCount: item.ocr.questions.length,
        ...(item.ocr.paperTitle !== null ? { paperTitle: item.ocr.paperTitle } : {}),
        ...(item.ocr.subject !== null ? { subject: item.ocr.subject } : {}),
      });
    } else if (item.kind === 'preserved') {
      const preserved = item.extraction;
      if (preserved.status === 'pending') {
        throw new Error('已完成合并不能包含待识别页面。');
      }
      if (preserved.status === 'ready') {
        readyPages += 1;
        if (!paperTitle && preserved.paperTitle) paperTitle = preserved.paperTitle;
        if (!subject && preserved.subject) subject = preserved.subject;
        for (const question of item.questions) {
          if (mergedQuestions.length >= 120) {
            truncatedQuestions = true;
            break;
          }
          const draftId = uniqueDraftId(question.draftId, seenDraftIds);
          mergedQuestions.push({
            ...question,
            draftId,
            index: mergedQuestions.length + 1,
            pageNumber: item.page,
          });
        }
      } else if (preserved.status === 'fallback') {
        fallbackPages.push(item.page);
      } else {
        failedPages.push(item.page);
      }
      pageExtractions.push(preserved);
    } else {
      const fb = fallbackVisionExtraction(item.local, item.fallbackReason);
      if (fb.status === 'failed') {
        failedPages.push(item.page);
        pageExtractions.push({
          page: item.page, status: 'failed', method: 'vision_fallback',
          text: '', error: fb.error ?? '视觉与本地识别均失败。', warnings: [], questionCount: 0,
        });
      } else {
        fallbackPages.push(item.page);
        pageExtractions.push({
          page: item.page, status: 'fallback', method: 'vision_fallback',
          text: fb.text, error: null, warnings: fb.warnings, questionCount: 0,
        });
      }
    }
  }

  if (readyPages === 0 && fallbackPages.length === 0) {
    return {
      status: 'failed',
      method: 'vision_fallback',
      text: '',
      error: `全部 ${totalPages} 页视觉识别失败，请点击重试视觉识别。`,
      warnings: [],
      pages: totalPages,
      truncated: false,
      characterCount: 0,
      stage: 'failed',
      pageExtractions,
    };
  }

  const resolvedTitle = intakeTitle(paperTitle ?? safeTitleHint, '多页拍照试卷');
  const lines: string[] = [`# ${resolvedTitle}`, ''];
  const metaParts = [`共 ${totalPages} 页`];
  if (subject) metaParts.push(`科目：${subject}`);
  lines.push(`> ${metaParts.join('　')}`, '');
  for (const page of pageExtractions) {
    lines.push(`## 第 ${page.page} 页`, '');
    if (page.status === 'ready') {
      const body = stripLeadingMarkdownTitle(page.text);
      lines.push(body || page.text.trim(), '');
    } else if (page.status === 'fallback') {
      lines.push(`> 第 ${page.page} 页视觉识别回退本地识别，建议对该页点击重试视觉识别。`, '');
      lines.push(page.text.trim(), '');
    } else {
      lines.push(`> 第 ${page.page} 页识别失败：${page.error ?? '请重试视觉识别。'}`, '');
    }
  }
  const rawMerged = (lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
    .replaceAll(String.fromCharCode(0), '')
    .toWellFormed();
  const truncated = rawMerged.length > intakeTextLimit;
  const content = truncated ? rawMerged.slice(0, intakeTextLimit).toWellFormed() : rawMerged;

  const warnings: string[] = [];
  if (truncated) warnings.push('合并识别正文超过保存上限，已保留前 200 万字。');
  if (truncatedQuestions) warnings.push('多页合并题目超过 120 题上限，已保留前 120 道切题草案，其余题目请查看全文正文。');
  if (fallbackPages.length > 0 || failedPages.length > 0) {
    const affected = [...fallbackPages, ...failedPages].sort((a, b) => a - b);
    const label = affected.map(page => `第 ${page} 页`).join('、');
    warnings.push(
      readyPages > 0
        ? `${label}视觉识别回退或失败，已保留其余 ${readyPages} 页清晰结果；可仅针对失败页重试视觉识别。`
        : `${label}已回退本地识别或失败，建议点击重试视觉识别。`,
    );
  }
  for (const warning of collectedWarnings) {
    if (warnings.length >= 8) break;
    warnings.push(warning.replaceAll(String.fromCharCode(0), '').slice(0, 500).toWellFormed());
  }

  const hasRetryable = fallbackPages.length > 0 || failedPages.length > 0;
  const drafts = readyPages > 0
    ? validateStructuredPaperDrafts({
        version: visionPaperDraftsVersion,
        confirmationRequired: true,
        paperTitle: paperTitle ?? (safeTitleHint || null),
        subject,
        questions: mergedQuestions,
        pendingConfirmationCount: mergedQuestions.length > 0 ? mergedQuestions.length : 1,
      })
    : undefined;

  return {
    status: truncated || hasRetryable ? 'partial' : 'ok',
    method: readyPages > 0 ? 'vision_llm' : 'vision_fallback',
    text: content,
    error: null,
    warnings: warnings.slice(0, 8),
    pages: totalPages,
    truncated,
    characterCount: content.length,
    stage: hasRetryable ? 'fallback' : 'ready',
    ...(drafts ? { drafts } : {}),
    pageExtractions,
  };
}

export function retryVisionIntakeInput(input: unknown): RetryVisionIntakeInput {
  const value = object(input);
  const expectedRev = value.expectedRev;
  const expectedMaterialRev = value.expectedMaterialRev;
  if (typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) || expectedRev < 1)
    throw new Error('缺少有效的原文版本。');
  if (expectedMaterialRev !== undefined && (typeof expectedMaterialRev !== 'number' ||
      !Number.isSafeInteger(expectedMaterialRev) || expectedMaterialRev < 1))
    throw new Error('缺少有效的材料版本。');
  let pages: number[] | undefined;
  if (value.pages !== undefined) {
    if (!Array.isArray(value.pages) || value.pages.length === 0 || value.pages.length > maxIntakePhotoPages) {
      throw new Error('指定重试页码无效。');
    }
    const seen = new Set<number>();
    pages = [];
    for (const raw of value.pages) {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > maxIntakePhotoPages || seen.has(raw)) {
        throw new Error('指定重试页码无效或重复。');
      }
      seen.add(raw);
      pages.push(raw);
    }
    pages.sort((left, right) => left - right);
  }
  return {
    materialId: factId(text(value.materialId, '材料标识', 26)),
    intakeId: factId(text(value.intakeId, '交入记录标识', 26)),
    expectedRev,
    ...(expectedMaterialRev === undefined ? {} : { expectedMaterialRev }),
    ...(pages === undefined ? {} : { pages }),
  };
}

export function appendIntakePagesInput(input: unknown): AppendIntakePagesInput {
  const value = object(input);
  const expectedRev = value.expectedRev;
  const expectedMaterialRev = value.expectedMaterialRev;
  if (typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) || expectedRev < 1) {
    throw new Error('缺少有效的原文版本。');
  }
  if (expectedMaterialRev !== undefined && (typeof expectedMaterialRev !== 'number' ||
      !Number.isSafeInteger(expectedMaterialRev) || expectedMaterialRev < 1)) {
    throw new Error('缺少有效的材料版本。');
  }
  if (!Array.isArray(value.pages) || value.pages.length === 0 || value.pages.length >= maxIntakePhotoPages) {
    throw new Error(`单次续拍可追加 1 到 ${maxIntakePhotoPages - 1} 页照片。`);
  }
  const pages = value.pages.map(intakeOriginal);
  if (pages.some(page => !visionOcrSupports(page.mediaType))) {
    throw new Error('续拍加页仅支持照片文件。');
  }
  return {
    materialId: factId(text(value.materialId, '材料标识', 26)),
    intakeId: factId(text(value.intakeId, '交入记录标识', 26)),
    expectedRev,
    ...(expectedMaterialRev === undefined ? {} : { expectedMaterialRev }),
    pages,
  };
}

export const captureIntakeSchema = { parse: captureIntakeInput };
export const correctIntakeSchema = { parse: correctIntakeInput };
export const retryVisionIntakeSchema = { parse: retryVisionIntakeInput };
export const appendIntakePagesSchema = { parse: appendIntakePagesInput };
