import { factId } from '@mangekyo/kernel';

export const workbookPaperType = 'activity.workbookPaper';
export const workbookAttemptType = 'activity.workbookAttempt';
export const saveWorkbookPaperCommand = 'activity.saveWorkbookPaper';
export const submitWorkbookAttemptCommand = 'activity.submitWorkbookAttempt';
export const workbookGradingVersion = 'workbook-v1';

const requestPattern = /^[A-Za-z0-9_-]{8,100}$/;
const questionIdPattern = /^[A-Za-z0-9_-]{1,40}$/;
const maxQuestions = 100;

export type WorkbookNumericQuestion = {
  id: string;
  kind: 'numeric';
  prompt: string;
  answer: number;
  tolerance: number;
  unit: string | null;
  explanation: string | null;
};

export type WorkbookExactQuestion = {
  id: string;
  kind: 'exact';
  prompt: string;
  answers: string[];
  selfCheck: boolean;
  explanation: string | null;
};

export type WorkbookQuestion = WorkbookNumericQuestion | WorkbookExactQuestion;

export type WorkbookPaper = {
  title: string;
  materialId: string | null;
  savedAt: string;
  questions: WorkbookQuestion[];
};

export type WorkbookQuestionDraft =
  | {
    kind: 'numeric';
    prompt: string;
    answer: number;
    tolerance: number;
    unit?: string | null;
    explanation?: string | null;
  }
  | {
    kind: 'exact';
    prompt: string;
    answers: string[];
    selfCheck?: boolean;
    explanation?: string | null;
  };

export type WorkbookDraft = {
  title: string;
  materialId: string | null;
  questions: WorkbookQuestion[];
};

export type WorkbookAnswer = number | string | null;

export type WorkbookExpected =
  | { kind: 'numeric'; value: number; tolerance: number; unit: string | null }
  | { kind: 'exact'; values: string[] };

export type WorkbookFeedback = {
  questionId: string;
  result: 'correct' | 'incorrect' | 'unanswered' | 'self-check';
  answer: WorkbookAnswer;
  expected: WorkbookExpected;
  explanation: string | null;
};

export type WorkbookAttempt = {
  paperId: string;
  requestId: string;
  submittedAt: string;
  gradingVersion: string;
  paper: WorkbookPaper;
  answers: Record<string, WorkbookAnswer>;
  feedback: WorkbookFeedback[];
};

export type WorkbookAttemptRequest = {
  paperId: string;
  requestId: string;
  submittedAt: string;
  answers: Record<string, string | null>;
};

export type WorkbookQuestionView =
  | { id: string; kind: 'numeric'; prompt: string; unit: string | null }
  | { id: string; kind: 'exact'; prompt: string; selfCheck: boolean };

export type WorkbookSourceView = {
  id: string;
  title: string | null;
  available: boolean;
};

export type WorkbookSummary = {
  id: string;
  title: string;
  questionCount: number;
  savedAt: string;
  sourceId: string | null;
  sourceTitle: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
};

export type WorkbookAttemptView = {
  id: string;
  requestId: string;
  submittedAt: string;
  answers: Record<string, WorkbookAnswer>;
  feedback: (Omit<WorkbookFeedback, 'expected'> & { expected: WorkbookExpected | null })[];
  correctCount: number;
  total: number;
};

export type WorkbookDetail = {
  id: string;
  title: string;
  savedAt: string;
  source: WorkbookSourceView | null;
  questions: WorkbookQuestionView[];
  attempts: WorkbookAttemptView[];
};

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('试卷记录格式无效。');
  }
  return value as Record<string, unknown>;
}

