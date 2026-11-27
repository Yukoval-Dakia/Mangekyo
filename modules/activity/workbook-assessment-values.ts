import { FactNotFoundError, type FactId, type Json, type JsonObject, type ReadContext, type Revision } from '@mangekyo/kernel';
import {
  assessmentRelease, assessmentResult, formalAssessmentValue, formalItemErrorStage, isAssessmentErrorStage,
  type AssessmentErrorStage, type FormalAssessmentValue, type AssessmentCriterion, type AssessmentCriterionOutcome, type AssessmentRelease,
  type AssessmentResult, type AssessmentRevisionRef, type AssessmentSubmission,
} from './assessment-values.ts';
import { readWorkbookQuestionAttachments, type WorkbookAttachmentEvidence } from './workbook-attachments.ts';
import {
  independentlyAuthoredPaper, sameWorkbookJson, workbookAssessmentConsent, workbookAttempt, workbookAttemptType,
  workbookAssessmentPurpose, workbookCorrectCount, workbookPaper, workbookPaperType,
  type WorkbookAttempt, type WorkbookAttemptView, type WorkbookDraft,
  workbookRubricAssessmentVersion, type WorkbookAssessmentRequest, type WorkbookRubricAssessment,
  type WorkbookRubricQuestion, type WorkbookRubricAssessmentView, type WorkbookPaper, type WorkbookSummary, type WorkbookSourceView,
} from './workbook-values.ts';
import formalAssessmentSlot from './slots/workbook-formal-assessment.ts';

import { checkAssessmentPublication, type ReadVerifiedAssessmentPublicationEvidence } from './assessment-publication.ts';
import { frozenWorkbookSubmission } from './question-assessment.ts';
import { isStorable } from './validation.ts';

export const workbookTextEvaluator = { id: 'workbook-text-rubric', version: '1' } as const;
export const workbookAssessmentPolicy = {
  slot: formalAssessmentSlot, deriver: 'activity/workbook-formal-assessment-v1',
  purpose: workbookAssessmentPurpose,
};
export const workbookBankAssessmentPolicy = {
  ...workbookAssessmentPolicy,
  deriver: 'activity/workbook-bank-assessment-v1',
};
export function workbookAssessmentPolicyFor(paper: WorkbookPaper) {
  return paper.questions.some(question => question.kind === 'bank') ? workbookBankAssessmentPolicy : workbookAssessmentPolicy;
}

export function checkWorkbookPublication(paper: WorkbookPaper, evidence?: ReadVerifiedAssessmentPublicationEvidence) {
  const release = paper.assessmentRelease;
  if (!release) return;
  // Bank questions already carry their own verified publication at issuance.
  const items = release.items.filter(item =>
    !paper.questions.some(question => question.id === item.itemId && question.kind === 'bank'));
  if (!items.length) return;
  return checkAssessmentPublication({ ...release, items }, [workbookTextEvaluator], evidence ?? (() => null));
}

export type WorkbookEvaluation = {
  outcome: AssessmentCriterionOutcome;
  receipt?: { effectId: string; routeId: string; reportedModel?: string; quote?: string };
};

export const publicBankAssessment = (value: FormalAssessmentValue) => ({ ...value,
  criteria: value.criteria.map(({ source, ...criterion }) =>
    ({ ...criterion, source: { kind: source.kind, ref: source.ref } })),
});

export function workbookAssessmentValue(
  release: AssessmentRelease, submission: AssessmentSubmission, evaluations: readonly WorkbookEvaluation[],
) {
  const result = assessmentResult({
    releaseRef: release.releaseRef, submissionRef: submission.submissionRef,
    outcomes: evaluations.map(({ outcome }) => outcome),
  }, release, submission);
  const receipts = evaluations.flatMap(({ outcome, receipt }) =>
    receipt ? [{ itemId: outcome.itemId, criterionId: outcome.criterionId, ...receipt }] : []);
  return formalAssessmentValue(release, submission, result, receipts);
}

export function sameAssessmentRef(actual: AssessmentRevisionRef | undefined, expected: AssessmentRevisionRef) {
  return actual?.id === expected.id && actual.rev === expected.rev;
}

