import { derivationId, factId, learnerId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { checkQuestionTeachingSources } from '@mangekyo/module-content/facts/asset-contract';
import { openQuestionForRelease as openReleaseContract } from '@mangekyo/module-content/facts/question-release';
import { questionMetaEffectResult, questionMetaMethodVersion, settle as settleQuestionMeta } from '@mangekyo/module-content/question-meta';
import {
  gather, openQuestionForRelease, questionVerificationEffectResult, settle, type QuestionVerificationEffectReceipt,
} from '@mangekyo/module-content/question-verification';
import { bindQuestionExecution, type QuestionExecution } from '../question-effects.ts';

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
  const raw = await plan();
  const executions = [0, 1, 2, 3].map(index => ({
    kind: 'local_wasm', moduleDigest: String(index).repeat(64), executableDigest: String(index).repeat(64), feeMicroUsd: 0,
  } satisfies QuestionExecution));
  const sealed = { id: ownerId, plan: {...raw, effects: raw.effects.map((request,index) => bindQuestionExecution(request, executions[index]!))} };
  const invocationIds = [0, 1, 2, 3].map(index => `01KFS4AAA0000000000000010${index}`);
  const receipts: QuestionVerificationEffectReceipt[] = sealed.plan.effects.map((request, index) => ({
    ownerId, request, state: 'done',
    result: questionVerificationEffectResult(invocationIds[index]!, {
      answerKey: '5', conditionKey: 'addition', reasoning: '2 + 3', eligible: true, invocationId: 'untrusted-model-id',
    }, executions[index]!),
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
  const unbound = { ...first!, result: { invocationId: invocationIds[0]!, result: { answerKey: '5' } } };
  expect(settle(sealed, [unbound, ...rest])).toMatchObject({ value: { status: 'needs-review' } });
  const repeated = { id: ownerId, plan: {...raw, effects: raw.effects.map(request => bindQuestionExecution(request, executions[0]!))} };
  expect(settle(repeated, receipts.map((receipt,index) => ({
    ...receipt, request: repeated.plan.effects[index]!,
    result: questionVerificationEffectResult(invocationIds[index]!, {answerKey:'5',conditionKey:'addition',reasoning:'2 + 3',eligible:true}, executions[0]!),
  })))).toMatchObject({value:{status:'needs-review'}});
  for (const changed of [{ id: materialId }, { rev: 2 }, { accessEpoch: '6' }, { recheck: 1 }, { methodVersion: '1' }]) {
    const request = first!.request;
    const input = { ...request.input as object, verification: { ...sealed.plan.data, ...changed } };
    expect(settle(sealed, [{ ...first!, request: { ...request, input } }, ...rest])).toMatchObject({ value: { status: 'needs-review' } });
  }
});

it('accepts a gardening receipt without a verification module identity', () => {
  const question = { id, rev, type: 'content.asset', epoch };
  const gardening = { methodVersion: questionMetaMethodVersion, question, metadata: question,
    sources: [{ ref: 'statement', basis: question }] };
  const request = { stepKey: 'garden', label: 'question-meta-gardening', input: { gardening } };
  const draft = { id, expectedRev: rev, append_metadata: null, basis: [], sticky: false };
  const sealed = { id: ownerId, plan: { kind: 'input' as const, data: { draft, gardening }, effects: [request] } };
  const result = questionMetaEffectResult('gardening-invocation', {
    solutions: [{ method: '直接相加', explanation: '把 2 和 3 相加。', source_ref: 'statement' }],
  });
  expect(settleQuestionMeta(sealed, [{ ownerId, request, state: 'done', result }])).toMatchObject({ value: {
    gardening: { status: 'suggestions' }, solutions: [{ method: '直接相加', verification: 'unverified' }],
  } });
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

it('pins the selected workspace entry and follows the version of its evidence', async () => {
  const reads: [typeof id, Parameters<ReadContext['fact']>[1]][] = [];
  const workspace: FactSnapshot = {
    type: 'activity.workspaceEntry', ref: { learner, id: materialId, rev }, accessEpoch: epoch,
    purpose: ['storage', 'teaching'], value: { basis: [{ id, rev, epoch }] },
  };
  const asset = { basis: [{ id: materialId, rev, epoch, type: workspace.type }] };
  let sourceRev = rev;
  const read = {
    async fact(target: typeof id, options: Parameters<ReadContext['fact']>[1]): Promise<FactSnapshot> {
      reads.push([target, options]);
      return target === materialId ? workspace : {
        type: 'capture.source', ref: { learner, id, rev: sourceRev }, accessEpoch: epoch,
        purpose: ['storage', 'teaching'], value: {},
      };
    },
  };
  await checkQuestionTeachingSources(read, asset);
  expect(reads).toEqual([[materialId, { mode: 'pinned', rev, requirePurpose: 'teaching' }], [id, { mode: 'following' }]]);
  sourceRev = 2 as Revision;
  await expect(checkQuestionTeachingSources(read, asset)).rejects.toThrow('依据已变化');
});

it('reopens frozen bank question ancestry through an issued paper or submission', async () => {
  const leaf = { id: materialId, rev, epoch, type: 'capture.source' };
  const paper = { materialId: null, questions: [{ kind: 'bank', sourceQuestionRef: { id, rev },
    sourceAccessEpoch: epoch, sourceBasis: [leaf] }] };
  const original: FactSnapshot = { type: 'content.asset', ref, accessEpoch: epoch, purpose: ['teaching'],
    value: { kind: 'question', title: '练习', promptBlockId: statement.id, blocks: [statement] } };
  let leafEpoch = epoch;
  const read = {
    async fact(target: typeof id) {
      if (target === id) return original;
      if (target === materialId) return { type: leaf.type, ref: { learner, id: target, rev },
        accessEpoch: leafEpoch, purpose: ['teaching'], value: {} };
      throw new Error('Unexpected fact');
    },
  };
  const sourceId = factId('01KFS4AAA00000000000000004');
  for (const [type, value] of [['activity.workbookPaper', paper], ['activity.workbookAttempt', { paper }]] as const) {
    const basis = { basis: [{ id: sourceId, rev, epoch, type }] };
    const reader = { async fact(target: typeof id) {
      return target === sourceId ? { type, ref: { learner, id: target, rev }, accessEpoch: epoch, purpose: ['teaching'], value }
        : read.fact(target);
    } };
    leafEpoch = epoch;
    await checkQuestionTeachingSources(reader, basis);
    leafEpoch = '6' as Tick;
    await expect(checkQuestionTeachingSources(reader, basis)).rejects.toThrow('依据已变化');
  }
});
