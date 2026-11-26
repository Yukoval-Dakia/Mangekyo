import { describe, expect, it } from 'vitest';
import {
  assessmentRelease, assessmentResult, assessmentSubmission,
  readAssessmentScore,
} from './assessment-values.ts';
import { evaluateBankCriterion, validateBankItem } from './question-assessment.ts';
import { numericEquivalenceEvaluator, rangeConstraintEvaluator } from '../content/question-evaluators.ts';
import { boundedWorkbookReply, workbookEvaluation } from './workbook-assessment-values.ts';
import { workbookAssessmentResult } from './workbook-values.ts';

const ref = (suffix: number, rev = 1) => ({ id: `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`, rev });
const releaseRef = ref(10);
const submissionRef = ref(11);
const source = { kind: 'product-rubric', ref: ref(12), path: '/rubric' };
const quantity = { slotId: 'reading', path: '/endpoint/volume' };
const selection = { slotId: 'reading', path: '/endpoint/selected' };
const trace = { slotId: 'process', path: '' };
const explanation = { slotId: 'essay', path: '/paragraph' };
const attachment = { slotId: 'essay', path: '/chart' };
const numeric = {
  criterionId: 'criterion-1', inputs: [quantity, selection, trace], maximum: 2,
  evaluator: { id: 'simulation-check', version: 'v2' }, source, missingEvidence: 'allow-qualitative',
  parameters: { equivalentAnswers: [{ value: 0.25, unit: 'L' }, { value: 250, unit: 'mL' }], requiredEvents: ['open', 'close'] },
};
const open = {
  criterionId: 'criterion-1', inputs: [explanation, attachment], maximum: null,
  evaluator: { id: 'evidence-review', version: 'v1' }, source, missingEvidence: 'insufficient-evidence',
  parameters: { rubric: '从图中引用支持终点的证据' },
};
const calculation = {
  itemId: 'titration', promptRef: ref(13, 2), workRef: ref(14, 3),
  slots: [
    { slotId: 'reading', schemaVersion: 'reading-v2', fields: [{ path: quantity.path, kind: 'numeric' }, { path: selection.path, kind: 'structured' }] },
    { slotId: 'process', schemaVersion: 'v1', fields: [{ path: trace.path, kind: 'trace' }] },
  ],
  criteria: [numeric],
};
const draft = { releaseRef, items: [calculation, {
  itemId: 'explain', slots: [{ slotId: 'essay', schemaVersion: 'v1', fields: [{ path: explanation.path, kind: 'text' }, { path: attachment.path, kind: 'attachment' }] }],
  criteria: [open],
}] };
const numericAnswer = (value: number, unit: string) => ({
  itemId: 'titration', ...quantity, schemaVersion: 'reading-v2', value: { kind: 'numeric', value, unit },
});
const traceAnswer = { itemId: 'titration', ...trace, schemaVersion: 'v1', value: { kind: 'trace', ref: ref(15, 4) } };
const answers = [
  numericAnswer(250, 'mL'), traceAnswer,
  { itemId: 'titration', ...selection, schemaVersion: 'reading-v2', value: { kind: 'structured', value: { objects: ['valve-1', 'reading-2'] } } },
  { itemId: 'explain', ...explanation, schemaVersion: 'v1', value: { kind: 'text', value: ' pH 在终点附近突变。\n' } },
  { itemId: 'explain', ...attachment, schemaVersion: 'v1', value: { kind: 'attachment', ref: ref(16) } },
];
const scored = { itemId: 'titration', criterionId: numeric.criterionId, state: 'scored', earned: 2, evidence: [quantity, selection, trace] };
const qualitative = { itemId: 'explain', criterionId: open.criterionId, state: 'qualitative', feedback: '解释引用了图表。', evidence: [explanation, attachment] };
const result = { releaseRef, submissionRef, outcomes: [scored, qualitative] };

