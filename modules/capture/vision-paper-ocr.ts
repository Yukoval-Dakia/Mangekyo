import { captureObject as object, captureText as text } from './parse.ts';

export const visionIntakeSlot = 'activity.intakeVisionExtraction';
export const visionIntakeDeriver = 'activity.visionPaperExtraction';
export const visionIntakeRoute = { deriver: visionIntakeDeriver } as const;
export const completeVisionIntakeCommand = 'activity.completeVisionIntake';
export const visionPaperOcrVersion = 'vision-paper-ocr-v1';
export const visionPaperDraftsVersion = 'vision-paper-drafts-v1';
export const visionOcrMediaTypes = [
  'image/png',
  'image/jpeg',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/tiff',
  'image/webp',
] as const;

export function visionOcrSupports(mediaType: string): boolean {
  return (visionOcrMediaTypes as readonly string[]).includes(mediaType);
}

export type StructuredPaperQuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'fill_blank'
  | 'short_answer'
  | 'calculation'
  | 'proof'
  | 'code'
  | 'other';

const questionTypes: readonly StructuredPaperQuestionType[] = [
  'single_choice', 'multiple_choice', 'fill_blank', 'short_answer',
  'calculation', 'proof', 'code', 'other',
];

export type StructuredPaperOption = {
  readonly label: string;
  readonly text: string;
};

export type StructuredPaperStudentAnswer = {
  readonly status: 'present' | 'unclear' | 'absent';
  readonly text: string | null;
  readonly note?: string;
};

export type StructuredPaperRedInk = {
  readonly verdict: 'correct' | 'wrong' | 'partial' | 'none' | 'unclear';
  readonly marks: readonly string[];
  readonly correction: string | null;
  readonly score: string | null;
};

const redInkVerdicts = ['correct', 'wrong', 'partial', 'none', 'unclear'] as const;

export type StructuredPaperQuestion = {
  readonly index: number;
  readonly number: string;
  readonly questionType: StructuredPaperQuestionType;
  readonly stem: string;
  readonly options: readonly StructuredPaperOption[];
  readonly studentAnswer: StructuredPaperStudentAnswer;
  readonly redInk: StructuredPaperRedInk;
  readonly unclearSegments: readonly string[];
  readonly conceptTags?: readonly string[];
  readonly pageNumber?: number;
};

export type StructuredPaperOcr = {
  readonly version: typeof visionPaperOcrVersion;
  readonly paperTitle: string | null;
  readonly subject: string | null;
  readonly pageNote: string | null;
  readonly questions: readonly StructuredPaperQuestion[];
  readonly freeformText: string | null;
  readonly warnings: readonly string[];
};

export type StructuredPaperDraftQuestion = {
  readonly draftId: string;
  readonly index: number;
  readonly questionNumber: string;
  readonly questionType: StructuredPaperQuestionType;
  readonly stem: string;
  readonly options: readonly StructuredPaperOption[];
  readonly studentAnswer: StructuredPaperStudentAnswer;
  readonly redInk: StructuredPaperRedInk;
  readonly unclearSegments: readonly string[];
  readonly conceptTags?: readonly string[];
  readonly pageNumber?: number;
  readonly confirmationStatus: 'pending_confirmation';
  readonly needsClarification: boolean;
};

export type StructuredPaperDrafts = {
  readonly version: typeof visionPaperDraftsVersion;
  readonly confirmationRequired: true;
  readonly paperTitle: string | null;
  readonly subject: string | null;
  readonly questions: readonly StructuredPaperDraftQuestion[];
  readonly pendingConfirmationCount: number;
};

const maxWarnings = 8;
const maxQuestions = 120;
const stemLimit = 20_000;
const optionLimit = 4_000;
const answerLimit = 8_000;
const noteLimit = 500;
const labelLimit = 40;
const titleLimit = 240;
const freeformLimit = 200_000;
const conceptTagLimit = 80;
const maxOcrConceptTags = 3;
const maxDraftConceptTags = 6;

function clean(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  if (!value.isWellFormed() || value.includes('\u0000')) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? trimmed.slice(0, limit).toWellFormed() : trimmed;
}

