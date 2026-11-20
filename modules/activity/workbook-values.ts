import { factId } from '@mangekyo/kernel';
import type { Revision } from '@mangekyo/kernel';
import { assessmentRelease, type AssessmentRelease } from './assessment-values.ts';

const pinnedPromptLimit = 8000;
const pinnedAnswerLimit = 4000;

export class WorkbookSourceMismatch extends Error {}

export const workbookPaperType = 'activity.workbookPaper';
export const workbookAttemptType = 'activity.workbookAttempt';
export const workbookResearchPurpose = 'background-research';
export const setWorkbookResearchUse = 'activity.setWorkbookResearchUse';
export const workbookRubricAssessmentType = 'activity.workbookRubricAssessment';
export const workbookFormalAssessmentType = 'activity.workbookFormalAssessment';
export const saveWorkbookPaperCommand = 'activity.saveWorkbookPaper';
export const submitWorkbookAttemptCommand = 'activity.submitWorkbookAttempt';
export const workbookGradingVersion = 'workbook-v1';
export const workbookRubricGradingVersion = 'workbook-v2';
export const workbookRubricVersion = 'rubric-v1';
export const workbookRubricAssessmentVersion = 'workbook-rubric-assessment-v1';
export const workbookAssessmentConsent = 'send-question-answer-rubric';
export const workbookAssessmentPurpose = 'workbook-assessment';

const requestPattern = /^[A-Za-z0-9_-]{8,100}$/;
const questionIdPattern = /^[A-Za-z0-9_-]{1,40}$/;
const rubricVersionPattern = /^rubric-v[1-9][0-9]{0,3}$/;
const maxQuestions = 100;

export type WorkbookSourceQuestionRef = {
  readonly id: string;
  readonly rev: Revision;
};

export type WorkbookNumericQuestion = {
  id: string;
  kind: 'numeric';
  prompt: string;
  answer: number;
  tolerance: number;
  unit: string | null;
  explanation: string | null;
  sourceQuestionRef?: WorkbookSourceQuestionRef;
};

export type WorkbookExactQuestion = {
  id: string;
  kind: 'exact';
  prompt: string;
  answers: string[];
  selfCheck: boolean;
  explanation: string | null;
  sourceQuestionRef?: WorkbookSourceQuestionRef;
};

export type WorkbookRubricQuestion = {
  id: string;
  kind: 'rubric';
  prompt: string;
  rubric: string;
  rubricVersion: string;
  explanation: string | null;
  sourceQuestionRef?: WorkbookSourceQuestionRef;
};

export type WorkbookQuestion =
  | WorkbookNumericQuestion
  | WorkbookExactQuestion
  | WorkbookRubricQuestion;

function sourceQuestionRef(value: unknown): WorkbookSourceQuestionRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('来源题目引用必须是 {id, rev}。');
  }
  const row = value as Record<string, unknown>;
  if (row.id === undefined || row.rev === undefined) {
    throw new Error('来源题目引用必须是 {id, rev}。');
  }
  if (typeof row.id !== 'string' || !row.id) throw new Error('来源题目标识无效。');
  if (typeof row.rev !== 'number' || !Number.isSafeInteger(row.rev) || row.rev < 1 || row.rev > 2_147_483_647) {
    throw new Error('来源题目版本无效。');
  }
  try {
    return { id: factId(row.id), rev: row.rev as Revision };
  } catch {
    throw new Error('来源题目标识无效。');
  }
}

export type WorkbookPaper = {
  title: string;
  materialId: string | null;
  savedAt: string;
  questions: WorkbookQuestion[];
  assessmentRelease?: AssessmentRelease;
};

export type WorkbookQuestionDraft = { sourceQuestionRef?: WorkbookSourceQuestionRef } & (
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
  }
  | {
    kind: 'rubric';
    prompt: string;
    rubric: string;
    explanation?: string | null;
  });

export type WorkbookDraft = {
  title: string;
  materialId: string | null;
  questions: WorkbookQuestion[];
};

export type WorkbookAnswer = number | string | null;

export type WorkbookExpected =
  | { kind: 'numeric'; value: number; tolerance: number; unit: string | null }
  | { kind: 'exact'; values: string[] }
  | { kind: 'rubric'; rubric: string; rubricVersion: string };