describe('frozen assessment values', () => {
  it('keeps equivalent input forms, open work and stable refs across serialization', () => {
    const release = assessmentRelease(JSON.parse(JSON.stringify(draft)));
    for (const [index, { value, unit }] of numeric.parameters.equivalentAnswers.entries()) {
      const input = { releaseRef, submissionRef: ref(20 + index), answers: [numericAnswer(value, unit), ...answers.slice(1)] };
      const submission = assessmentSubmission(JSON.parse(JSON.stringify(input)), release);
      expect(submission).toEqual(input);
      // The same proposed score for either form is representable. No evaluator runs here.
      expect(readAssessmentScore({ ...result, submissionRef: input.submissionRef }, release, submission)).toEqual({ earned: 2, maximum: 2 });
    }
  });

  it('preserves partial, qualitative and unresolved states without inventing points', () => {
    const release = assessmentRelease(draft);
    const subset = assessmentSubmission({ releaseRef, submissionRef, answers: answers.filter(answer => answer.slotId !== trace.slotId) }, release);
    const key = { itemId: scored.itemId, criterionId: scored.criterionId };
    const withOutcome = (outcome: object) => ({ ...result, outcomes: [{ ...key, ...outcome }, qualitative] });
    const reason = '等待可核对的轨迹';
    expect(() => readAssessmentScore(withOutcome({ state: 'scored', earned: 0, evidence: [quantity] }), release, subset)).toThrow('完整标准输入');
    for (const state of ['pending', 'insufficient-evidence', 'blocked', 'failed', 'partial', 'qualitative']) {
      const fields = state === 'partial' ? { reason, evidence: [quantity] }
        : state === 'qualitative' ? { feedback: '单位正确', evidence: [quantity] } : { reason };
      const candidate = withOutcome({ state, ...fields });
      expect(assessmentResult(candidate, release, subset)).toEqual(candidate);
      expect(readAssessmentScore(candidate, release, subset)).toBeNull();
      expect(() => assessmentResult(withOutcome({ state, ...fields, earned: 0 }), release, subset)).toThrow('字段无效');
      if (state === 'partial' || state === 'qualitative') {
        expect(() => assessmentResult(withOutcome({ state, ...fields, evidence: [] }), release, subset)).toThrow('作答证据');
        expect(() => assessmentResult(withOutcome({ state, ...fields, evidence: [explanation] }), release, subset)).toThrow('已提交的输入');
      }
    }
    const absent = assessmentSubmission({ releaseRef, submissionRef, answers: answers.filter(answer => answer.itemId === 'explain') }, release);
    expect(readAssessmentScore(withOutcome({ state: 'unsubmitted', reason: '该题未交' }), release, absent)).toBeNull();
  });

  it('enforces witnessed 5-value errorStage across formal and rubric assessment contracts', () => {
    const release = assessmentRelease(draft);
    const submission = assessmentSubmission({ releaseRef, submissionRef, answers }, release);
    const withStage = (extra: object) => ({ ...result, outcomes: [{ ...scored, earned: 1, ...extra }, qualitative] });
    expect(assessmentResult(withStage({ errorStage: 'execution' }), release, submission).outcomes[0]).toMatchObject({ errorStage: 'execution' });
    expect(assessmentResult({ ...result, outcomes: [{ ...scored, earned: 1 }, qualitative] }, release, submission).outcomes[0]).not.toHaveProperty('errorStage');
    for (const bad of [{ errorStage: 'guessing' }, { earned: 2, errorStage: 'execution' }]) expect(() => assessmentResult(withStage(bad), release, submission)).toThrow('错步分类');
    expect(() => assessmentResult({ ...result, outcomes: [{ itemId: 'titration', criterionId: numeric.criterionId, state: 'pending', reason: '待判', errorStage: 'reading' }, qualitative] }, release, submission)).toThrow();
    expect(workbookAssessmentResult({ verdict: 'partial', score: { earned: 1, maximum: 2 }, errorStage: 'modeling', feedback: '模型错', evidence: ['x=1'], trace: [] }).errorStage).toBe('modeling');
    expect(workbookAssessmentResult({ verdict: 'incorrect', feedback: '旧记录', evidence: [], trace: [] })).not.toHaveProperty('errorStage');
    for (const bad of [{ verdict: 'incorrect', errorStage: 'bad', feedback: 'f', evidence: ['a'], trace: [] }, { verdict: 'correct', errorStage: 'execution', feedback: 'f', evidence: ['a'], trace: [] }, { verdict: 'incorrect', errorStage: 'reading', feedback: 'f', evidence: [], trace: [] }]) expect(() => workbookAssessmentResult(bad)).toThrow('错步分类');
    expect(boundedWorkbookReply({ state: 'scored', reportedModel: 'm', feedback: '错', quote: '45', earned: 1, error_stage: 'bad' })).toBeNull();
    const key = { itemId: 'titration', criterionId: numeric.criterionId }, run = (a: string, e: number) => workbookEvaluation(key, release.items[0]!.criteria[0]!, a, 'r1', { kind: 'done', result: { providerEffectId: 'e1', denied: false, result: { state: 'scored', reportedModel: 'm', feedback: 'f', quote: a, earned: e, error_stage: 'execution' } } }).outcome;
    expect(run('45', 1)).toMatchObject({ errorStage: 'execution' });
    expect(run('50', 2)).not.toHaveProperty('errorStage');
  });

  it('scores extended numeric-equivalence and range-constraint bank criteria end to end', () => {
    const input = { slotId: 'reading', path: '' }, item = { itemId: 'bank', slots: [{ slotId: 'reading', schemaVersion: 'v1', fields: [{ path: '', kind: 'text' }] }],
      criteria: [{ criterionId: 'num', inputs: [input], maximum: 2, evaluator: numericEquivalenceEvaluator, source, missingEvidence: 'insufficient-evidence', parameters: { expected: '-1.5', tolerance: 0 } }] };
    expect(() => validateBankItem(item as never, releaseRef as never)).not.toThrow();
    const submission = assessmentSubmission({ releaseRef, submissionRef, answers: [{ itemId: 'bank', ...input, schemaVersion: 'v1', value: { kind: 'text', value: '-6/4' } }] }, { releaseRef: releaseRef as never, items: [item] as never });
    expect(evaluateBankCriterion(item as never, item.criteria[0] as never, submission)).toMatchObject({ state: 'scored', earned: 2 });
    const ranged = { ...item, criteria: [{ ...item.criteria[0]!, evaluator: rangeConstraintEvaluator, parameters: { target: 10, tolerance: 2, partialMargin: 4 } }] };
    expect(evaluateBankCriterion(ranged as never, ranged.criteria[0] as never,
      assessmentSubmission({ releaseRef, submissionRef, answers: [{ itemId: 'bank', ...input, schemaVersion: 'v1', value: { kind: 'text', value: '15' } }] }, { releaseRef: releaseRef as never, items: [item] as never }))).toMatchObject({ state: 'scored', earned: 0.5 });
  });
});