/** Full-credit check over a release item's scored criteria and the matching outcomes. */
export function scoredFormalOutcome(
  paper: WorkbookPaper, itemId: string, outcomes: AssessmentResult['outcomes'],
): { earned: number; maximum: number } | undefined {
  const criteria = paper.assessmentRelease?.items.find(item => item.itemId === itemId)
    ?.criteria.filter(criterion => criterion.maximum !== null) ?? [];
  const scored = outcomes.filter((outcome): outcome is Extract<AssessmentCriterionOutcome, { state: 'scored' }> =>
    outcome.itemId === itemId && outcome.state === 'scored');
  const maximum = criteria.reduce((sum, criterion) => sum + criterion.maximum!, 0);
  if (!criteria.length || scored.length !== criteria.length) return undefined;
  return { earned: scored.reduce((sum, outcome) => sum + outcome.earned, 0), maximum };
}

/** Does the stored rubric assessment quote the same answer for this question? */
export function matchingRubricAssessment(
  attempt: WorkbookAttempt, question: WorkbookRubricQuestion, assessment: WorkbookRubricAssessment, attemptId: string,
): assessment is WorkbookRubricAssessment & { verdict: Exclude<WorkbookRubricAssessment['verdict'], 'pending'> } {
  const answer = attempt.answers[question.id];
  return assessment.attemptId === attemptId && assessment.paperId === attempt.paperId &&
    assessment.questionId === question.id && assessment.verdict !== 'pending' &&
    question.rubricVersion === assessment.rubricVersion && question.rubric === assessment.rubric &&
    typeof answer === 'string' && assessment.evidence.length > 0 &&
    assessment.evidence.every(quote => answer.includes(quote));
}

export function formalItemOutcome(
  paper: WorkbookPaper, itemId: string,
  formal?: { state: string; releaseRef: AssessmentRevisionRef; result?: AssessmentResult },
): { readonly result: 'correct' | 'incorrect' | 'unknown'; readonly scoreNorm?: number; readonly errorStage?: AssessmentErrorStage } | undefined {
  const release = paper.assessmentRelease;
  if (!release || !formal || formal.state !== 'complete' || !formal.result || !sameAssessmentRef(release.releaseRef, formal.releaseRef)) return;
  const releaseItem = release.items.find(item => item.itemId === itemId);
  if (!releaseItem) return;
  const scored = scoredFormalOutcome(paper, itemId, formal.result.outcomes);
  if (!scored) return { result: 'unknown' };
  if (scored.maximum <= 0) return;
  if (scored.earned === scored.maximum) return { result: 'correct', scoreNorm: 1 };
  const stage = formalItemErrorStage(formal.result.outcomes, itemId);
  return { result: 'incorrect', scoreNorm: scored.earned / scored.maximum, ...(stage ? { errorStage: stage } : {}) };
}