export type WorkbookFeedback = {
  questionId: string;
  result: 'correct' | 'incorrect' | 'partial' | 'pending' | 'unanswered' | 'self-check';
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
  effectiveDurationMs?: number;
  assessmentConsent?: typeof workbookAssessmentConsent;
};

export type WorkbookAttemptRequest = {
  paperId: string;
  requestId: string;
  submittedAt: string;
  answers: Record<string, string | null>;
  effectiveDurationMs?: number;
  assessmentConsent?: typeof workbookAssessmentConsent;
};

export type WorkbookQuestionView =
  | {
    id: string;
    kind: 'numeric';
    prompt: string;
    unit: string | null;
    sourceQuestionRef?: WorkbookSourceQuestionRef;
  }
  | {
    id: string;
    kind: 'exact';
    prompt: string;
    selfCheck: boolean;
    sourceQuestionRef?: WorkbookSourceQuestionRef;
  }
  | {
    id: string;
    kind: 'rubric';
    prompt: string;
    rubricVersion: string;
    sourceQuestionRef?: WorkbookSourceQuestionRef;
  };

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
  gradingVersion: string;
  answers: Record<string, WorkbookAnswer>;
  effectiveDurationMs?: number;
  feedback: (Omit<WorkbookFeedback, 'expected'> & { expected: WorkbookExpected | null })[];
  assessments: WorkbookRubricAssessmentView[];
  correctCount: number;
  total: number;
};

export type WorkbookAssessmentVerdict = 'correct' | 'partial' | 'incorrect' | 'pending';

export type WorkbookRubricAssessment = {
  attemptId: string;
  paperId: string;
  questionId: string;
  requestId: string;
  assessedAt: string;
  assessmentVersion: string;
  consent?: typeof workbookAssessmentConsent;
  publicSearchQuery?: string;
  rubricVersion: string;
  rubric: string;
  providerBaseUrl: string;
  requestedModel?: string;
  providerId?: string;
  providerProtocol?: string;
  verdict: WorkbookAssessmentVerdict;
  score?: { earned: number; maximum: number };
  feedback: string;
  evidence: string[];
  trace: string[];
  reportedModel?: string;
};

export type WorkbookRubricAssessmentView = WorkbookRubricAssessment & { id: string };

