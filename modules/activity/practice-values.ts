import { averageSpeed } from './starter.ts';
import { recordParser, textValue } from './validation.ts';

const firstRide = { distance: 12, moving: 40, stopped: 10 };
const secondRide = { distance: 9, moving: 30, target: 12 };
const firstElapsed = firstRide.moving + firstRide.stopped;
const secondElapsed = (secondRide.distance * 60) / secondRide.target;

const exercises = [
  {
    id: 'moving', prompt: `骑行 ${firstRide.distance} 公里，移动了 ${firstRide.moving} 分钟。只统计移动时间，平均速度是多少？`,
    unit: '公里/小时', expected: averageSpeed(firstRide.distance, firstRide.moving),
    explanation: `分母是 ${firstRide.moving} 分钟。把分钟换算成小时，再用 ${firstRide.distance} ÷ (${firstRide.moving} ÷ 60)。`,
  },
  {
    id: 'elapsed', prompt: `同一趟骑行，中途还停了 ${firstRide.stopped} 分钟。从出发到到达的平均速度是多少？`, unit: '公里/小时',
    expected: averageSpeed(firstRide.distance, firstElapsed),
    explanation: `从出发到到达经过 ${firstRide.moving} + ${firstRide.stopped} = ${firstElapsed} 分钟，路程仍是 ${firstRide.distance} 公里。算式是 ${firstRide.distance} ÷ (${firstElapsed} ÷ 60)。`,
  },
  {
    id: 'target',
    prompt: `另一趟骑行走了 ${secondRide.distance} 公里，移动了 ${secondRide.moving} 分钟。如果全程平均速度恰好是 ${secondRide.target} 公里/小时，停了多久？`,
    unit: '分钟', expected: secondElapsed - secondRide.moving,
    explanation: `先用路程除以目标均速，得到全程时间 ${secondRide.distance} ÷ ${secondRide.target} 小时，换算为 ${secondElapsed} 分钟。再减去 ${secondRide.moving} 分钟移动时间。`,
  },
] as const;

type Question = { id: string; prompt: string; unit: string };
type Paper = { version: string; title: string; questions: Question[] };
type Feedback = {
  questionId: string; answer: number | null; result: 'correct' | 'incorrect' | 'unanswered'; expected: number;
  explanation: string;
};

export const ridingPaper: Paper = {
  version: 'riding-v1', title: '骑行均速小卷',
  questions: exercises.map(({ id, prompt, unit }) => ({ id, prompt, unit })),
};

export const ridingPracticePurpose = 'practice';
export const ridingPracticeType = 'activity.practiceSubmission';
export const ridingPracticeCommand = 'activity.submitPractice';

export type PracticeSubmission = { paper: Paper; feedback: Feedback[] };
export type PracticeAttempt = PracticeSubmission & { id: string };
export type PracticeView = { paper: Paper; submission: PracticeAttempt | null; history: PracticeAttempt[] };
export type PracticeAnswers = Record<string, number | null>;
export type PracticeInput = { version: string; answers: PracticeAnswers };

const record = recordParser(() => new Error('请提交有效的练习记录。'));
const text = (value: unknown): string =>
  textValue(value, () => new Error('练习记录缺少文字字段。'), { preserveWhitespace: true, storable: false });

function quantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('答案须为大于等于零的数字。');
  return value === 0 ? 0 : value;
}

export function practiceInput(value: unknown, paper = ridingPaper): PracticeInput {
  const { version, answers } = record(value);
  if (version !== paper.version) throw new Error('请重新打开当前小卷。');
  const given = record(answers);
  if (Object.keys(given).length !== paper.questions.length)
    throw new Error('提交的题目与小卷不匹配。');
  const entries = paper.questions.map(({ id }) => [id, given[id] === null ? null : quantity(given[id])] as const);
  if (entries.every(([, value]) => value === null)) throw new Error('请至少作答一题再交卷。');
  return { version, answers: Object.fromEntries(entries) };
}

function resultOf(answer: number | null, expected: number): Feedback['result'] {
  if (answer === null) return 'unanswered';
  return answer === expected ? 'correct' : 'incorrect';
}

export function gradePractice({ answers }: PracticeInput): PracticeSubmission {
  return {
    paper: ridingPaper,
    feedback: exercises.map(({ id, expected, explanation }) => {
      const answer = answers[id] ?? null;
      return { questionId: id, answer, expected, explanation, result: resultOf(answer, expected) };
    }),
  };
}

export function practiceSubmission(value: unknown): PracticeSubmission {
  const archived = record(value);
  const { version, title, questions } = record(archived.paper);
  if (!Array.isArray(questions) || questions.length === 0 || !Array.isArray(archived.feedback) ||
      archived.feedback.length !== questions.length) {
    throw new Error('练习归档与题目不匹配。');
  }
  const paper: Paper = {
    version: text(version), title: text(title),
    questions: questions.map((value: unknown) => {
      const { id, prompt, unit } = record(value);
      return { id: text(id), prompt: text(prompt), unit: text(unit) };
    }),
  };
  const feedback = archived.feedback.map((value: unknown, index): Feedback => {
    const row = record(value);
    const questionId = text(row.questionId);
    const answer = row.answer === null ? null : quantity(row.answer);
    const expected = quantity(row.expected);
    const result = resultOf(answer, expected);
    if (questionId !== paper.questions[index]?.id || row.result !== result)
      throw new Error('练习反馈与题目不匹配。');
    return { questionId, answer, expected, result, explanation: text(row.explanation) };
  });
  return { paper, feedback };
}
