import { factId, type FactId } from '@mangekyo/kernel';
import { materialType, storagePurpose, textMaterial } from './library-values.ts';

export const intakePurpose = storagePurpose;
export const intakeFactType = 'activity.intakeDocument';
export const captureIntakeCommand = 'activity.captureIntake';
export const correctIntakeCommand = 'activity.correctIntakeText';
export const completeCloudIntakeCommand = 'activity.completeCloudIntake';

export const materialTextLimit = 4000;
export const intakeTextLimit = 2_000_000;
export const intakeFileLimit = 25 * 1024 * 1024;

export const intakeMediaTypes = [
  'application/pdf',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'text/markdown',
  'text/plain',
] as const;

export type IntakeMediaType = (typeof intakeMediaTypes)[number];

export const intakeFailureText =
  '这份原件已保存，但未能自动抽取文字。请打开材料详情下载原件，或在这里手动补充文字。';

const intakePendingText = '原件已保存，正在由 MinerU 云识别。';

export type IntakeExtractionStatus = 'ok' | 'partial' | 'failed' | 'corrected' | 'pending';
export type IntakeExtractionMethod = 'pdfkit' | 'vision' | 'pdfkit+vision' | 'utf8' | 'learner' | 'mineru';

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
};

export type IntakeDocument = {
  readonly materialId: FactId;
  readonly title: string;
  readonly original: IntakeOriginal;
  readonly extraction: IntakeExtraction;
  readonly requestedExtraction?: 'mineru';
};

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

export function intakeExtraction(input: unknown): IntakeExtraction {
  const value = object(input);
  const status = value.status;
  const method = value.method;
  if (status !== 'ok' && status !== 'partial' && status !== 'failed' && status !== 'corrected' && status !== 'pending') {
    throw new Error('抽取状态无效。');
  }
  if (method !== 'pdfkit' && method !== 'vision' && method !== 'pdfkit+vision' &&
      method !== 'utf8' && method !== 'learner' && method !== 'mineru') {
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
  if (status === 'pending' && (method !== 'mineru' || pageNumber !== null || value.truncated !== false))
    throw new Error('待识别结果格式无效。');
  if (status === 'ok' || status === 'corrected' || status === 'pending') {
    if (error !== null) throw new Error('成功状态不能有抽取错误。');
  }
  if (status === 'failed' && (error === null || !error.trim())) throw new Error('失败状态必须说明原因。');
  if (status === 'partial' && error !== null) throw new Error('部分成功状态不能用错误掩盖。');
  if (value.truncated !== true && value.truncated !== false) throw new Error('抽取截断标记无效。');
  if (value.characterCount !== textValue.length) throw new Error('抽取字数与文字不匹配。');
  return {
    status,
    method,
    text: textValue,
    error,
    warnings: warningTexts,
    pages: pageNumber,
    truncated: value.truncated as boolean,
    characterCount: textValue.length,
  };
}

export function intakeDocument(input: unknown): IntakeDocument {
  const value = object(input);
  if (value.requestedExtraction !== undefined && value.requestedExtraction !== 'mineru')
    throw new Error('交入识别方式无效。');
  const extraction = intakeExtraction(value.extraction);
  if (extraction.method === 'mineru' && value.requestedExtraction !== 'mineru')
    throw new Error('云识别结果缺少对应的交入请求。');
  const document: IntakeDocument = {
    materialId: factId(text(value.materialId, '材料标识', 26, false)),
    title: textMaterial({ title: value.title, text: '占位' }).title,
    original: intakeOriginal(value.original),
    extraction,
    ...(value.requestedExtraction === 'mineru' ? { requestedExtraction: 'mineru' } : {}),
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
  if (extraction.status === 'pending') return intakePendingText;
  if (extraction.status === 'failed') return intakeFailureText;
  return materialPreview(extraction.text).text;
}

export function captureIntakeInput(input: unknown): CaptureIntakeInput {
  const value = object(input);
  const materialId = factId(text(value.materialId, '材料标识', 26));
  const intakeId = factId(text(value.intakeId, '交入记录标识', 26));
  const document = intakeDocument({ ...value, materialId });
  const material = textMaterial({ title: document.title, text: intakePreview(document.extraction) });
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
export { materialType };