export type WorkbookAssessmentRequest = {
  requestId: string;
  questionId: string;
  consent: typeof workbookAssessmentConsent;
  publicSearchQuery?: string;
  providerBaseUrl: string;
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

function text(value: unknown, label: string, limit: number, preserveWhitespace = false): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文字。`);
  const result = preserveWhitespace ? value : value.trim();
  if (!result.trim() || result.length > limit || !canStore(result)) {
    throw new Error(`${label}长度无效。`);
  }
  return result;
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

function alternatives(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('精确答案至少需要一条，最多二十条。');
  }
  const seen = new Set<string>();
  const answers = value.map((entry, index) => {
    const answer = text(entry, `第 ${index + 1} 条精确答案`, limit);
    const key = normalizeExact(answer);
    if (seen.has(key)) throw new Error('精确答案不能重复。');
    seen.add(key);
    return answer;
  });
  return answers;
}

function draftQuestion(value: unknown, index: number, stored = false): WorkbookQuestion {
  const row = record(value);
  const kind = row.kind;
  const source = sourceQuestionRef(row.sourceQuestionRef);
  const prompt = text(row.prompt, `第 ${index + 1} 题题面`, source ? pinnedPromptLimit : 4000, !!source);
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
      ...(source === undefined ? {} : { sourceQuestionRef: source }),
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
      answers: alternatives(row.answers, source ? pinnedAnswerLimit : 500),
      selfCheck: row.selfCheck === true,
      explanation,
      ...(source === undefined ? {} : { sourceQuestionRef: source }),
    };
  }
  if (kind === 'rubric') {
    if (stored) {
      if (typeof row.rubricVersion !== 'string' || !rubricVersionPattern.test(row.rubricVersion)) {
        throw new Error(`第 ${index + 1} 题评分标准版本无效。`);
      }
    } else if (row.rubricVersion !== undefined && row.rubricVersion !== workbookRubricVersion) {
      throw new Error(`第 ${index + 1} 题评分标准版本无效。`);
    }
    return {
      id,
      kind,
      prompt,
      rubric: text(row.rubric, `第 ${index + 1} 题评分标准`, 8000),
      rubricVersion: stored ? String(row.rubricVersion) : workbookRubricVersion,
      explanation,
      ...(source === undefined ? {} : { sourceQuestionRef: source }),
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
  }, index, true);
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
    questions: questions.map((question, index) => draftQuestion(question, index)),
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
    ...(row.assessmentRelease === undefined ? {} : { assessmentRelease: assessmentRelease(row.assessmentRelease) }),
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
    ...effectiveDuration(row.effectiveDurationMs),
    ...assessmentConsent(row.assessmentConsent),
  };
}

function effectiveDuration(value: unknown): Pick<WorkbookAttemptRequest, 'effectiveDurationMs'> {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1000) {
    throw new Error('有效用时须为 1 毫秒至 24 小时之间的整数毫秒。');
  }
  return { effectiveDurationMs: value };
}

function assessmentConsent(value: unknown): Pick<WorkbookAttemptRequest, 'assessmentConsent'> {
  if (value === undefined) return {};
  if (value !== workbookAssessmentConsent) throw new Error('自动评阅授权格式无效。');
  return { assessmentConsent: value };
}

export function workbookAssessmentRequest(input: unknown): WorkbookAssessmentRequest {
  const row = record(input);
  if (row.consent !== workbookAssessmentConsent) {
    throw new Error('请明确同意本次评分标准批改。');
  }
  const questionId = row.questionId;
  if (typeof questionId !== 'string' || !questionIdPattern.test(questionId)) {
    throw new Error('题目标识无效。');
  }
  return {
    requestId: workbookRequestId(row.requestId),
    questionId,
    consent: workbookAssessmentConsent,
    ...(row.publicSearchQuery ? {publicSearchQuery: text(row.publicSearchQuery, '公开检索词', 400)} : {}),
    providerBaseUrl: text(row.providerBaseUrl, '模型端点', 2000),
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
    if (question.kind === 'rubric') {
      const answer = trimmed;
      answers[question.id] = answer;
      feedback.push({
        questionId: question.id,
        result: answer === null ? 'unanswered' : 'pending',
        answer,
        expected: {
          kind: 'rubric',
          rubric: question.rubric,
          rubricVersion: question.rubricVersion,
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
    if (
      row.kind !== 'rubric' ||
      typeof row.rubric !== 'string' ||
      typeof row.rubricVersion !== 'string' ||
      !rubricVersionPattern.test(row.rubricVersion)
    ) {
      throw new Error(`第 ${index + 1} 题归档参考答案无效。`);
    }
    return {
      kind: 'rubric',
      rubric: text(row.rubric, `第 ${index + 1} 题归档评分标准`, 8000),
      rubricVersion: row.rubricVersion,
    };
  }
  return {
    kind: 'exact',
    values: row.values.map((entry, answerIndex) =>
      text(entry, `第 ${index + 1} 题第 ${answerIndex + 1} 条参考答案`, question.sourceQuestionRef ? pinnedAnswerLimit : 500),
    ),
  };
}

export function workbookAttempt(input: unknown): WorkbookAttempt {
  const row = record(input);
  const pap = workbookPaper(row.paper);
  const paperId = factId(String(row.paperId));
  const requestId = workbookRequestId(row.requestId);
  const submittedAt = timestamp(row.submittedAt, '提交时间');
  if (
    row.gradingVersion !== workbookGradingVersion &&
    row.gradingVersion !== workbookRubricGradingVersion
  ) {
    throw new Error('这份作答的判分版本不被识别。');
  }
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
      result !== 'partial' &&
      result !== 'pending' &&
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
    if (question.kind === 'rubric' && result !== (answer === null ? 'unanswered' : 'pending')) {
      throw new Error('归档评分标准题应保持待评估。');
    }
    if (
      (question.kind === 'numeric' ||
        (question.kind === 'exact' && !question.selfCheck) ||
        (question.kind === 'exact' && question.selfCheck && result === 'partial')) &&
      (result === 'self-check' || result === 'partial' || result === 'pending')
    ) {
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
    gradingVersion: row.gradingVersion,
    paper: pap,
    answers,
    feedback,
    ...effectiveDuration(row.effectiveDurationMs),
    ...assessmentConsent(row.assessmentConsent),
  };
}

export function workbookQuestionView(question: WorkbookQuestion): WorkbookQuestionView {
  const base = { id: question.id, prompt: question.prompt };
  const source = question.sourceQuestionRef;
  const ref = source === undefined ? {} : { sourceQuestionRef: source };
  if (question.kind === 'numeric') {
    return { ...base, kind: 'numeric', unit: question.unit, ...ref };
  }
  if (question.kind === 'exact') {
    return { ...base, kind: 'exact', selfCheck: question.selfCheck, ...ref };
  }
  return { ...base, kind: 'rubric', rubricVersion: question.rubricVersion, ...ref };
}

export function workbookQuestionsView(paper: WorkbookPaper): WorkbookQuestionView[] {
  return paper.questions.map(workbookQuestionView);
}

export function workbookCorrectCount(feedback: readonly WorkbookFeedback[]): number {
  return feedback.filter(({ result }) => result === 'correct').length;
}

function verdict(value: unknown): WorkbookAssessmentVerdict {
  if (value === 'correct' || value === 'partial' || value === 'incorrect' || value === 'pending') {
    return value;
  }
  throw new Error('评分标准批改结果无效。');
}

function stringList(value: unknown, label: string, limit = 40, length = 4000): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label}格式无效。`);
  return value.map((entry, index) => text(entry, `${label}第 ${index + 1} 项`, length));
}

