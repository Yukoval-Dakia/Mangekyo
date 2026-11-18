import type { PracticeView } from '../../modules/activity/practice-values.ts';

export type ReviewEntry = {
  paperId: string;
  title: string;
  questionId: string;
  prompt: string;
  answer: string;
  expected: string;
  explanation: string | null;
};

export function ridingReview(practice: PracticeView): ReviewEntry[] {
  const entries = new Map<string, ReviewEntry>();
  for (const attempt of practice.history) {
    for (const feedback of attempt.feedback) {
      const question = attempt.paper.questions.find(q => q.id === feedback.questionId);
      if (!question || feedback.result === 'unanswered') continue;
      if (feedback.result === 'correct') entries.delete(question.id);
      else entries.set(question.id, { paperId: 'riding', title: attempt.paper.title,
        questionId: question.id, prompt: question.prompt, answer: String(feedback.answer),
        expected: feedback.expected + ' ' + question.unit, explanation: feedback.explanation });
    }
  }
  return [...entries.values()];
}
