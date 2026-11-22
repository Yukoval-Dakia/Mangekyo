import type { FactId } from '@mangekyo/kernel';
import { intakeDocument, type IntakeDocument } from './intake-values.ts';
import type {
  StructuredPaperOption,
  StructuredPaperQuestionType,
  StructuredPaperRedInk,
  StructuredPaperStudentAnswer,
} from './vision-paper-ocr.ts';

export type IntakeQuestionCard = {
  readonly draftId: string;
  readonly index: number;
  readonly number: string;
  readonly kind: StructuredPaperQuestionType;
  readonly stem: string;
  readonly options: readonly StructuredPaperOption[];
  readonly studentAnswer: StructuredPaperStudentAnswer;
  readonly redPenMark: StructuredPaperRedInk;
  readonly isRedPenError: boolean;
  readonly unclearNotice: string | null;
  readonly defaultSelected: boolean;
};

export type IntakeFreshMaterialHints = {
  readonly questionCount?: number;
  readonly redPenErrorCount?: number;
};

export type IntakeWorkbookQuestionOverride = {
  readonly draftId: string;
  readonly stem?: string;
  readonly options?: readonly StructuredPaperOption[];
  readonly confirmedAnswer?: string | number | null;
  readonly numericTolerance?: number;
  readonly numericUnit?: string | null;
  readonly rubric?: string;
  readonly explanation?: string | null;
};

export type IntakeWorkbookSelection = {
  readonly title?: string;
  readonly items: readonly (string | IntakeWorkbookQuestionOverride)[];
};

export type IntakeWorkbookDraftQuestion =
  | { readonly kind: 'numeric'; readonly prompt: string; readonly answer: number; readonly tolerance: number; readonly unit: string | null; readonly explanation: string | null }
  | { readonly kind: 'exact'; readonly prompt: string; readonly answers: string[]; readonly selfCheck: boolean; readonly explanation: string | null }
  | { readonly kind: 'rubric'; readonly prompt: string; readonly rubric: string; readonly rubricVersion: 'rubric-v1'; readonly explanation: string | null };

export type IntakeWorkbookDraft = {
  readonly title: string;
  readonly materialId: FactId;
  readonly sourceIntakeTitle: string;
  readonly selectedDraftIds: readonly string[];
  readonly questions: readonly IntakeWorkbookDraftQuestion[];
};

const objectiveKinds = new Set<StructuredPaperQuestionType>([
  'single_choice', 'multiple_choice', 'fill_blank',
]);

function document(input: IntakeDocument | unknown): IntakeDocument {
  return intakeDocument(input);
}

function isRedPenError(redInk: StructuredPaperRedInk): boolean {
  return redInk.verdict === 'wrong' || redInk.verdict === 'partial' || redInk.correction !== null;
}

function unclearNotice(
  studentAnswer: StructuredPaperStudentAnswer,
  redInk: StructuredPaperRedInk,
  unclearSegments: readonly string[],
): string | null {
  const parts: string[] = [];
  if (studentAnswer.status === 'unclear') {
    parts.push(`学生作答看不清${studentAnswer.note ? `（${studentAnswer.note}）` : ''}`);
  }
  if (redInk.verdict === 'unclear') parts.push('红笔批改看不清');
  if (unclearSegments.length > 0) parts.push(`模糊位置：${unclearSegments.join('；')}`);
  return parts.length > 0 ? parts.join('；') : null;
}

export function projectIntakeQuestionCards(intake: IntakeDocument | unknown): readonly IntakeQuestionCard[] {
  return document(intake).extraction.drafts?.questions.map(question => {
    const error = isRedPenError(question.redInk);
    return {
      draftId: question.draftId,
      index: question.index,
      number: question.questionNumber,
      kind: question.questionType,
      stem: question.stem,
      options: question.options,
      studentAnswer: question.studentAnswer,
      redPenMark: question.redInk,
      isRedPenError: error,
      unclearNotice: unclearNotice(question.studentAnswer, question.redInk, question.unclearSegments),
      defaultSelected: error,
    };
  }) ?? [];
}

export function extractIntakeFreshMaterialHints(intake: IntakeDocument | unknown): IntakeFreshMaterialHints {
  const questions = document(intake).extraction.drafts?.questions;
  if (questions === undefined || questions.length === 0) return {};
  const cards = projectIntakeQuestionCards(intake);
  return { questionCount: questions.length, redPenErrorCount: cards.filter(card => card.isRedPenError).length };
}

