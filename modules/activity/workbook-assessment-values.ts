import type { FactId, Json, JsonObject, Revision } from '@mangekyo/kernel';
import {
  assessmentRelease, type AssessmentCriterion, type AssessmentCriterionOutcome, type AssessmentRelease,
  type AssessmentResult, type AssessmentRevisionRef,
} from './assessment-values.ts';
import {
  sameWorkbookJson, workbookCorrectCount, type WorkbookAttempt, type WorkbookAttemptView, type WorkbookDraft,
  type WorkbookRubricAssessmentView,
} from './workbook-values.ts';

export const workbookTextEvaluator = { id: 'workbook-text-rubric', version: '1' } as const;

export type WorkbookEvaluation = {
  outcome: AssessmentCriterionOutcome;
  receipt?: { effectId: string; routeId: string; reportedModel?: string; quote?: string };
};

export function sameAssessmentRef(actual: AssessmentRevisionRef | undefined, expected: AssessmentRevisionRef) {
  return actual?.id === expected.id && actual.rev === expected.rev;
}

export function workbookAttemptView(id: string, attempt: WorkbookAttempt, assessments: WorkbookRubricAssessmentView[],
  formal?: AssessmentResult): WorkbookAttemptView {
  const bank = new Set(attempt.paper.questions.filter(question => question.kind === 'bank').map(question => question.id));
  const feedback = attempt.feedback.map(item => {
    if (item.result === 'unanswered') return { ...item, expected: null, explanation: null };
    if (item.result !== 'pending' || !bank.has(item.questionId) || !formal) return item;
    const outcomes = formal.outcomes.filter(outcome => outcome.itemId === item.questionId);
    const criteria = attempt.paper.assessmentRelease?.items.find(({ itemId }) => itemId === item.questionId)?.criteria;
    if (!criteria || outcomes.length !== criteria.length || outcomes.some(outcome => outcome.state !== 'scored')) return item;
    const total = criteria.reduce((sum, criterion) => sum + (criterion.maximum ?? 0), 0);
    const earned = outcomes.reduce((sum, outcome) => sum + (outcome.state === 'scored' ? outcome.earned : 0), 0);
    return { ...item, result: earned === total ? 'correct' as const : earned > 0 ? 'partial' as const : 'incorrect' as const };
  });
  return {
    id, requestId: attempt.requestId, submittedAt: attempt.submittedAt, gradingVersion: attempt.gradingVersion,
    ...(attempt.effectiveDurationMs === undefined ? {} : { effectiveDurationMs: attempt.effectiveDurationMs }),
    answers: attempt.answers, feedback, assessments, correctCount: workbookCorrectCount(feedback),
    total: attempt.paper.questions.filter(question => question.kind === 'bank'
      ? feedback.some(item => item.questionId === question.id && ['correct','partial','incorrect'].includes(item.result))
      : question.kind !== 'rubric' && (question.kind !== 'exact' || !question.selfCheck)).length,
  };
}