function canStore(text: string): boolean {
  return text.isWellFormed() && !text.includes('\u0000');
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文字。`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit || !canStore(trimmed)) {
    throw new Error(`${label}长度无效。`);
  }
  return trimmed;
}

function optionalText(value: unknown, label: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label}必须是文字。`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > limit || !canStore(trimmed)) throw new Error(`${label}长度无效。`);
  return trimmed;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}必须是数字。`);
  }
  return value === 0 ? 0 : value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label}格式无效。`);
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${label}格式无效。`);
  }
  return value;
}

function materialReference(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('来源材料标识无效。');
  return factId(value);
}

function alternatives(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('精确答案至少需要一条，最多二十条。');
  }
  const seen = new Set<string>();
  const answers = value.map((entry, index) => {
    const answer = text(entry, `第 ${index + 1} 条精确答案`, 500);
    const key = normalizeExact(answer);
    if (seen.has(key)) throw new Error('精确答案不能重复。');
    seen.add(key);
    return answer;
  });
  return answers;
}

function draftQuestion(value: unknown, index: number): WorkbookQuestion {
  const row = record(value);
  const kind = row.kind;
  const prompt = text(row.prompt, `第 ${index + 1} 题题面`, 4000);
  const explanation = optionalText(row.explanation, `第 ${index + 1} 题解析`, 4000);
  const id = `q${index + 1}`;
  if (kind === 'numeric') {
    const tolerance = numberValue(row.tolerance, `第 ${index + 1} 题容差`);
    if (tolerance < 0) throw new Error('容差不能小于零。');
    return {
      id,
      kind,
      prompt,
      answer: numberValue(row.answer, `第 ${index + 1} 题答案`),
      tolerance,
      unit: optionalText(row.unit, `第 ${index + 1} 题单位`, 40),
      explanation,
    };
  }
  if (kind === 'exact') {
    if (row.selfCheck !== undefined && typeof row.selfCheck !== 'boolean') {
      throw new Error(`第 ${index + 1} 题自评设置无效。`);
    }
    return {
      id,
      kind,
      prompt,
      answers: alternatives(row.answers),
      selfCheck: row.selfCheck === true,
      explanation,
    };
  }
  throw new Error(`第 ${index + 1} 题类型无效。`);
}

function storedQuestion(value: unknown, index: number): WorkbookQuestion {
  const row = record(value);
  const id = row.id;
  if (typeof id !== 'string' || !questionIdPattern.test(id)) {
    throw new Error(`第 ${index + 1} 题标识无效。`);
  }
  const parsed = draftQuestion({
    ...row,
    id: undefined,
  }, index);
  return { ...parsed, id };
}

export function workbookDraft(input: unknown): WorkbookDraft {
  const row = record(input);
  const questions = row.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > maxQuestions) {
    throw new Error('一份试卷需要 1 到 100 道题。');
  }
  return {
    title: text(row.title, '试卷标题', 240),
    materialId: materialReference(row.materialId),
    questions: questions.map(draftQuestion),
  };
}

export function workbookPaper(input: unknown): WorkbookPaper {
  const row = record(input);
  const questions = row.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > maxQuestions) {
    throw new Error('试卷题目数量无效。');
  }
  const parsed = questions.map(storedQuestion);
  const ids = new Set(parsed.map(({ id }) => id));
  if (ids.size !== parsed.length) throw new Error('试卷题目标识重复。');
  return {
    title: text(row.title, '试卷标题', 240),
    materialId: materialReference(row.materialId),
    savedAt: timestamp(row.savedAt, '保存时间'),
    questions: parsed,
  };
}

export function workbookRequestId(value: unknown): string {
  if (typeof value !== 'string' || !requestPattern.test(value)) {
    throw new Error('请求标识无效。');
  }
  return value;
}

export function workbookAttemptRequest(input: unknown): WorkbookAttemptRequest {
  const row = record(input);
  const answers = record(row.answers);
  const given: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value !== null && typeof value !== 'string') {
      throw new Error('作答内容无效。');
    }
    given[key] = value;
  }
  return {
    paperId: factId(String(row.paperId)),
    requestId: workbookRequestId(row.requestId),
    submittedAt: timestamp(row.submittedAt, '提交时间'),
    answers: given,
  };
}

function normalizeExact(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function sameWorkbookJson(left: unknown, right: unknown): boolean {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      return '{' + Object.keys(row).sort().map((key) =>
        JSON.stringify(key) + ':' + canonical(row[key]),
      ).join(',') + '}';
    }
    return JSON.stringify(value);
  }
  return canonical(left) === canonical(right);
}

export function gradeWorkbook(
  paper: WorkbookPaper,
  input: unknown,
): { answers: Record<string, WorkbookAnswer>; feedback: WorkbookFeedback[] } {
  const row = record(input);
  const byId = new Map(paper.questions.map((question) => [question.id, question]));
  for (const key of Object.keys(row)) {
    if (!byId.has(key)) throw new Error('作答与这份试卷不匹配。');
  }
  const answers: Record<string, WorkbookAnswer> = {};
  const feedback: WorkbookFeedback[] = [];
  paper.questions.forEach((question, index) => {
    const raw = row[question.id] ?? null;
    if (raw !== null && typeof raw !== 'string') throw new Error(`第 ${index + 1} 题作答格式无效。`);
    const trimmed = raw === null ? null : raw.trim() || null;
    if (question.kind === 'numeric') {
      let answer: number | null = null;
      if (trimmed !== null) {
        const parsed = Number(trimmed.normalize('NFKC'));
        if (!Number.isFinite(parsed)) throw new Error(`第 ${index + 1} 题需要一个数字。`);
        answer = parsed === 0 ? 0 : parsed;
      }
      const result = answer === null
        ? 'unanswered'
        : Math.abs(answer - question.answer) <= question.tolerance
          ? 'correct'
          : 'incorrect';
      answers[question.id] = answer;
      feedback.push({
        questionId: question.id,
        result,
        answer,
        expected: {
          kind: 'numeric',
          value: question.answer,
          tolerance: question.tolerance,
          unit: question.unit,
        },
        explanation: question.explanation,
      });
      return;
    }
    const answer = trimmed;
    const result = answer === null
      ? 'unanswered'
      : question.selfCheck
        ? 'self-check'
        : question.answers.some((expected) => normalizeExact(expected) === normalizeExact(answer))
          ? 'correct'
          : 'incorrect';
    answers[question.id] = answer;
    feedback.push({
      questionId: question.id,
      result,
      answer,
      expected: { kind: 'exact', values: [...question.answers] },
      explanation: question.explanation,
    });
  });
  if (feedback.every(({ result }) => result === 'unanswered')) {
    throw new Error('请至少作答一题再交卷。');
  }
  return { answers, feedback };
}

function parsedAnswer(question: WorkbookQuestion, value: unknown, index: number): WorkbookAnswer {
  if (value === null) return null;
  if (question.kind === 'numeric') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`第 ${index + 1} 题归档答案无效。`);
    }
    return value === 0 ? 0 : value;
  }
  if (typeof value !== 'string') throw new Error(`第 ${index + 1} 题归档答案无效。`);
  return value;
}

function storedExpected(
  question: WorkbookQuestion,
  value: unknown,
  index: number,
): WorkbookExpected {
  const row = record(value);
  if (question.kind === 'numeric') {
    if (
      row.kind !== 'numeric' ||
      typeof row.value !== 'number' ||
      !Number.isFinite(row.value) ||
      typeof row.tolerance !== 'number' ||
      !Number.isFinite(row.tolerance) ||
      row.tolerance < 0
    ) {
      throw new Error(`第 ${index + 1} 题归档参考答案无效。`);
    }
    return {
      kind: 'numeric',
      value: row.value,
      tolerance: row.tolerance,
      unit: optionalText(row.unit, `第 ${index + 1} 题归档单位`, 40),
    };
  }
  if (row.kind !== 'exact' || !Array.isArray(row.values) || row.values.length === 0) {
    throw new Error(`第 ${index + 1} 题归档参考答案无效。`);
  }
  return {
    kind: 'exact',
    values: row.values.map((entry, answerIndex) =>
      text(entry, `第 ${index + 1} 题第 ${answerIndex + 1} 条参考答案`, 500),
    ),
  };
}

export function workbookAttempt(input: unknown): WorkbookAttempt {
  const row = record(input);
  const pap = workbookPaper(row.paper);
  const paperId = factId(String(row.paperId));
  const requestId = workbookRequestId(row.requestId);
  const submittedAt = timestamp(row.submittedAt, '提交时间');
  if (row.gradingVersion !== workbookGradingVersion) throw new Error('这份作答的判分版本不被识别。');
  const storedAnswers = record(row.answers);
  const storedKeys = new Set(Object.keys(storedAnswers));
  if (
    storedKeys.size !== pap.questions.length ||
    !pap.questions.every((question) => storedKeys.has(question.id))
  ) {
    throw new Error('归档作答与试卷不匹配。');
  }
  const answers = Object.fromEntries(pap.questions.map((question, index) => [
    question.id,
    parsedAnswer(question, storedAnswers[question.id] ?? null, index),
  ])) as Record<string, WorkbookAnswer>;
  if (!Array.isArray(row.feedback) || row.feedback.length !== pap.questions.length) {
    throw new Error('归档反馈与题目不匹配。');
  }
  const feedbackById = new Map<string, WorkbookFeedback>();
  row.feedback.forEach((entry, index) => {
    const item = record(entry);
    const questionId = item.questionId;
    if (typeof questionId !== 'string') throw new Error('归档反馈缺少题目标识。');
    const question = pap.questions.find((candidate) => candidate.id === questionId);
    if (!question) throw new Error('归档反馈与题目不匹配。');
    const result = item.result;
    if (
      result !== 'correct' &&
      result !== 'incorrect' &&
      result !== 'unanswered' &&
      result !== 'self-check'
    ) {
      throw new Error('归档反馈结果无效。');
    }
    const answer = parsedAnswer(question, item.answer, index);
    if (!sameWorkbookJson(answer, answers[question.id])) {
      throw new Error('归档反馈与作答不匹配。');
    }
    if (answer === null && result !== 'unanswered') {
      throw new Error('归档反馈与作答不匹配。');
    }
    if (answer !== null && result === 'unanswered') {
      throw new Error('归档反馈与作答不匹配。');
    }
    if (question.kind === 'exact' && question.selfCheck && answer !== null && result !== 'self-check') {
      throw new Error('归档自评题不应被系统判分。');
    }
    if ((question.kind === 'numeric' || !question.selfCheck) && result === 'self-check') {
      throw new Error('归档反馈结果无效。');
    }
    const expected = storedExpected(question, item.expected, index);
    if (feedbackById.has(questionId)) throw new Error('归档反馈题目重复。');
    feedbackById.set(questionId, {
      questionId,
      result,
      answer,
      expected,
      explanation: optionalText(item.explanation, `第 ${index + 1} 题归档解析`, 4000),
    });
  });
  const feedback = pap.questions.map((question) => {
    const item = feedbackById.get(question.id);
    if (!item) throw new Error('归档反馈与题目不匹配。');
    return item;
  });
  return {
    paperId,
    requestId,
    submittedAt,
    gradingVersion: workbookGradingVersion,
    paper: pap,
    answers,
    feedback,
  };
}

export function workbookQuestionView(question: WorkbookQuestion): WorkbookQuestionView {
  return question.kind === 'numeric'
    ? { id: question.id, kind: 'numeric', prompt: question.prompt, unit: question.unit }
    : { id: question.id, kind: 'exact', prompt: question.prompt, selfCheck: question.selfCheck };
}

export function workbookQuestionsView(paper: WorkbookPaper): WorkbookQuestionView[] {
  return paper.questions.map(workbookQuestionView);
}

export function workbookCorrectCount(feedback: readonly WorkbookFeedback[]): number {
  return feedback.filter(({ result }) => result === 'correct').length;
}
