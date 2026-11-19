import { factId, type Revision } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { checkAssessmentPublication, type VerifiedAssessmentPublicationEvidence } from './assessment-publication.ts';
import type { AssessmentRelease } from './assessment-values.ts';

const ref = (suffix: number) => ({ id: factId(`01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`), rev: 1 as Revision });
const releaseRef = ref(10);
const first = { slotId: 'steps', path: '/first' };
const second = { slotId: 'steps', path: '/second' };
const inputs = [first, second];
const slots = [{ slotId: 'steps', schemaVersion: 'v1', fields: inputs.map(({ path }) => ({ path, kind: 'text' as const })) }];
const school = { kind: 'school-rubric', ref: ref(11), path: '/method' } as const;
const product = { kind: 'product-rubric', ref: ref(12) } as const;
const methods = { id: 'ordered-method', version: 'v2' };
const meaning = { id: 'meaning', version: 'v1' };
const criterion = { criterionId: 'rule', missingEvidence: 'insufficient-evidence' } as const;
const release = {
  releaseRef,
  items: [
    { itemId: 'calculation', promptRef: ref(13), slots, criteria: [{
      ...criterion, inputs, evaluator: methods, source: school, maximum: 2,
      parameters: { alternatives: [['12/3', '4*2'], ['12*2', '24/3']] },
    }] },
    { itemId: 'explanation', workRef: ref(14), slots, criteria: [{
      ...criterion, inputs: [first], evaluator: meaning, source: product, maximum: null, parameters: null,
    }] },
  ],
} as const satisfies AssessmentRelease;
const [calculation, explanation] = release.items;
type Sample = VerifiedAssessmentPublicationEvidence['samples'][number];

function example(item: typeof calculation | typeof explanation, suffix: number, values: string[], expected: object, actual: object) {
  const sampleRef = ref(suffix);
  const submissionRef = ref(suffix + 20);
  const witnessRef = ref(item === calculation ? 15 : 16);
  const answers = values.map((value, index) => ({
    ...inputs[index], itemId: item.itemId, schemaVersion: 'v1', value: { kind: 'text', value },
  }));
  const result = (fields: object) => ({ releaseRef, submissionRef, outcomes: [{ itemId: item.itemId, criterionId: 'rule', ...fields }] });
  return {
    sample: { sampleRef, submission: { releaseRef, submissionRef, answers }, expected: result(expected) },
    run: {
      state: 'completed', witnessRef, sampleRef, receiptRef: ref(suffix + 40), actual: result(actual),
      evaluators: item.criteria.map(({ criterionId, evaluator }) => ({ criterionId, evaluator })),
    },
  } as const satisfies Sample;
}

const score = (earned: number) => ({ state: 'scored', earned, evidence: inputs });
const partial = { state: 'partial', reason: '缺少第二步', evidence: [first] };
const insufficient = { state: 'insufficient-evidence', reason: '没有可核对的步骤' };
const qualitative = { state: 'qualitative', feedback: '说明了两种顺序的数量关系', evidence: [first] };
const mixed = example(calculation, 22, ['12/3', '24/3'], score(1), score(1));
const written = example(explanation, 25, ['先乘或先除只改变中间量'], qualitative, qualitative);
const calculationSamples = [
  example(calculation, 20, ['12/3', '4*2'], score(2), score(2)),
  example(calculation, 21, ['12*2', '24/3'], score(2), { ...score(2), evidence: [second, first] }),
  mixed,
  example(calculation, 23, ['12/3'], partial, partial),
  example(calculation, 24, [], insufficient, insufficient),
];
const proof = (frozenItem: typeof calculation | typeof explanation, samples: readonly Sample[]): VerifiedAssessmentPublicationEvidence => ({
  witness: {
    ref: ref(frozenItem === calculation ? 15 : 16), origin: 'independent-solution', releaseRef, frozenItem,
    requiredSampleRefs: samples.map(({ sample }) => sample.sampleRef),
  },
  samples,
});
const calculationProof = proof(calculation, calculationSamples);
const explanationProof = proof(explanation, [written]);
const verify = (candidate: unknown, math = calculationProof, text = explanationProof) =>
  checkAssessmentPublication(candidate, [methods, meaning], target => {
    expect(target.releaseRef).toEqual(releaseRef);
    return target.itemId === calculation.itemId ? math : text;
  });

it('qualifies frozen item versions using complete trusted expectations and their observed receipts', () => {
  expect(verify(release)).toMatchObject({
    state: 'eligible', releaseRef,
    items: [
      {
        itemId: calculation.itemId, promptRef: calculation.promptRef, witnessRef: calculationProof.witness.ref,
        criteria: [{ source: school, evaluator: methods, maximum: 2 }],
        samples: calculationSamples.map(({ sample, run }) => ({ sampleRef: sample.sampleRef, receiptRef: run.receiptRef })),
      },
      { itemId: explanation.itemId, workRef: explanation.workRef, criteria: [{ source: product, maximum: null }] },
    ],
  });
});

it('keeps the entire release pending when a required sample or its frozen verification fails', () => {
  const withMixed = (entry: Sample) => verify(release, {
    ...calculationProof, samples: calculationSamples.map(sample => sample === mixed ? entry : sample),
  });
  const actual = mixed.run.actual;
  const cases = [
    [verify(release, { ...calculationProof, samples: calculationSamples.filter(sample => sample !== mixed) }), 'coverage'],
    [withMixed({ ...mixed, sample: { ...mixed.sample, expected: undefined } }), 'expected'],
    [withMixed({ ...mixed, run: { ...mixed.run, actual: undefined } }), 'actual'],
    [withMixed({ ...mixed, run: { state: 'pending', reason: '执行尚未返回' } }), 'run'],
    [withMixed({ ...mixed, run: { ...mixed.run, witnessRef: ref(17) } }), 'run'],
    [withMixed({ ...mixed, run: { ...mixed.run, evaluators: [{ criterionId: 'rule', evaluator: { ...methods, version: 'v1' } }] } }), 'evaluator'],
    [withMixed({ ...mixed, run: { ...mixed.run, actual: { ...actual, outcomes: actual.outcomes.map(outcome => ({ ...outcome, earned: 2 })) } } }), 'outcome'],
  ] as const;
  for (const [decision, stage] of cases) {
    expect(decision).toMatchObject({ state: 'needs-review', issues: [{ stage, itemId: calculation.itemId, sampleRef: mixed.sample.sampleRef }] });
  }
  expect(verify({ ...release, items: [{ ...calculation, promptRef: ref(17) }, explanation] }))
    .toMatchObject({ state: 'needs-review', issues: [{ stage: 'contract', itemId: calculation.itemId }] });
  const wrongMeaning = example(explanation, 25, ['先乘或先除只改变中间量'], qualitative, { ...qualitative, feedback: '结论缺少依据' });
  expect(verify(release, calculationProof, { ...explanationProof, samples: [wrongMeaning] }))
    .toMatchObject({ state: 'needs-review', issues: [{ stage: 'outcome', itemId: explanation.itemId, criterionId: 'rule' }] });
});
