import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { derivationId, factId, learnerId, type GatherContext, type Revision, type Tick } from '@mangekyo/kernel';
import { isInterventionLiftInput, isInterventionLiftOutcome } from '../../executors/python-deriver/intervention-lift-schema.ts';
import retire from './commands/retire-playbook.ts';
import lift from './derivers/intervention-lift.ts';
import status from './derivers/understanding-status.ts';
import { liftAssessment, reconciledLiftAssessment } from './intervention-lift-evidence.ts';
import { measureInterventionLift, type InterventionPair, type LiftInput } from './intervention-lift.ts';
import { readVerifiedPlaybook } from './playbook.ts';

const ref = (n: number) => ({ id: factId(String(n).padStart(26, '0')), rev: 1 as Revision, accessEpoch: '0' as Tick });
const identity = { playbookId: ref(0).id, strategyId: 'inspect-boundary', version: 1 };
const asOf = '2026-01-16T00:00:00.000Z';
const target = {item: 'transfer', comparisonKey: 'rubric-1:stratum-2', asOf};
function pair(i: number): InterventionPair {
  const assessment = { comparisonKey: target.comparisonKey, independence: 'independent', novelty: 'transfer' } as const;
  return { ...identity, intervention: ref(3*i+1), deliveredAt: '2026-01-02T00:00:00.000Z',
    plannedBaselineItem: 'pre', plannedPosttestItem: target.item, comparisonKey: assessment.comparisonKey,
    baseline: { ...assessment, submission: ref(3*i+2), item: 'pre', occurredAt: '2026-01-01T00:00:00.000Z', score: 0 },
    posttest: { ...assessment, submission: ref(3*i+3), item: target.item,
      occurredAt: i === 0 ? asOf : '2026-01-05T00:00:00.000Z', score: 1 } };
}
const positive = Array.from({ length: 14 }, (_, i) => pair(i));
const negative = positive.map(row => ({ ...row, baseline: {...row.baseline!, score: 1}, posttest: {...row.posttest!, score: 0} }));
const input = (interventions: InterventionPair[], at = asOf): LiftInput => ({ ...identity, interventions, asOf: at });
const pythonPath = fileURLToPath(new URL('../../executors/python-deriver/', import.meta.url));
function python(inputs: readonly unknown[]): unknown[] {
  const result = spawnSync(process.env.MANGEKYO_PYTHON ?? 'python3', ['-I', '-B', '-S', '-X', 'utf8', '-c',
    'import json,sys; sys.path.insert(0, sys.argv[1]); from intervention_lift import derive,is_lift_input; ' +
    'print(json.dumps([derive(i, method_version="intervention-lift@1") if is_lift_input(i) else None for i in json.load(sys.stdin)]))',
    pythonPath], {input: JSON.stringify(inputs), encoding: 'utf8'});
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it('TS 与确定性 Python 在固定截止时间按相同配对和缺失边界计算', () => {
  const cases = [input(positive), input(negative), input(positive.slice(0, 7)),
    input(positive, '2026-01-15T23:59:59.999Z'),
    input(positive.map(row => ({ ...row, posttest: {...row.posttest!, novelty: 'same'} }))),
    input(positive.map(row => ({ ...row, posttest: {...row.posttest!, independence: 'assisted'} }))),
    input(positive.map(row => ({ ...row, posttest: {...row.posttest!, independence: 'unknown'} }))),
    input(positive.map((row, i) => i < 6 ? { ...row, posttest: null } : row)),
    input(positive.map(row => ({ ...row, posttest: {...row.posttest!, occurredAt: '2026-01-05T00:00:00.001Z'} }))),
    input(positive.map(row => ({ ...row, posttest: {...row.posttest!, occurredAt: '2026-01-04T23:59:59.999Z'} }))),
    input(positive.map(row => ({ ...row, posttest: {...row.posttest!, occurredAt: '2026-01-16T00:00:00.001Z'} }))),
  ];
  const outcomes = python([...cases, cases[0]]);
  expect(outcomes.at(-1)).toEqual(outcomes[0]);
  expect(outcomes.slice(0, cases.length)).toEqual(cases.map(measureInterventionLift));
  expect(outcomes.map(row => (row as {value?: {verdict: string}}).value?.verdict ?? 'unknown')).toEqual([
    'positive', 'negative', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'inconclusive', 'positive', 'unknown', 'unknown', 'positive',
  ]);
  for (const [i, sealed] of cases.entries()) {
    expect(isInterventionLiftInput(sealed) && isInterventionLiftOutcome(outcomes[i], sealed)).toBe(true);
  }
  const flat = input(positive.map(pair => ({...pair, posttest: {...pair.posttest!, score: pair.baseline!.score}})));
  if (!isInterventionLiftInput(flat)) throw new Error('invalid fixture');
  expect(isInterventionLiftOutcome(outcomes[0], flat)).toBe(false);
  expect(isInterventionLiftOutcome(outcomes[2], flat)).toBe(false);
  expect(isInterventionLiftOutcome(outcomes[2], {...flat, interventions: []})).toBe(false);
  const unchanged = measureInterventionLift(flat);
  if (unchanged.kind !== 'value') throw new Error('missing flat interval');
  for (const override of [{pairedMean: 0.25}, {interval: [-1, 1]}, {eligible: 8}, {verdict: 'positive'}])
    expect(isInterventionLiftOutcome({kind: 'value', value: {...unchanged.value, ...override}}, flat)).toBe(false);
  const assisted = cases[5];
  if (!isInterventionLiftInput(assisted)) throw new Error('invalid fixture');
  expect(isInterventionLiftOutcome(outcomes[0], assisted)).toBe(false);
  expect(() => measureInterventionLift(input([positive[0]!, positive[0]!]))).toThrow('重复');

  const invalids = [{...cases[0], asOf: '2026-02-29T00:00:00.000Z'},
    {...cases[0], version: true}, {...cases[0], strategyId: ' '},
    {...cases[0], interventions: [{ ...positive[0]!, intervention: {...positive[0]!.intervention, accessEpoch: '01'} }]}];
  expect(invalids.map(isInterventionLiftInput)).toEqual([false, false, false, false]);
  expect(python(invalids)).toEqual([null, null, null, null]);
});

it('正式后测适配器只计独立分数并检查冻结预测身份及截止水位', async () => {
  const submission = ref(1);
  const learner = learnerId(ref(0).id);
  const forecastId = derivationId(ref(2).id);
  const observation = {submission, admittedAt:'3' as Tick, submittedAt: asOf, result:'correct' as const,
    novelty: 'fresh-context' as const, exposure: {kind: 'independent' as const}};
  const fact = vi.fn(async () => ({ref: {...submission, learner}, accessEpoch: '0', value: {},
    purpose: ['background-research'], type: 'activity.retentionPosttestSubmission'}));
  const slot = vi.fn(async () => ({outcome: {kind: 'value', value: {forecastId, status: 'observed', observation}}}));
  const ctx = {learner, read: {fact, slot}, snapshotTick: '3'} as unknown as GatherContext;
  await expect(reconciledLiftAssessment(ctx, submission, {...target, key: 'posttest', forecastId}))
    .resolves.toMatchObject({independence: 'independent', score: 1, novelty: 'transfer'});
  await expect(reconciledLiftAssessment(ctx, submission, {...target, key: 'posttest', forecastId: derivationId(ref(3).id)}))
    .resolves.toBeNull();
  await expect(liftAssessment(ctx, submission, {...observation, exposure: {kind: 'exposed', refs: []}}, target))
    .resolves.toMatchObject({independence: 'assisted', score: null});
  await expect(liftAssessment(ctx, submission, {...observation, exposure: {kind: 'unknown', reason: 'opened'}}, target))
    .resolves.toMatchObject({independence: 'unknown', score: null});
  await expect(liftAssessment(ctx, submission, {...observation, admittedAt: '4' as Tick}, target)).resolves.toBeNull();
});

it('真实 learner 推导入口生成晋升和黄灯动作，教学读出重核见证', async () => {
  const learner = learnerId(ref(90).id);
  const id = identity.playbookId;
  const data = {version: 1, strategyId: identity.strategyId, preconditions: ['分段'], strategy_steps: ['画图'],
    counterexamples: ['非连续区间'], exit_conditions: ['独立标出区间'],
    reflection: {rationale: '标图待复验', metric: '独立变式', evidence_refs: [ref(95)]}};
  const revoked = new Set<string>();
  const fact = vi.fn(async (key: string) => {
    if (revoked.has(key)) throw new Error('recipient denied');
    return {ref: {id: key, rev: 1, learner}, accessEpoch: '0', value: key === id ? data : {},
      purpose: ['background-research', 'teaching'], type: key === id ? 'learner.playbook' : 'activity.workbookAttempt'};
  });
  const [promoted, demoted] = python([input(positive), input(negative)]);
  let liftOutcome = promoted;
  let statusOutcome: unknown;
  const slot = vi.fn(async (address: {type: string}) => address.type === lift.slot
    ? {id: derivationId(ref(91).id), slot: address, outcome: liftOutcome}
    : {id: derivationId(ref(92).id), slot: address, outcome: statusOutcome});
  const ctx = {learner, read: {fact, slot}, snapshotTick: '100'} as unknown as GatherContext;
  const sealed = await lift.gather(ctx, async () => input(positive));
  if (sealed.kind !== 'input') throw new Error('expected a Lift plan');
  expect(sealed.data).toEqual(input(positive));
  expect(fact).toHaveBeenCalledWith(positive[0]!.posttest!.submission.id, {mode: 'following'});
  async function gatherStatus() {
    const plan = await status.gather(ctx, {playbookId: id});
    if (plan.kind !== 'input') throw new Error('expected a playbook status plan');
    return plan.data;
  }
  statusOutcome = status.derive(await gatherStatus());
  const teaching = () => readVerifiedPlaybook(ctx.read, ref(0));
  await expect(teaching()).resolves.toMatchObject({proposal: data, status: {status: 'verified'}});
  revoked.add(positive[0]!.posttest!.submission.id);
  await expect(teaching()).rejects.toThrow('recipient denied');
  await expect(lift.gather(ctx, async () => input(positive))).rejects.toThrow('recipient denied');
  revoked.clear();

  liftOutcome = demoted;
  await expect(teaching()).resolves.toBeNull();
  const gathered = await gatherStatus();
  expect(gathered).toMatchObject({status: 'demoted', gardeningProposal: {light: 'yellow', command: {type: retire.type}}});
  const proposal = gathered.gardeningProposal!;
  expect(retire.destructive).toBe(true);
  await expect(retire.write(ctx, retire.schema.parse(proposal.command.input), undefined))
    .resolves.toEqual([{kind: 'retract', id, expectedRev: 1}]);
  liftOutcome = promoted;
  await expect(retire.write(ctx, retire.schema.parse(proposal.command.input), undefined)).rejects.toThrow('缺少显著负');
});
