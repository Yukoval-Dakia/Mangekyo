import { derivationId, factId, learnerId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { openQuestionForRelease as openReleaseContract } from '@mangekyo/module-content/facts/question-release';
import {
  gather, openQuestionForRelease, questionVerificationEffectResult, settle, type QuestionVerificationEffectReceipt,
} from '@mangekyo/module-content/question-verification';

const learner = learnerId('01KFS4AAA00000000000000000');
const id = factId('01KFS4AAA00000000000000001');
const materialId = factId('01KFS4AAA00000000000000002');
const ownerId = derivationId('01KFS4AAA00000000000000003');
const rev = 1 as Revision;
const epoch = '5' as Tick;
const ref = { learner, id, rev };
const statement = { id: 'statement', parentId: null, body: { kind: 'text', text: '2 + 3 = ?' } };
const solution = { id: 'solution', parentId: null, body: { kind: 'text', text: 'SOLUTION SECRET' } };
const unused = async (): Promise<never> => { throw new Error('Unexpected read'); };

async function plan(blocks: readonly unknown[] = [statement, solution], recheck = 0, material?: FactSnapshot) {
  const basis = material ? [{ id: material.ref.id, rev, epoch, type: material.type }] : [];
  const question: FactSnapshot<unknown> = {
    type: 'content.asset', ref, accessEpoch: epoch, purpose: ['teaching'],
    value: {
      kind: 'question', title: '练习', promptBlockId: 'statement', blocks, basis,
      response_schema: [{ slotId: 'answer', schemaVersion: '1', fields: [{ path: '', kind: 'numeric' }] }],
      assessment_contract: [{ criterionId: 'sum', inputs: [{ slotId: 'answer', path: '' }],
        evaluator: { id: 'frozen-value-match', version: '1' }, parameters: { key: 'RUBRIC SECRET' },
        maximum: 1, missingEvidence: 'insufficient-evidence' }],
    },
  };
  const read: ReadContext = {
    async fact<Value>(target: typeof id) { return (target === id ? question : material!) as FactSnapshot<Value>; },
    slot: unused, range: unused,
  };
  return gather({ learner, read, snapshotTick: epoch }, { id, rev, recheck });
}

it('matches unordered ledger receipts to the sealed owner, step, method, and full input', async () => {
  const sealed = { id: ownerId, plan: await plan() };
  const invocationIds = [0, 1, 2, 3].map(index => `01KFS4AAA0000000000000010${index}`);
  const receipts: QuestionVerificationEffectReceipt[] = sealed.plan.effects.map((request, index) => ({
    ownerId, request, state: 'done',
    result: questionVerificationEffectResult(invocationIds[index]!, {
      answerKey: '5', conditionKey: 'addition', reasoning: '2 + 3', eligible: true, invocationId: 'untrusted-model-id',
    }),
  }));
  const replay = JSON.parse(JSON.stringify([...receipts].reverse(), (_key, value) => {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value;
  })) as typeof receipts;
  expect(settle(sealed, replay)).toMatchObject({ value: { status: 'ready', invocations: invocationIds } });
  expect(openReleaseContract).toBe(openQuestionForRelease);
  const [first, ...rest] = receipts;
  const mismatches = [
    [first!, ...rest.slice(1)],
    [first!, first!, ...rest.slice(1)],
    [{ ...first!, state: 'unknown' as const }, ...rest],
    [{ ...first!, result: rest[0]!.result! }, ...rest],
    [{ ...first!, ownerId: derivationId('01KFS4AAA00000000000000006') }, ...rest],
    [{ ...first!, request: { ...first!.request, label: 'question-contract-validation' } }, ...rest],
  ];
  for (const received of mismatches) expect(settle(sealed, received)).toMatchObject({ value: { status: 'needs-review' } });
  for (const changed of [{ id: materialId }, { rev: 2 }, { accessEpoch: '6' }, { recheck: 1 }, { methodVersion: '1' }]) {
    const request = first!.request;
    const input = { ...request.input as object, verification: { ...sealed.plan.data, ...changed } };
    expect(settle(sealed, [{ ...first!, request: { ...request, input } }, ...rest])).toMatchObject({ value: { status: 'needs-review' } });
  }
});

it('projects only designated prompt and known shared material and blocks unclassified inputs', async () => {
  const material: FactSnapshot = {
    type: 'capture.source', ref: { ...ref, id: materialId }, accessEpoch: epoch, purpose: ['teaching'],
    value: { unit: { blocks: [
      { id: 'material', parentId: null, body: { kind: 'capture', layer: 'material', status: 'known', text: 'PUBLIC PASSAGE' } },
      { id: 'answer', parentId: null, body: { kind: 'capture', layer: 'reference-answer', status: 'known', text: 'SOURCE ANSWER SECRET' } },
    ] } },
  };
  const shared = (blockId: string) => ({ id: 'shared', parentId: null, body: {
    kind: 'sharedMaterial', source: { fact: material.ref, type: material.type, anchor: { kind: 'block', blockId } },
  } });
  const safe = await plan([statement, solution, shared('material')], 0, material);
  expect(JSON.stringify(safe.effects)).toContain('PUBLIC PASSAGE');
  expect(JSON.stringify(safe.effects)).not.toMatch(/SOLUTION SECRET|SOURCE ANSWER SECRET/);
  for (const request of safe.effects.slice(0, 3)) {
    expect(request.input).toMatchObject({ prompt: '2 + 3 = ?' });
    expect(JSON.stringify(request)).not.toContain('RUBRIC SECRET');
  }
  for (const block of [shared('answer'), shared('absent'), {
    id: 'interaction', parentId: null, body: { kind: 'interaction', view: { answer: 'INTERACTION SECRET' } },
  }]) {
    const blocked = await plan([statement, solution, block], 0, material);
    expect(blocked.effects).toEqual([]);
    expect(settle({ id: ownerId, plan: blocked }, [])).toMatchObject({ value: { status: 'needs-review' } });
  }
});