function storedText(value: unknown, label: string, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文字。`);
  const result = value.trim();
  if (!result.isWellFormed() || result.includes('\u0000') || (!allowEmpty && !result) || result.length > limit) {
    throw new Error(`${label}长度或内容无效。`);
  }
  return result;
}

function parseOption(value: unknown): StructuredPaperOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('题目选项格式无效。');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2) throw new Error('题目选项字段无效。');
  return {
    label: typeof row.label === 'string' ? storedText(row.label, '选项字母', 40, true) : (() => { throw new Error('选项字母必须是文字。'); })(),
    text: typeof row.text === 'string' ? storedText(row.text, '选项内容', 4_000) : (() => { throw new Error('选项内容必须是文字。'); })(),
  };
}

function parseOverride(value: unknown): IntakeWorkbookQuestionOverride {
  if (typeof value === 'string') {
    const draftId = storedText(value, '草案标识', 80);
    return { draftId };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('微卷选题格式无效。');
  const row = value as Record<string, unknown>;
  const allowed = new Set(['draftId', 'stem', 'options', 'confirmedAnswer', 'numericTolerance', 'numericUnit', 'rubric', 'explanation']);
  if (Object.keys(row).some(key => !allowed.has(key))) throw new Error('微卷选题包含未知字段。');
  if (row.numericTolerance !== undefined && (typeof row.numericTolerance !== 'number' ||
      !Number.isFinite(row.numericTolerance) || row.numericTolerance < 0)) throw new Error('数值容差无效。');
  if (row.numericUnit !== undefined && row.numericUnit !== null && typeof row.numericUnit !== 'string') {
    throw new Error('数值单位无效。');
  }
  return {
    draftId: typeof row.draftId === 'string' ? storedText(row.draftId, '草案标识', 80) : (() => { throw new Error('草案标识必须是文字。'); })(),
    ...(row.stem === undefined ? {} : { stem: typeof row.stem === 'string' ? storedText(row.stem, '题干', 20_000) : (() => { throw new Error('题干必须是文字。'); })() }),
    ...(row.options === undefined ? {} : {
      options: Array.isArray(row.options) && row.options.length <= 60
        ? row.options.map(parseOption)
        : (() => { throw new Error('题目选项数量无效。'); })(),
    }),
    ...(row.confirmedAnswer === undefined ? {} : { confirmedAnswer: row.confirmedAnswer as string | number | null }),
    ...(row.numericTolerance === undefined ? {} : { numericTolerance: row.numericTolerance as number }),
    ...(row.numericUnit === undefined ? {} : {
      numericUnit: row.numericUnit === null ? null : storedText(row.numericUnit as string, '数值单位', 40),
    }),
    ...(row.rubric === undefined ? {} : {
      rubric: typeof row.rubric === 'string' ? storedText(row.rubric, '评分标准', 8_000) : (() => { throw new Error('评分标准必须是文字。'); })(),
    }),
    ...(row.explanation === undefined ? {} : {
      explanation: row.explanation === null ? null : storedText(row.explanation as string, '题解', 4_000),
    }),
  };
}

function optionLines(options: readonly StructuredPaperOption[]): string {
  return options.map(option => `${option.label || '•'}. ${option.text}`).join('\n');
}

function prompt(stem: string, options: readonly StructuredPaperOption[]): string {
  const value = options.length > 0 ? `${stem}\n${optionLines(options)}` : stem;
  if (value.length > 4_000 || value.length === 0 || !value.isWellFormed() || value.includes('\u0000')) {
    throw new Error('微卷题干长度或内容无效（无题库引用时须在 1 到 4000 字内）。');
  }
  return value;
}

function answerText(value: string, options: readonly StructuredPaperOption[]): string {
  const compact = value.replaceAll(/\s+/g, '').toUpperCase();
  const labels = options.map(option => option.label.replaceAll(/\s+/g, '').toUpperCase()).filter(label => label);
  const matchingText = options.find(option => option.text === value)?.label;
  if (matchingText !== undefined && matchingText !== '') return matchingText.toUpperCase();
  if (labels.length > 0 && [...compact].every(character => labels.some(label => label === character))) return compact;
  const grouped = value.split(/[,，、\s]+/).filter(Boolean).map(part => part.toUpperCase());
  if (grouped.length > 1 && grouped.every(part => labels.some(label => label === part))) return grouped.join('');
  return value.trim();
}

function sourceExplanation(
  question: IntakeQuestionCard,
  override: IntakeWorkbookQuestionOverride,
  selfCheckCorrection: string | null,
): string | null {
  if (override.explanation !== undefined) {
    return override.explanation === null ? null : storedText(override.explanation, '题解', 4_000);
  }
  const red = question.redPenMark;
  const parts = [
    `原卷题号：${question.number}。`,
    question.studentAnswer.status === 'present'
      ? `当时作答：${question.studentAnswer.text ?? ''}。`
      : `当时作答：${question.studentAnswer.status === 'absent' ? '未作答' : '看不清'}。`,
    red.verdict !== 'none' ? `红笔批改：${red.verdict}${red.score ? `（${red.score}）` : ''}${red.marks.length ? `；标记：${red.marks.join('、')}` : ''}。` : null,
    red.correction !== null ? `红笔订正：${red.correction}。` : null,
    question.unclearNotice !== null ? `模糊提醒：${question.unclearNotice}。` : null,
    selfCheckCorrection !== null ? '参考原卷红笔订正暂填自检答案，请核对标准答案。' : null,
  ].filter((part): part is string => part !== null);
  return parts.join('').slice(0, 4_000).toWellFormed() || null;
}

function defaultRubric(question: IntakeQuestionCard, override: IntakeWorkbookQuestionOverride): string {
  if (override.rubric !== undefined) return override.rubric;
  const parts = [
    '本题来自拍卷原件，尚未提供标准答案。请独立重做后对照原卷、红笔批注或课堂讲解自查关键步骤与结论。',
    question.redPenMark.marks.length > 0 ? `红笔批注：${question.redPenMark.marks.join('；')}。` : null,
    question.redPenMark.correction !== null ? `红笔订正：${question.redPenMark.correction}。` : null,
    question.unclearNotice !== null ? `模糊提醒：${question.unclearNotice}。` : null,
  ].filter((part): part is string => part !== null);
  return parts.join('').slice(0, 8_000).toWellFormed();
}

function questionDraft(question: IntakeQuestionCard, override: IntakeWorkbookQuestionOverride): IntakeWorkbookDraftQuestion {
  const fullPrompt = prompt(override.stem ?? question.stem, override.options ?? question.options);
  const confirmed = override.confirmedAnswer;
  if (typeof confirmed === 'number') {
    if (!Number.isFinite(confirmed)) throw new Error('标准数值答案无效。');
    const tolerance = override.numericTolerance ?? 0;
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('数值容差不能小于零。');
    const unit = override.numericUnit === undefined || override.numericUnit === null
      ? null
      : storedText(override.numericUnit, '数值单位', 40);
    return {
      kind: 'numeric', prompt: fullPrompt, answer: confirmed === 0 ? 0 : confirmed,
      tolerance, unit, explanation: sourceExplanation(question, override, null),
    };
  }
  if (typeof confirmed === 'string') {
    const answer = answerText(storedText(confirmed, '标准答案', 500), override.options ?? question.options);
    if (answer.length === 0 || answer.length > 500) throw new Error('标准答案长度无效。');
    return {
      kind: 'exact', prompt: fullPrompt, answers: [answer], selfCheck: false,
      explanation: sourceExplanation(question, override, null),
    };
  }
  if (confirmed !== undefined && confirmed !== null) throw new Error('标准答案格式无效。');
  const correction = override.rubric === undefined && objectiveKinds.has(question.kind)
    ? question.redPenMark.correction
    : null;
  if (correction !== null && correction.length > 0 && correction.length <= 500) {
    return {
      kind: 'exact', prompt: fullPrompt, answers: [correction], selfCheck: true,
      explanation: sourceExplanation(question, override, correction),
    };
  }
  return {
    kind: 'rubric', prompt: fullPrompt, rubric: defaultRubric(question, override),
    rubricVersion: 'rubric-v1', explanation: sourceExplanation(question, override, null),
  };
}

export function buildWorkbookDraftFromIntakeSelection(
  intake: IntakeDocument | unknown,
  selection: IntakeWorkbookSelection,
): IntakeWorkbookDraft {
  const parsed = document(intake);
  const questions = parsed.extraction.drafts?.questions;
  if (questions === undefined || questions.length === 0) throw new Error('这份拍卷还没有结构化题目草案。');
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('微卷选题格式无效。');
  const items = selection.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new Error('微卷需要选择 1 到 100 道题。');
  const overrides = items.map(parseOverride);
  const selectedIds = overrides.map(item => item.draftId);
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error('微卷选题不能重复。');
  const byId = new Map(questions.map(question => [question.draftId, question]));
  if (selectedIds.some(id => !byId.has(id))) throw new Error('微卷选题包含无效草案标识。');
  const cards = new Map(projectIntakeQuestionCards(parsed).map(card => [card.draftId, card]));
  const customTitle = selection.title === undefined
    ? undefined
    : storedText(selection.title, '试卷标题', 240);
  const allSelected = selectedIds.length === questions.length;
  const allErrors = overrides.every(item => cards.get(item.draftId)?.isRedPenError === true);
  const suffix = allSelected && !allErrors ? '（拍卷练习）' : '（错题复盘）';
  const defaultTitle = `${parsed.title.slice(0, 240 - suffix.length).toWellFormed()}${suffix}`;
  const title = (customTitle ?? defaultTitle).slice(0, 240).toWellFormed();
  return {
    title,
    materialId: parsed.materialId,
    sourceIntakeTitle: parsed.title,
    selectedDraftIds: selectedIds,
    questions: overrides.map(item => questionDraft(cards.get(item.draftId)!, item)),
  };
}