export function workbookAssessmentResult(input: unknown): {
  verdict: WorkbookAssessmentVerdict;
  score?: { earned: number; maximum: number };
  feedback: string;
  evidence: string[];
  trace: string[];
  reportedModel?: string;
} {
  const row = record(input);
  const reportedModel = optionalText(row.reportedModel, '模型标识', 240);
  const score = row.score === undefined ? undefined : record(row.score);
  if (score && (typeof score.earned !== 'number' || typeof score.maximum !== 'number' ||
      !Number.isFinite(score.earned) || !Number.isFinite(score.maximum) || score.maximum <= 0 || score.earned < 0 || score.earned > score.maximum)) {
    throw new Error('批改得分无效。');
  }
  return {
    verdict: verdict(row.verdict),
    ...(score ? {score: {earned: Number(score.earned), maximum: Number(score.maximum)}} : {}),
    feedback: text(row.feedback, '批改说明', 8000),
    evidence: stringList(row.evidence, '批改依据'),
    trace: stringList(row.trace, '工具轨迹'),
    ...(reportedModel === null ? {} : { reportedModel }),
  };
}

export function workbookRubricAssessment(input: unknown): WorkbookRubricAssessment {
  const row = record(input);
  if (row.assessmentVersion !== workbookRubricAssessmentVersion) {
    throw new Error('评分标准批改版本不被识别。');
  }
  if (typeof row.rubricVersion !== 'string' || !rubricVersionPattern.test(row.rubricVersion)) {
    throw new Error('评分标准版本无效。');
  }
  return {
    attemptId: factId(String(row.attemptId)),
    paperId: factId(String(row.paperId)),
    questionId: text(row.questionId, '题目标识', 40),
    requestId: workbookRequestId(row.requestId),
    assessedAt: timestamp(row.assessedAt, '批改时间'),
    assessmentVersion: workbookRubricAssessmentVersion,
    rubricVersion: row.rubricVersion,
    rubric: text(row.rubric, '评分标准', 8000),
    providerBaseUrl: text(row.providerBaseUrl, '模型端点', 2000),
    ...(row.requestedModel ? {requestedModel: text(row.requestedModel, '请求模型', 256)} : {}),
    ...(row.providerId ? {providerId: text(row.providerId, '模型配置', 160)} : {}),
    ...(row.providerProtocol ? {providerProtocol: text(row.providerProtocol, '模型协议', 30)} : {}),
    ...(row.consent === workbookAssessmentConsent ? {consent: workbookAssessmentConsent} : {}),
    ...(row.publicSearchQuery ? {publicSearchQuery: text(row.publicSearchQuery, '公开检索词', 400)} : {}),
    ...workbookAssessmentResult(row),
  };
}