function cleanList(value: unknown, label: string, limit: number, max = maxWarnings): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}数量超过上限。`);
  const items: string[] = [];
  for (const item of value) {
    const cleaned = clean(item, limit);
    if (cleaned !== null) items.push(cleaned);
  }
  return items;
}

function normalizeConceptTagKey(tag: string): string {
  return tag.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function normalizeConceptTags(value: unknown, options: { readonly strict: boolean; readonly max: number }): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    if (options.strict) throw new Error('切题草案知识点标签格式无效。');
    return [];
  }
  if (options.strict && value.length > options.max) {
    throw new Error('切题草案知识点标签数量超过上限。');
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (options.strict) {
      if (typeof raw !== 'string' || !raw.isWellFormed() || raw.includes('\u0000')) {
        throw new Error('切题草案知识点标签无效。');
      }
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > conceptTagLimit) throw new Error('切题草案知识点标签无效。');
      const key = normalizeConceptTagKey(trimmed);
      if (!key) throw new Error('切题草案知识点标签无效。');
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(trimmed);
      continue;
    }
    const cleaned = clean(raw, conceptTagLimit);
    if (cleaned === null) continue;
    const key = normalizeConceptTagKey(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tags.push(cleaned);
    if (tags.length >= options.max) break;
  }
  return tags;
}

/** Marker phrases a vision model writes when handwriting is illegible.
 * Models occasionally label such answers `present` with text like "看不清";
 * the parser normalizes them to honest `unclear` instead of trusting the tag. */
const unclearMarkers = /^[\[\(（【\s]*(?:看不清|无法辨认|无法识别|看不清楚|无法看清|模糊不清|辨认不清|难以辨认|无法确认|无法判断|unclear|illegible|unreadable|unrecognizable|\?+)(?:[\s:：,，;；\-—]*(?:[（(][^()（）]{0,40}[)）]|[\[\【][^\[\]【】]{0,40}[\]\】]))?[\]\)）】\s]*$/i;

function normalizeStudentAnswer(value: unknown): StructuredPaperStudentAnswer {
  if (value === undefined || value === null) {
    return { status: 'absent', text: null };
  }
  const row = object(value);
  const status = row.status;
  if (status !== 'present' && status !== 'unclear' && status !== 'absent')
    throw new Error('学生作答状态无效。');
  const rawText = clean(row.text, answerLimit);
  const note = clean(row.note, noteLimit) ?? undefined;
  if (status === 'present') {
    if (rawText === null || unclearMarkers.test(rawText)) {
      const parts = [
        note ?? null,
        rawText !== null && unclearMarkers.test(rawText) ? `模型曾标记作答但内容为「${rawText.slice(0, 60)}」` : null,
      ].filter((part): part is string => part !== null);
      return {
        status: 'unclear',
        text: null,
        ...(parts.length ? { note: parts.join('；').slice(0, noteLimit) } : {}),
      };
    }
    return { status: 'present', text: rawText, ...(note !== undefined ? { note } : {}) };
  }
  if (status === 'unclear') {
    const parts = [
      note ?? null,
      rawText !== null && !unclearMarkers.test(rawText) ? `部分可辨内容：${rawText.slice(0, 60)}` : null,
    ].filter((part): part is string => part !== null);
    return {
      status: 'unclear',
      text: null,
      ...(parts.length ? { note: parts.join('；').slice(0, noteLimit) } : {}),
    };
  }
  return { status: 'absent', text: null, ...(note !== undefined ? { note } : {}) };
}

function normalizeRedInk(value: unknown): StructuredPaperRedInk {
  if (value === undefined || value === null) {
    return { verdict: 'none', marks: [], correction: null, score: null };
  }
  const row = object(value);
  const verdict = row.verdict;
  if (!(redInkVerdicts as readonly unknown[]).includes(verdict))
    throw new Error('红笔批改结论无效。');
  const marks = cleanList(row.marks, '红笔标记', noteLimit, 12);
  const correction = clean(row.correction, answerLimit);
  const score = clean(row.score, labelLimit);
  if (verdict === 'none' && (marks.length > 0 || correction !== null || score !== null)) {
    return { verdict: 'unclear', marks, correction, score };
  }
  return { verdict: verdict as StructuredPaperRedInk['verdict'], marks, correction, score };
}

function normalizeOption(value: unknown): StructuredPaperOption {
  const row = object(value);
  const label = clean(row.label, labelLimit);
  const optionText = clean(row.text, optionLimit);
  if (label === null && optionText === null) throw new Error('选项缺少文本。');
  return { label: label ?? '', text: optionText ?? '' };
}

const questionTypeAliases: Readonly<Record<string, StructuredPaperQuestionType>> = {
  choice: 'single_choice',
  multi_choice: 'multiple_choice',
  essay: 'short_answer',
};

function normalizeQuestion(value: unknown, index: number): StructuredPaperQuestion {
  const row = object(value);
  const rawType = typeof row.questionType === 'string' ? row.questionType.trim() : row.questionType;
  const questionType = typeof rawType === 'string' && rawType in questionTypeAliases
    ? questionTypeAliases[rawType]
    : rawType;
  if (!(questionTypes as readonly unknown[]).includes(questionType))
    throw new Error(`第 ${index} 题题型无效。`);
  const stem = clean(row.stem, stemLimit);
  if (stem === null) throw new Error(`第 ${index} 题缺少印刷题干。`);
  const number = clean(row.number, labelLimit) ?? String(index);
  const rawOptions = row.options;
  if (rawOptions !== undefined && rawOptions !== null && !Array.isArray(rawOptions))
    throw new Error(`第 ${index} 题选项格式无效。`);
  const options = (rawOptions ?? []).map(normalizeOption);
  const unclearSegments = cleanList(row.unclearSegments, '模糊提示', noteLimit, 12);
  const conceptTags = normalizeConceptTags(row.conceptTags, { strict: false, max: maxOcrConceptTags });
  return {
    index,
    number,
    questionType: questionType as StructuredPaperQuestionType,
    stem,
    options,
    studentAnswer: normalizeStudentAnswer(row.studentAnswer),
    redInk: normalizeRedInk(row.redInk),
    unclearSegments,
    ...(conceptTags.length > 0 ? { conceptTags } : {}),
  };
}

/** Extracts the outermost JSON object from raw model output, tolerating
 * ` ```json ... ``` ` fences and surrounding chatter. Braces inside string
 * literals (including LaTeX backslashes and escapes) never count toward
 * nesting depth. */
export function extractJsonObjectText(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('识别结果为空。');
  const fenced = /```(?:json|JSON)?\s*\r?\n([\s\S]*?)```/.exec(raw);
  const candidates = fenced?.[1] !== undefined ? [fenced[1], raw] : [raw];
  for (const candidate of candidates) {
    const found = outermostJsonObject(candidate);
    if (found !== null) return found;
  }
  throw new Error('识别结果不是合法的 JSON 对象。');
}

function outermostJsonObject(source: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (code === 92) { escaped = true; continue; }
      if (code === 34) inString = false;
      continue;
    }
    if (code === 34) { inString = true; continue; }
    if (code === 123) {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (code === 125) {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = source.slice(start, index + 1);
        try { JSON.parse(slice); return slice; } catch { start = -1; }
      }
    }
  }
  return null;
}

export function parseStructuredPaperOcr(raw: unknown): StructuredPaperOcr {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(extractJsonObjectText(raw));
    } catch (error) {
      if (error instanceof Error && error.message === '识别结果为空。') throw error;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error('识别结果不是合法的 JSON 对象。');
      }
    }
  }
  const row = object(value);
  const version = row.version === undefined ? visionPaperOcrVersion : row.version;
  if (version !== visionPaperOcrVersion) throw new Error('识别结果版本不受支持。');
  const rawQuestions = row.questions;
  if (rawQuestions !== undefined && rawQuestions !== null &&
      (!Array.isArray(rawQuestions) || rawQuestions.length > maxQuestions))
    throw new Error('题目数量超过上限。');
  const questions = (rawQuestions ?? []).map((question, index) => normalizeQuestion(question, index + 1));
  const freeformText = clean(row.freeformText, freeformLimit);
  if (questions.length === 0 && freeformText === null)
    throw new Error('识别结果既无题目也无正文内容。');
  const warnings = cleanList(row.warnings, '识别提示', noteLimit);
  return {
    version: visionPaperOcrVersion,
    paperTitle: clean(row.paperTitle, titleLimit),
    subject: clean(row.subject, labelLimit),
    pageNote: clean(row.pageNote, noteLimit),
    questions,
    freeformText,
    warnings,
  };
}

const questionTypeLabels: Record<StructuredPaperQuestionType, string> = {
  single_choice: '单选题', multiple_choice: '多选题', fill_blank: '填空题',
  short_answer: '简答题', calculation: '计算题', proof: '证明题', code: '编程题', other: '其他',
};

const redInkVerdictLabels: Record<StructuredPaperRedInk['verdict'], string> = {
  correct: '正确', wrong: '错误', partial: '部分正确', none: '未批改', unclear: '批改内容看不清',
};

export function renderStructuredPaperMarkdown(ocr: StructuredPaperOcr): string {
  const lines: string[] = [];
  lines.push(`# ${ocr.paperTitle ?? '拍照试卷'}`);
  lines.push('');
  const meta: string[] = [];
  if (ocr.subject) meta.push(`科目：${ocr.subject}`);
  if (ocr.pageNote) meta.push(ocr.pageNote);
  if (meta.length) { lines.push(`> ${meta.join('　')}`); lines.push(''); }
  if (ocr.freeformText) {
    lines.push(ocr.freeformText);
    lines.push('');
  }
  for (const question of ocr.questions) {
    lines.push(`## ${question.number}.（${questionTypeLabels[question.questionType]}）`);
    lines.push('');
    lines.push(question.stem);
    lines.push('');
    for (const option of question.options) {
      lines.push(`- ${option.label ? `${option.label}. ` : ''}${option.text}`);
    }
    if (question.options.length) lines.push('');
    const { studentAnswer } = question;
    if (studentAnswer.status === 'present' && studentAnswer.text !== null) {
      lines.push(`**学生作答（黑笔）**：${studentAnswer.text}`);
    } else if (studentAnswer.status === 'unclear') {
      lines.push(`**学生作答（黑笔）**：看不清${studentAnswer.note ? `（${studentAnswer.note}）` : ''}`);
    } else {
      lines.push('**学生作答（黑笔）**：未作答');
    }
    lines.push('');
    const { redInk } = question;
    if (redInk.verdict !== 'none' || redInk.marks.length || redInk.correction !== null || redInk.score !== null) {
      const parts: string[] = [`批改：${redInkVerdictLabels[redInk.verdict]}`];
      if (redInk.marks.length) parts.push(`标记：${redInk.marks.join('、')}`);
      if (redInk.score !== null) parts.push(`得分：${redInk.score}`);
      if (redInk.correction !== null) parts.push(`订正：${redInk.correction}`);
      lines.push(`**红笔批改**：${parts.join('；')}`);
      lines.push('');
    }
    if (question.conceptTags && question.conceptTags.length > 0) {
      lines.push(`**知识点**：${question.conceptTags.join('、')}`);
      lines.push('');
    }
    if (question.unclearSegments.length) {
      lines.push(`> 模糊提示：${question.unclearSegments.join('；')}`);
      lines.push('');
    }
  }
  if (ocr.warnings.length) {
    lines.push('---');
    lines.push('');
    for (const warning of ocr.warnings) lines.push(`> ${warning}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function structuredPaperToDrafts(ocr: StructuredPaperOcr, options?: { readonly pageNumber?: number }): StructuredPaperDrafts {
  const pageNumber = options?.pageNumber;
  const questions: StructuredPaperDraftQuestion[] = ocr.questions.map(question => {
    const conceptTags = normalizeConceptTags(question.conceptTags, { strict: false, max: maxOcrConceptTags });
    const resolvedPage = pageNumber ?? question.pageNumber;
    return {
      draftId: resolvedPage !== undefined ? `draft-p${resolvedPage}-q-${question.index}` : `draft-q-${question.index}`,
      index: question.index,
      questionNumber: question.number,
      questionType: question.questionType,
      stem: question.stem,
      options: question.options,
      studentAnswer: question.studentAnswer,
      redInk: question.redInk,
      unclearSegments: question.unclearSegments,
      ...(conceptTags.length > 0 ? { conceptTags } : {}),
      ...(resolvedPage !== undefined ? { pageNumber: resolvedPage } : {}),
      confirmationStatus: 'pending_confirmation',
      needsClarification: question.studentAnswer.status === 'unclear' ||
        question.redInk.verdict === 'unclear' || question.unclearSegments.length > 0,
    };
  });
  const pendingConfirmationCount = questions.length > 0 ? questions.length : 1;
  return {
    version: visionPaperDraftsVersion,
    confirmationRequired: true,
    paperTitle: ocr.paperTitle,
    subject: ocr.subject,
    questions,
    pendingConfirmationCount,
  };
}

export function validateStructuredPaperDrafts(input: unknown): StructuredPaperDrafts {
  const row = object(input);
  if (row.version !== visionPaperDraftsVersion) throw new Error('切题草案版本不受支持。');
  if (row.confirmationRequired !== true) throw new Error('切题草案必须等待学习者确认。');
  if (!Array.isArray(row.questions) || row.questions.length > maxQuestions)
    throw new Error('切题草案题目数量无效。');
  const questions: StructuredPaperDraftQuestion[] = row.questions.map(value => {
    const item = object(value);
    const draftId = clean(item.draftId, 80);
    if (draftId === null) throw new Error('切题草案缺少草案标识。');
    const questionType = item.questionType;
    if (!(questionTypes as readonly unknown[]).includes(questionType))
      throw new Error('切题草案题型无效。');
    const stem = clean(item.stem, stemLimit);
    if (stem === null) throw new Error('切题草案缺少题干。');
    const index = item.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 1 || index > maxQuestions)
      throw new Error('切题草案序号无效。');
    const pageNumber = item.pageNumber;
    if (pageNumber !== undefined && (typeof pageNumber !== 'number' || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 1_000))
      throw new Error('切题草案页码无效。');
    const rawOptions = item.options;
    if (rawOptions !== undefined && rawOptions !== null && !Array.isArray(rawOptions))
      throw new Error('切题草案选项格式无效。');
    if (item.confirmationStatus !== 'pending_confirmation')
      throw new Error('切题草案确认状态无效。');
    const studentAnswer = normalizeStudentAnswer(item.studentAnswer);
    const redInk = normalizeRedInk(item.redInk);
    const unclearSegments = cleanList(item.unclearSegments, '模糊提示', noteLimit, 12);
    const conceptTags = normalizeConceptTags(item.conceptTags, { strict: true, max: maxDraftConceptTags });
    return {
      draftId,
      index,
      questionNumber: clean(item.questionNumber, labelLimit) ?? String(index),
      questionType: questionType as StructuredPaperQuestionType,
      stem,
      options: (rawOptions ?? []).map(normalizeOption),
      studentAnswer,
      redInk,
      unclearSegments,
      ...(conceptTags.length > 0 ? { conceptTags } : {}),
      ...(pageNumber !== undefined ? { pageNumber } : {}),
      confirmationStatus: 'pending_confirmation',
      needsClarification: studentAnswer.status === 'unclear' ||
        redInk.verdict === 'unclear' || unclearSegments.length > 0 ||
        item.needsClarification === true,
    };
  });
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.draftId)) throw new Error('切题草案标识重复。');
    seen.add(question.draftId);
  }
  const minimumPending = questions.length > 0 ? questions.length : 1;
  const pendingConfirmationCount = row.pendingConfirmationCount;
  if (typeof pendingConfirmationCount !== 'number' || !Number.isSafeInteger(pendingConfirmationCount) ||
      pendingConfirmationCount < minimumPending || pendingConfirmationCount > 1_000)
    throw new Error('切题草案待确认数量无效。');
  return {
    version: visionPaperDraftsVersion,
    confirmationRequired: true,
    paperTitle: clean(row.paperTitle, titleLimit),
    subject: clean(row.subject, labelLimit),
    questions,
    pendingConfirmationCount,
  };
}

export type VisionPaperOcrPromptOptions = {
  readonly filename?: string;
  readonly titleHint?: string;
  readonly redInkMeaning?: string;
  readonly pageNumber?: number;
  readonly totalPages?: number;
};

export function buildVisionPaperOcrPrompt(options?: VisionPaperOcrPromptOptions): {
  readonly systemPrompt: string;
  readonly userPrompt: string;
} {
  const systemPrompt = [
    '你是严谨的试卷结构化OCR引擎。只做忠实文字、公式与手写痕迹转写，严禁解题、推导计算或判断学生选项对错；只输出一个严格JSON对象，禁止Markdown围栏与多余文字，不要冗长思考。',
    '规则：',
    '1. 只做忠实文字、公式与手写痕迹转写，严禁解题、推导计算或判断学生选项对错；仔细扫描整张图片（尤其注意双栏排版：先左栏从上到下，再右栏从上到下；左栏末题的选项可能跨到右栏顶部），完整逐题输出所有可见题目，不遗漏也不编造被裁切的题。',
    '2. 印刷题干与选项中的公式必须用标准LaTeX（行内$...$，独立公式$$...$$）；代码、伪代码与流程图逻辑用三重反引号逐字保留。',
    '3. 严格分离学生黑笔/铅笔作答（studentAnswer）与教师红笔批改/订正（redInk），绝不混淆。',
    '4. 保留题干开头的真题来源标注（如（2023·浙江1月选考））；遇到物理/几何示意图时简要描述图意，忽略OMR答题卡填涂泡与条码噪点。',
    '5. 反光、遮挡或潦草看不清处严禁猜测：学生作答标{"status":"unclear","text":null}并写入unclearSegments；红笔批改看不清把redInk.verdict标为"unclear"。',
    '6. 若为纯讲义/非题目材料，正文放freeformText，questions放空数组；两者至少其一非空。',
    '7. 为每道题提炼1–3个简洁规范的中文学科核心知识点名放入conceptTags（如["交变电流的产生","正弦式交变电流"]），不带题号、章节号或泛称；无把握可给空数组。',
    'JSON结构：{"version":"vision-paper-ocr-v1","paperTitle":string|null,"subject":string|null,"pageNote":string|null,"questions":[{"number":string,"questionType":"single_choice"|"multiple_choice"|"fill_blank"|"short_answer"|"calculation"|"proof"|"code"|"other","stem":string,"options":[{"label":string,"text":string}],"studentAnswer":{"status":"present"|"unclear"|"absent","text":string|null,"note"?:string},"redInk":{"verdict":"correct"|"wrong"|"partial"|"none"|"unclear","marks":string[],"correction":string|null,"score":string|null},"unclearSegments":string[],"conceptTags":string[]}],"freeformText":string|null,"warnings":string[]}',
  ].join('\n');
  const hints: string[] = [];
  const filename = clean(options?.filename, 180);
  const titleHint = clean(options?.titleHint, titleLimit);
  const redInkMeaning = clean(options?.redInkMeaning, 400);
  if (filename) hints.push(`文件名：${filename}`);
  if (titleHint) hints.push(`标题提示：${titleHint}`);
  if (options?.pageNumber !== undefined && options?.totalPages !== undefined &&
      Number.isSafeInteger(options.pageNumber) && Number.isSafeInteger(options.totalPages) &&
      options.pageNumber >= 1 && options.totalPages > 1) {
    hints.push(`页码位置：第 ${options.pageNumber} / ${options.totalPages} 页（请保留原卷题号，不要编造其他页的题目）`);
  }
  if (redInkMeaning) hints.push(`红笔说明：${redInkMeaning}`);
  const instruction = '只做忠实文字、公式与手写痕迹转写，严禁解题、推导计算或判断学生选项对错；保留题干开头的真题来源标注，遇到物理/几何示意图时简要描述图意，忽略OMR答题卡填涂泡与条码噪点。';
  const userPrompt = hints.length
    ? `请按双栏顺序完整识别这张试卷照片，直接输出JSON。\n${instruction}\n${hints.join('\n')}`
    : `请按双栏顺序完整识别这张试卷照片，直接输出JSON。\n${instruction}`;
  return { systemPrompt, userPrompt };
}

export function buildVisionPaperChatMessages(
  imageDataUrl: string,
  options?: VisionPaperOcrPromptOptions,
): readonly { readonly role: string; readonly content: unknown }[] {
  text(imageDataUrl, '图片数据', 40 * 1024 * 1024);
  const { systemPrompt, userPrompt } = buildVisionPaperOcrPrompt(options);
  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
      ],
    },
  ];
}