export function workbookAttemptView(id: string, attempt: WorkbookAttempt, assessments: WorkbookRubricAssessmentView[],
  formal?: AssessmentResult): WorkbookAttemptView {
  const bank = new Set(attempt.paper.questions.filter(question => question.kind === 'bank').map(question => question.id));
  const feedback = attempt.feedback.map(item => {
    const sandboxResult = formal?.outcomes.find(outcome => outcome.itemId === item.questionId &&
      (outcome.state === 'scored' || outcome.state === 'partial') && outcome.sandboxResult !== undefined);
    const sandbox = sandboxResult !== undefined &&
      (sandboxResult.state === 'scored' || sandboxResult.state === 'partial') && sandboxResult.sandboxResult !== undefined
      ? { sandboxResult: sandboxResult.sandboxResult } : {};
    if (item.result === 'unanswered') return { ...item, expected: null, explanation: null, ...sandbox };
    const formalStage = formalItemErrorStage(formal?.outcomes, item.questionId);
    const rubric = assessments.find(value => value.questionId === item.questionId);
    const rubricStage = rubric && (rubric.verdict === 'incorrect' || rubric.verdict === 'partial') ? rubric.errorStage : undefined;
    if (item.result !== 'pending' || !bank.has(item.questionId) || !formal) {
      const stage = item.result === 'correct' ? undefined : formalStage ?? rubricStage;
      const withStage = stage ? { ...item, errorStage: stage } : item;
      return Object.keys(sandbox).length ? { ...withStage, ...sandbox } : withStage;
    }
    const outcomes = formal.outcomes.filter(outcome => outcome.itemId === item.questionId);
    const criteria = attempt.paper.assessmentRelease?.items.find(({ itemId }) => itemId === item.questionId)?.criteria;
    if (!criteria || outcomes.length !== criteria.length || outcomes.some(outcome => outcome.state !== 'scored')) {
      return Object.keys(sandbox).length ? { ...item, ...sandbox } : item;
    }
    const total = criteria.reduce((sum, criterion) => sum + (criterion.maximum ?? 0), 0);
    const earned = outcomes.reduce((sum, outcome) => sum + (outcome.state === 'scored' ? outcome.earned : 0), 0);
    const result = earned === total ? 'correct' as const : earned > 0 ? 'partial' as const : 'incorrect' as const;
    return { ...item, ...(result !== 'correct' && formalStage ? { errorStage: formalStage } : {}), result, ...sandbox };
  });
  return {
    id, requestId: attempt.requestId, submittedAt: attempt.submittedAt, gradingVersion: attempt.gradingVersion,
    ...(attempt.effectiveDurationMs === undefined ? {} : { effectiveDurationMs: attempt.effectiveDurationMs }),
    ...(attempt.paperRev === undefined ? {} : { paperRev: attempt.paperRev }),
    ...(attempt.pacing === undefined ? {} : { pacing: attempt.pacing }),
    ...(attempt.preSubmitRevised ? { preSubmitRevised: true as const } : {}),
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
        !['text', 'attachment'].includes(slot.fields[0]?.kind ?? '') || slot.fields[0]?.path !== '') {
      throw new Error('该发放入口仅支持引用本卷题面的单文字或单附件作答位评分标准题。');
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
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && isStorable(value);
}

export function boundedWorkbookReply(value: Json): Json {
  const reply = value as JsonObject | null;
  if (!reply || !text(reply.reportedModel, 256)) return null;
  const { state, reportedModel, feedback, quote, earned, error_stage } = reply;
  if (error_stage !== undefined && error_stage !== null && !isAssessmentErrorStage(error_stage)) return null;
  const stage = isAssessmentErrorStage(error_stage) ? { error_stage } : {};
  if (state === 'insufficient-evidence') return { state, reportedModel };
  if (!text(feedback, 1500) || !text(quote, 500)) return null;
  if (state === 'qualitative') return { state, reportedModel, feedback, quote, ...stage };
  if (state === 'scored' && typeof earned === 'number' && Number.isFinite(earned)) return { state, reportedModel, feedback, quote, earned, ...stage };
  return null;
}

export function workbookEvaluation(
  key: { itemId: string; criterionId: string }, criterion: AssessmentCriterion, answer: string,
  routeId: string,
  effect: { kind: 'unknown'; providerEffectId: string | null } | { kind: 'done'; result: Json },
  hasAttachments = false,
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
  const reply = receipt.result as { state?: unknown; feedback?: unknown; quote?: unknown; earned?: unknown; reportedModel?: unknown; error_stage?: unknown } | null;
  if (reply && text(reply.reportedModel, 256)) {
    const observed = { ...trace, reportedModel: reply.reportedModel };
    if (reply.state === 'insufficient-evidence') {
      return { outcome: { ...key, state: 'insufficient-evidence', reason: '作答无法支持该标准的正式判断。' }, receipt: observed };
    }
    if (text(reply.feedback, 1500) && text(reply.quote, 500) && (answer.includes(reply.quote) || hasAttachments) &&
        (reply.error_stage === undefined || reply.error_stage === null || isAssessmentErrorStage(reply.error_stage))) {
      const evidence = criterion.inputs;
      const verified = { ...observed, quote: reply.quote };
      const stage = isAssessmentErrorStage(reply.error_stage) ? { errorStage: reply.error_stage } : {};
      if (reply.state === 'qualitative' && criterion.maximum === null) {
        return { outcome: { ...key, state: 'qualitative', feedback: reply.feedback, evidence, ...stage }, receipt: verified };
      }
      if (reply.state === 'scored' && criterion.maximum !== null && typeof reply.earned === 'number' &&
          Number.isFinite(reply.earned) && reply.earned >= 0 && reply.earned <= criterion.maximum) {
        const scored = { ...key, state: 'scored' as const, earned: reply.earned, feedback: reply.feedback, evidence };
        return { outcome: reply.earned < criterion.maximum ? { ...scored, ...stage } : scored, receipt: verified };
      }
    }
  }
  return { outcome: { ...key, state: 'failed', reason: '评估结论、分值或引文无法与冻结标准和作答核对。' }, receipt: trace };
}


export function workbookAttemptUsage(attempts: readonly { attempt: WorkbookAttempt }[]) {
  const grouped = new Map<string, { count: number; last: string }>();
  for (const { attempt } of attempts) {
    const prior = grouped.get(attempt.paperId);
    grouped.set(attempt.paperId, { count: (prior?.count ?? 0) + 1,
      last: !prior || attempt.submittedAt > prior.last ? attempt.submittedAt : prior.last });
  }
  return grouped;
}

export function workbookSummary(id: FactId, paper: WorkbookPaper, source: WorkbookSourceView | null,
  usage?: { count: number; last: string }): WorkbookSummary {
  return { id, title: paper.title, questionCount: paper.questions.length, savedAt: paper.savedAt,
    sourceId: paper.materialId, sourceTitle: source?.title ?? null,
    attemptCount: usage?.count ?? 0, lastAttemptAt: usage?.last ?? null };
}

export function workbookMistakes(
  attempt: WorkbookAttempt, assessments: readonly WorkbookRubricAssessmentView[], seen: Set<string>,
  formal?: AssessmentResult,
) {
  const result = [];
  for (const f of attempt.feedback) {
    const key = attempt.paperId + '/' + f.questionId;
    const grade = assessments.find(value => value.questionId === f.questionId);
    let formalVerdict: 'correct' | 'partial' | 'incorrect' | undefined;
    if (!grade && f.result === 'pending' && formal) {
      const scored = scoredFormalOutcome(attempt.paper, f.questionId, formal.outcomes);
      if (scored && scored.maximum > 0) {
        formalVerdict = scored.earned === scored.maximum ? 'correct' : scored.earned > 0 ? 'partial' : 'incorrect';
      }
    }
    const verdict = grade?.verdict ?? formalVerdict ?? f.result;
    if (verdict === 'pending' || verdict === 'unanswered' || verdict === 'self-check' || seen.has(key)) continue;
    seen.add(key);
    if (verdict !== 'incorrect' && verdict !== 'partial') continue;
    const q = attempt.paper.questions.find(q => q.id === f.questionId);
    if (!q || !f.expected) continue;
    const expected = f.expected.kind === 'exact'
      ? f.expected.values.join(' / ')
      : f.expected.kind === 'rubric'
        ? f.expected.rubric
        : [f.expected.value, f.expected.unit].filter(x => x !== null).join(' ');
    const errorStage = grade?.errorStage ?? formalItemErrorStage(formal?.outcomes, f.questionId);
    const formalFeedback = formal?.outcomes.flatMap(outcome =>
      outcome.itemId === f.questionId && 'feedback' in outcome && outcome.feedback ? [outcome.feedback] : []).join('\n') || null;
    result.push({ paperId: attempt.paperId, title: attempt.paper.title, questionId: q.id,
      prompt: q.prompt, answer: String(f.answer), expected,
      explanation: grade?.feedback ?? formalFeedback ?? f.explanation,
      ...(errorStage ? { errorStage } : {}) });
  }
  return result;
}

export class AssessmentInputUnavailable extends Error {}

export type FrozenWorkbookAssessmentInputs = {
  release: AssessmentRelease; submission: AssessmentSubmission;
  questions: Record<string, { prompt: string; rubric: string }>;
  questionAttachments?: Record<string, readonly WorkbookAttachmentEvidence[]>; consent: boolean; independent?: boolean;
};

const defaultAttachmentUnavailable = (error: unknown) =>
  error instanceof FactNotFoundError || (error instanceof Error && error.name === 'FactReadDeniedError');

export async function gatherWorkbookAssessment(read: Pick<ReadContext, 'fact'>, scope: {
  releaseRef: AssessmentRevisionRef; submissionRef: AssessmentRevisionRef; releaseEpoch: string; submissionEpoch: string;
}, unavailable: (error: unknown) => boolean = defaultAttachmentUnavailable) {
  const sameRef = sameAssessmentRef;
  const { releaseRef, submissionRef } = scope;
  const attemptFact = await read.fact(submissionRef.id, { mode: 'following' });
  const paperFact = await read.fact(releaseRef.id, { mode: 'pinned', rev: releaseRef.rev });
  if (attemptFact.type !== workbookAttemptType || paperFact.type !== workbookPaperType ||
      !sameRef(attemptFact.ref, submissionRef) || attemptFact.accessEpoch !== scope.submissionEpoch ||
      paperFact.accessEpoch !== scope.releaseEpoch) throw new AssessmentInputUnavailable();
  const attempt = workbookAttempt(attemptFact.value);
  const paper = workbookPaper(paperFact.value);
  const release = paper.assessmentRelease;
  if (!release || !sameRef(release.releaseRef, releaseRef) ||
      !sameWorkbookJson(release, attempt.paper.assessmentRelease) || attempt.paperId !== releaseRef.id) {
    throw new AssessmentInputUnavailable();
  }
  const openAttachment = (id: FactId) => read.fact(id, { mode: 'following' }).catch(error => {
    if (unavailable(error)) return null;
    throw error;
  });
  const attachmentEntries: [string, readonly WorkbookAttachmentEvidence[]][] = [];
  for (const item of release.items) {
    const expected = attempt.questionAttachments?.[item.itemId];
    if (expected?.length) {
      const verified = await readWorkbookQuestionAttachments(openAttachment, attempt, item.itemId);
      if (verified.length !== expected.length) throw new AssessmentInputUnavailable();
      attachmentEntries.push([
        item.itemId,
        verified.map(({ originalId, rev, url, mimeType }) => ({ originalId, rev, url, mimeType })),
      ]);
    }
  }
  const input: FrozenWorkbookAssessmentInputs = {
    release, submission: frozenWorkbookSubmission(release, submissionRef, attempt.answers, attempt.questionAttachments),
    questions: Object.fromEntries(paper.questions.flatMap(question => question.kind === 'rubric' &&
      release.items.some(({ itemId }) => itemId === question.id)
      ? [[question.id, { prompt: question.prompt, rubric: question.rubric }]] : [])),
    ...(attachmentEntries.length ? { questionAttachments: Object.fromEntries(attachmentEntries) } : {}),
    independent: independentlyAuthoredPaper(paper) && independentlyAuthoredPaper(attempt.paper),
    consent: attempt.assessmentConsent === workbookAssessmentConsent,
  };
  return { kind: 'input' as const, data: input, effects: [] };
}


export function legacyRubricInput(attempt: WorkbookAttempt, questionId: string) {
  const missing = (status: number, reason: string) => ({ state: 'unavailable' as const, status, reason });
  if (attempt.paper.assessmentRelease?.items.some(item => item.itemId === questionId))
    return missing(409, '此题已经随交卷登记自动评估，请刷新作答查看状态。');
  const question = attempt.paper.questions.find(({ id }) => id === questionId);
  if (!question || question.kind !== 'rubric') return missing(400, '这道题没有可用的评分标准。');
  const answer = attempt.answers[question.id];
  if (typeof answer !== 'string' || !answer.trim()) return missing(400, '这次作答没有可供批改的文字。');
  return { state: 'ready' as const, question, answer };
}

export function completedLegacyRubric(input: {
  attemptId: FactId; paperId: FactId; question: WorkbookRubricQuestion; request: WorkbookAssessmentRequest; assessedAt: string;
  route: Pick<WorkbookRubricAssessment, 'providerBaseUrl' | 'requestedModel' | 'providerProtocol' | 'providerId'>;
  result: Pick<WorkbookRubricAssessment, 'verdict' | 'score' | 'errorStage' | 'feedback' | 'evidence' | 'trace' | 'reportedModel'>;
}): WorkbookRubricAssessment {
  const { attemptId, paperId, question, request, assessedAt, route, result } = input;
  return { attemptId, paperId, questionId: question.id, requestId: request.requestId, assessedAt, consent: request.consent,
    ...(request.publicSearchQuery ? {publicSearchQuery: request.publicSearchQuery} : {}),
    assessmentVersion: workbookRubricAssessmentVersion, rubricVersion: question.rubricVersion, rubric: question.rubric,
    ...route, ...result };
}

export function sameWorkbookDraft(paper: WorkbookPaper, draft: Omit<WorkbookPaper, 'savedAt'>): boolean {
  const { savedAt: _, ...savedDraft } = paper;
  return sameWorkbookJson(savedDraft, draft);
}


export function rubricAssessmentIdentity(attemptId: FactId, question: WorkbookRubricQuestion) {
  return ['workbook-rubric-assessment', attemptId, question.id, question.rubricVersion, question.rubric] as const;
}