export function prepareWorkbookRelease(value: unknown, paperId: FactId, draft: WorkbookDraft,
  digest: (text: string) => string): AssessmentRelease {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('冻结发放格式无效。');
  const releaseRef = { id: paperId, rev: 1 as Revision };
  const release = assessmentRelease({ releaseRef, ...value });
  if (!sameAssessmentRef(release.releaseRef, releaseRef)) throw new Error('冻结发放须引用本次保存的试卷修订。');
  const items = release.items.map(item => {
    const index = draft.questions.findIndex(({ id }) => id === item.itemId);
    const question = draft.questions[index];
    const slot = item.slots[0];
    if (question?.kind !== 'rubric' || !sameAssessmentRef(item.promptRef, releaseRef) || item.workRef ||
        item.slots.length !== 1 || slot?.fields.length !== 1 ||
        slot.fields[0]?.kind !== 'text' || slot.fields[0]?.path !== '') {
      throw new Error('该发放入口仅支持引用本卷题面的单文字作答位评分标准题。');
    }
    const criteria = item.criteria.map(criterion => {
      const provided = criterion.parameters as JsonObject | null;
      const routeId = provided?.routeId;
      if (criterion.inputs.length !== 1 || !sameAssessmentRef(criterion.source.ref, releaseRef) ||
          criterion.source.kind !== 'product-rubric' || criterion.source.path !== '/questions/' + index + '/rubric' ||
          typeof routeId !== 'string' || !/^[a-zA-Z0-9_./:@-]{1,128}$/.test(routeId)) {
        throw new Error('评估标准须绑定本题的产品评分标准、唯一作答位及版本化评估路由。');
      }
      const parameters = { routeId, promptSha256: digest(question.prompt), rubricSha256: digest(question.rubric) };
      if (!sameWorkbookJson(provided, { routeId }) && !sameWorkbookJson(provided, parameters))
        throw new Error('评估参数与本次保存的题面或评分标准不匹配。');
      return { ...criterion, parameters };
    });
    return { ...item, criteria };
  });
  return { ...release, items };
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit &&
    value.isWellFormed() && !value.includes('\u0000');
}

export function boundedWorkbookReply(value: Json): Json {
  const reply = value as JsonObject | null;
  if (!reply || !text(reply.reportedModel, 256)) return null;
  const { state, reportedModel, feedback, quote, earned } = reply;
  if (state === 'insufficient-evidence') return { state, reportedModel };
  if (!text(feedback, 1500) || !text(quote, 500)) return null;
  if (state === 'qualitative') return { state, reportedModel, feedback, quote };
  if (state === 'scored' && typeof earned === 'number' && Number.isFinite(earned)) return { state, reportedModel, feedback, quote, earned };
  return null;
}

export function workbookEvaluation(
  key: { itemId: string; criterionId: string },
  criterion: AssessmentCriterion,
  answer: string,
  routeId: string,
  effect: { kind: 'unknown'; providerEffectId: string | null } | { kind: 'done'; result: Json },
): WorkbookEvaluation {
  if (effect.kind === 'unknown') {
    return {
      outcome: { ...key, state: 'failed', reason: '评估请求结果及费用待核对，已停止重发。' },
      ...(effect.providerEffectId ? { receipt: { effectId: effect.providerEffectId, routeId } } : {}),
    };
  }
  const receipt = effect.result as { providerEffectId: string; denied: boolean; result: unknown };
  const trace = { effectId: receipt.providerEffectId, routeId };
  if (receipt.denied) return { outcome: { ...key, state: 'blocked', reason: '自动评估额度不足。' }, receipt: trace };
  const reply = receipt.result as { state?: unknown; feedback?: unknown; quote?: unknown; earned?: unknown; reportedModel?: unknown } | null;
  if (reply && text(reply.reportedModel, 256)) {
    const observed = { ...trace, reportedModel: reply.reportedModel };
    if (reply.state === 'insufficient-evidence') {
      return { outcome: { ...key, state: 'insufficient-evidence', reason: '作答无法支持该标准的正式判断。' }, receipt: observed };
    }
    if (text(reply.feedback, 1500) && text(reply.quote, 500) && answer.includes(reply.quote)) {
      const evidence = criterion.inputs;
      const verified = { ...observed, quote: reply.quote };
      if (reply.state === 'qualitative' && criterion.maximum === null) {
        return { outcome: { ...key, state: 'qualitative', feedback: reply.feedback, evidence }, receipt: verified };
      }
      if (reply.state === 'scored' && criterion.maximum !== null && typeof reply.earned === 'number' &&
          Number.isFinite(reply.earned) && reply.earned >= 0 && reply.earned <= criterion.maximum) {
        return { outcome: { ...key, state: 'scored', earned: reply.earned, feedback: reply.feedback, evidence }, receipt: verified };
      }
    }
  }
  return { outcome: { ...key, state: 'failed', reason: '评估结论、分值或引文无法与冻结标准和作答核对。' }, receipt: trace };
}
