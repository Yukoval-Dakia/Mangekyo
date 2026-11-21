import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { commandId, derivationId, factId, learnerId, type FactWrite, type GatherContext, type Json, type Revision, type Tick } from '@mangekyo/kernel';
import { isInterventionLiftInput, isInterventionLiftOutcome } from '../../executors/python-deriver/intervention-lift-schema.ts';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { createCommandHandler, readCommandProposals } from '../../kernel/src/commands/handle.ts';
import { applyFactWrites } from '../../kernel/src/commands/writes.ts';
import { sealCandidate, submitCandidate } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { requestWork } from '../../kernel/src/work/index.ts';
import { withLearnerDatabase } from '../../kernel/test/learner-database.ts';
import retire from './commands/retire-playbook.ts';
import lift from './derivers/intervention-lift.ts';
import status from './derivers/understanding-status.ts';
import { liftAssessment, reconciledLiftAssessment } from './intervention-lift-evidence.ts';
import { interventionLiftMethod, measureInterventionLift, type InterventionPair, type LiftInput } from './intervention-lift.ts';
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

it('经 Python worker 和真实内核采纳 Lift，生成待审黄灯提案', {timeout: 60_000}, async ({ onTestFinished }) => {
  const learner = learnerId(ref(90).id);
  const id = identity.playbookId;
  const data = {version: 1, strategyId: identity.strategyId, preconditions: ['分段'], strategy_steps: ['画图'],
    counterexamples: ['非连续区间'], exit_conditions: ['独立标出区间'],
    reflection: {rationale: '标图待复验', metric: '独立变式', evidence_refs: [ref(95)]}};
  const purpose = 'background-research';
  const scope = {learner, purpose};
  const hooks = createPropagationHooks([]);
  const worker = createPythonDeriverHost();
  onTestFinished(worker.close);
  await withLearnerDatabase(learner, async db => {
    const apply = (writes: readonly FactWrite[], n: number) => db.tx(scope, tx => tx.withLearnerWrite(tick =>
      applyFactWrites(tx, tick, writes, {actor: 'learner', purpose, commandId: commandId(ref(n).id)},
        type => ({type, schema: {parse: (value: Json) => value}}))));
    const sources = positive.flatMap(({intervention, baseline, posttest}) => [intervention, baseline!.submission, posttest!.submission]);
    await apply([{kind: 'create', id, factType: 'learner.playbook', data, purpose: [purpose, 'teaching']},
      ...[ref(95), ...sources].map(({id}): FactWrite => ({kind: 'create', id, factType: 'activity.workbookAttempt',
        data: {}, purpose: [purpose, 'teaching']}))], 100);
    const run = async (slotType: string, slotKey: string, deriver: string,
      gather: Parameters<typeof gatherSnapshot>[2], derive: (input: unknown) => unknown) => {
      const policy = {slot: {type: slotType}, deriver, purpose};
      const work = await db.tx(scope, tx => tx.withLearnerWrite(async tick => {
        await tx.query("INSERT INTO slot_state (learner_id,slot_type,slot_key,scope_keys) VALUES ($1,$2,$3,'{}') ON CONFLICT DO NOTHING",
          [learner, slotType, slotKey]);
        return requestWork(tx, tick, {slotType, slotKey, deriver});
      }));
      const sealed = await sealCandidate(db, work, policy, await gatherSnapshot(db, scope, gather));
      if (sealed.kind !== 'sealed') throw new Error('未冻结候选');
      const result = await submitCandidate(db, work, policy, sealed.id, await derive(sealed.plan.data), hooks);
      expect(result, JSON.stringify(result)).toMatchObject({kind: 'effective'});
    };
    for (const [pairs, expected] of [[positive, 'verified'], [negative, 'demoted']] as const) {
      await run(lift.slot, JSON.stringify([id, 1]), lift.name, ctx => lift.gather(ctx, async () => input(pairs)),
        async payload => { const result = await worker.derive(interventionLiftMethod, payload); return result.kind === 'ok' ? result.outcome : result; });
      await run(status.slot, id, status.name, ctx => status.gather(ctx, {playbookId: id}),
        payload => status.derive(payload as Parameters<typeof status.derive>[0]));
      const teaching = await gatherSnapshot(db, {...scope, purpose: 'teaching'}, async ctx =>
        ({kind: 'input', effects: [], data: await readVerifiedPlaybook(ctx.read, ref(0))}));
      if (expected === 'verified') expect(teaching.plan).toMatchObject({data: {status: {status: expected}}});
      else expect(teaching.plan).toMatchObject({data: null});
    }
    const current = (await gatherSnapshot(db, scope, ctx => status.gather(ctx, {playbookId: id}))).plan;
    expect(current).toMatchObject({data: {status: 'demoted', gardeningProposal: {light: 'yellow'}}});
    if (current.kind !== 'input') throw new Error('状态槽等待输入');
    const proposal = (current.data as Parameters<typeof status.derive>[0]).gardeningProposal!;
    const handler = createCommandHandler(db, {modules: [await loadModuleDirectory(fileURLToPath(new URL('.', import.meta.url)))], hooks});
    const proposalId = commandId(ref(101).id);
    await expect(handler({...scope, ...proposal.command, id: proposalId, actor: 'companion'})).resolves.toMatchObject({state: 'proposed'});
    await expect(handler.decideProposal({...scope, id: commandId(ref(102).id), type: retire.type,
      proposalId, selection: 'accept'}, async (_tx, input) => input)).rejects.toThrow('slot reads are not implemented');
    expect(await db.snapshot(scope, tx => readCommandProposals(tx, retire.type, {}, proposalId))).toMatchObject([{state: 'pending'}]);
    const source = positive[0]!.posttest!.submission;
    await apply([{kind: 'set_purpose', id: source.id, expectedRev: source.rev, purpose: ['teaching']}], 103);
    await apply([{kind: 'set_purpose', id: source.id, expectedRev: 2 as Revision, purpose: [purpose, 'teaching']}], 104);
    await expect(gatherSnapshot(db, scope, ctx => status.gather(ctx, {playbookId: id})))
      .rejects.toThrow('Derivation input is invalid or denied');
  }, {postgres: false});
});
