import { factId, type FactId } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import { sourceEnvelope, type SourceEnvelope } from './source.ts';
import {
  renderStructuredPaperMarkdown,
  structuredPaperToDrafts,
  validateStructuredPaperDrafts,
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

export const materialTextLimit = 4000;
export const intakeTextLimit = 2_000_000;
export const intakeFileLimit = 25 * 1024 * 1024;

export class IntakeResearchConflict extends Error {}

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
};

export type IntakeDocument = {
  readonly materialId: FactId;
  readonly title: string;
  readonly original: IntakeOriginal;
  readonly extraction: IntakeExtraction;
  readonly requestedExtraction?: IntakeRequestedExtraction;
};

export function archivedIntake(input: unknown): IntakeDocument & { readonly envelope: SourceEnvelope } {
  const document = intakeDocument(input);
  const { original, materialId, extraction, title } = document;
  const kind = original.mediaType.startsWith('image/') ? 'photo'
    : original.mediaType === 'application/pdf' ? 'pdf' : 'text';
  return {
    ...document,
    envelope: sourceEnvelope({
      kind, occurredAt: null, recordedAt: null, retentionPolicy: 'retained',
      originals: [{ ...original, blobRef: `intake:${materialId}` }],
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
  if (drafts !== undefined && (status === 'pending' || status === 'failed' || status === 'corrected' ||
      (method !== 'vision_llm' && method !== 'vision_fallback')))
    throw new Error('切题草案只能附在成功的视觉识别结果上。');
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
  const document: IntakeDocument = {
    materialId: factId(text(value.materialId, '材料标识', 26, false)),
    title: materialFact.schema.parse({ title: value.title, text: '占位' }).title,
    original: intakeOriginal(value.original),
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

export function pendingVisionExtraction(stage: 'queued' | 'extracting' = 'queued'): IntakeExtraction {
  return {
    status: 'pending', method: 'vision_llm', text: '', error: null, warnings: [],
    pages: null, truncated: false, characterCount: 0, stage,
  };
}

export function failedVisionExtraction(error: string, method: 'vision_llm' | 'vision_fallback' = 'vision_llm'): IntakeExtraction {
  const message = error.replaceAll(String.fromCharCode(0), '').trim().slice(0, 1_000).toWellFormed();
  return {
    status: 'failed', method, error: message || '视觉识别失败。',
    text: '', characterCount: 0, pages: null, warnings: [], truncated: false, stage: 'failed',
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
  if (local.status === 'failed' || !local.text.trim()) {
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
  const warnings = [notice, ...local.warnings]
    .slice(0, 8)
    .map(item => item.replaceAll(String.fromCharCode(0), '').slice(0, 500).toWellFormed());
  return {
    status: local.status,
    method: 'vision_fallback',
    text: local.text,
    error: null,
    warnings,
    pages: local.pages,
    truncated: local.truncated,
    characterCount: local.text.length,
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

export const captureIntakeSchema = { parse: captureIntakeInput };
export const correctIntakeSchema = { parse: correctIntakeInput };
