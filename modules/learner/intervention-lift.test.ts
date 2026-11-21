import { pythonLines } from '../../executors/python-deriver/test/worker.ts';
import { command, factWriter, ref, seed, snapshot, use } from './test/facts.ts';
import { expect, it } from 'vitest';
import { derivationId, learnerId, type GatherContext, type Revision, type Tick } from '@mangekyo/kernel';
import { isInterventionLiftInput, isInterventionLiftOutcome } from '../../executors/python-deriver/intervention-lift-schema.ts';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { createCommandHandler, readCommandProposals } from '../../kernel/src/commands/handle.ts';
import { sealCandidate, submitCandidate } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { enqueueWork } from '../../kernel/src/work/todos.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../kernel/test/learner-database.ts';
import { loadStudioTestModule } from '../../runtime/studio/test/modules.ts';
import propose from './commands/propose-playbook.ts';
import retire from './commands/retire-playbook.ts';
import lift from './derivers/intervention-lift.ts';
import status from './derivers/understanding-status.ts';
import { liftAssessment, reconciledLiftAssessment } from './intervention-lift-evidence.ts';
import { interventionLiftKey, interventionLiftMethod, measureInterventionLift, type InterventionPair, type LiftInput } from './intervention-lift.ts';
import { playbook, readVerifiedPlaybook, verifiedStatus } from './playbook.ts';

const identity = { playbookId: ref(0).id, strategyId: 'inspect-boundary', version: 1 };
const asOf = '2026-01-16T00:00:00.000Z';
const purpose = 'background-research';
const target = {item: 'transfer', comparisonKey: 'rubric-1:stratum-2', asOf};
function pair(i: number): InterventionPair {
  const assessment = { comparisonKey: target.comparisonKey, independence: 'independent', novelty: 'transfer' } as const;
  return { ...identity, intervention: ref(3*i+1), deliveredAt: '2026-01-02T00:00:00.000Z',
    plannedBaselineItem: 'pre', plannedPosttestItem: target.item, comparisonKey: assessment.comparisonKey,
    baseline: { ...assessment, submission: ref(3*i+2), item: 'pre', occurredAt: '2026-01-01T00:00:00.000Z', score: 0 },
    posttest: { ...assessment, submission: ref(3*i+3), item: target.item, occurredAt: i === 0 ? asOf : '2026-01-05T00:00:00.000Z', score: 1 } };
}
const positive = Array.from({ length: 14 }, (_, i) => pair(i));
const replacePosttest = (change: Partial<NonNullable<InterventionPair['posttest']>>) =>
  positive.map(row => ({...row, posttest: {...row.posttest!, ...change}}));
const negative = replacePosttest({score: 0}).map(row => ({...row, baseline: {...row.baseline!, score: 1}}));
const input = (interventions: InterventionPair[], at = asOf): LiftInput => ({ ...identity, interventions, asOf: at });
const python = (inputs: readonly unknown[]) => pythonLines(['-c',
  'import json,sys; sys.path.insert(0, ".")\nfrom intervention_lift import derive,is_lift_input\nfor value in map(json.loads, sys.stdin): print(json.dumps(derive(value, method_version="intervention-lift@1") if is_lift_input(value) else None))'], inputs);

it('TS 与确定性 Python 在固定截止时间按相同配对和缺失边界计算', () => {
  const cases = [input(positive), input(negative), input(positive.slice(0, 7)), input(positive, '2026-01-15T23:59:59.999Z'),
    input(replacePosttest({novelty: 'same'})), ...(['assisted', 'unknown'] as const).map(independence => input(replacePosttest({independence}))),
    input(positive.map((row, i) => i < 6 ? { ...row, posttest: null } : row)),
    ...['2026-01-05T00:00:00.001Z', '2026-01-04T23:59:59.999Z', '2026-01-16T00:00:00.001Z'].map(occurredAt => input(replacePosttest({occurredAt})))];
  const invalids = [{...cases[0], asOf: '2026-02-29T00:00:00.000Z'}, {...cases[0], version: true}, {...cases[0], strategyId: ' '},
    {...cases[0], interventions: [{...positive[0]!, intervention: {...positive[0]!.intervention, accessEpoch: '01'}}]}];
  const expected = cases.map(measureInterventionLift);
  expect(expected.map(row => row.kind === 'value' ? row.value.verdict : 'unknown')).toEqual([
    'positive', 'negative', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'inconclusive', 'positive', 'unknown', 'unknown',
  ]);
  const outcomes = python([...cases, cases[0], ...invalids]);
  expect(outcomes).toEqual([...expected, expected[0], ...invalids.map(() => null)]);
  expect(invalids.map(isInterventionLiftInput)).toEqual([false, false, false, false]);
  for (const [i, sealed] of cases.entries())
    expect(isInterventionLiftInput(sealed) && isInterventionLiftOutcome(outcomes[i], sealed)).toBe(true);
  const flat = input(replacePosttest({score: 0}));
  if (!isInterventionLiftInput(flat)) throw new Error('invalid fixture');
  for (const i of [0, 2]) expect(isInterventionLiftOutcome(outcomes[i], flat)).toBe(false);
  expect(isInterventionLiftOutcome(outcomes[2], {...flat, interventions: []})).toBe(false);
  const unchanged = measureInterventionLift(flat);
  if (unchanged.kind !== 'value') throw new Error('missing flat interval');
  for (const override of [{pairedMean: 0.25}, {interval: [-1, 1]}, {eligible: 8}, {verdict: 'positive'}])
    expect(isInterventionLiftOutcome({kind: 'value', value: {...unchanged.value, ...override}}, flat)).toBe(false);
  const assisted = cases[5];
  if (!isInterventionLiftInput(assisted)) throw new Error('invalid fixture');
  expect(isInterventionLiftOutcome(outcomes[0], assisted)).toBe(false);
  expect(() => measureInterventionLift(input([positive[0]!, positive[0]!]))).toThrow('重复');
});

it('正式后测适配器只计独立分数并检查冻结预测身份及截止水位', async () => {
  const submission = use(1, 'activity.retentionPosttestSubmission');
  const forecastId = derivationId(ref(2).id);
  const observation = {submission, admittedAt:'3' as Tick, submittedAt: asOf, result:'correct' as const,
    novelty: 'fresh-context' as const, exposure: {kind: 'independent' as const}};
  const ctx = {learner: submission.learner, snapshotTick: observation.admittedAt, read: {
    fact: async () => snapshot(submission, {}, [purpose]),
    slot: async () => ({outcome: {kind: 'value', value: {forecastId, status: 'observed', observation}}}) }} as unknown as GatherContext;
  const reconcile = (id: number) => reconciledLiftAssessment(ctx, submission, {...target, key: 'posttest', forecastId: derivationId(ref(id).id)});
  await expect(reconcile(2)).resolves.toMatchObject({independence: 'independent', score: 1, novelty: 'transfer'});
  await expect(reconcile(3)).resolves.toBeNull();
  const assess = (change: Partial<Parameters<typeof liftAssessment>[2]>) =>
    liftAssessment(ctx, submission, {...observation, ...change}, target);
  for (const [exposure, independence] of [[{kind: 'exposed', refs: []}, 'assisted'],
    [{kind: 'unknown', reason: 'opened'}, 'unknown']] as const)
    await expect(assess({exposure})).resolves.toMatchObject({independence, score: null});
  await expect(assess({admittedAt: '4' as Tick})).resolves.toBeNull();
});

it('经 Python worker 和真实内核采纳 Lift，生成待审黄灯提案', {timeout: 60_000}, async ({ onTestFinished }) => {
  const learner = learnerId(ref(90).id);
  const id = identity.playbookId;
  const data = playbook({version: 1, strategyId: identity.strategyId, preconditions: ['分段'], strategy_steps: ['画图'],
    counterexamples: ['非连续区间'], exit_conditions: ['独立标出区间'],
    reflection: {rationale: '标图待复验', metric: '独立变式', evidence_refs: [ref(95)]}});
  const scope = {learner, purpose};
  const hooks = createPropagationHooks([]);
  const worker = createPythonDeriverHost();
  onTestFinished(worker.close);
  await withLearnerDatabase(learner, async db => {
    const handler = createCommandHandler(db, {modules: [await loadStudioTestModule('learner')], hooks});
    const apply = factWriter(db, scope);
    const sources = positive.flatMap(({intervention, baseline, posttest}) => [intervention, baseline!.submission, posttest!.submission]);
    await apply([seed(use(94, 'activity.workbookAttempt'), [purpose]), ...[ref(95), ...sources].map(({id}) =>
      seed({id, type: 'activity.workbookAttempt'}, [purpose, 'teaching']))], 100);
    expect(() => propose.schema.parse({id, data: {...data, status: 'verified'}})).toThrow(/未知字段/);
    await handler({...scope, id: command(99), input: {id, data}, type: propose.type, actor: 'learner'});
    const researchOnly = propose.schema.parse({id, data: {...data, reflection: {...data.reflection, evidence_refs: [ref(94)]}}});
    const gather = (plan: Parameters<typeof gatherSnapshot>[2], readPurpose = purpose) =>
      gatherSnapshot(db, {learner, purpose: readPurpose}, plan);
    const candidate = await gather(async ctx => ({
      kind: 'input', effects: [], data: await propose.write(ctx, researchOnly, undefined),
    }));
    expect(candidate.plan).toMatchObject({data: [{kind: 'create', data: researchOnly.data, purpose: ['storage', purpose]}]});
    const gatherState = (ctx: GatherContext) => status.gather(ctx, {playbookId: id});
    const run = async (slotType: string, slotKey: string, deriver: string,
      plan: Parameters<typeof gatherSnapshot>[2], derive: (input: unknown) => unknown) => {
      const policy = {slot: {type: slotType}, deriver, purpose};
      const work = await db.tx(scope, tx => tx.withLearnerWrite(tick => enqueueWork(tx, tick, {slotType, slotKey, deriver})));
      const sealed = await sealCandidate(db, work, policy, await gather(plan));
      if (sealed.kind !== 'sealed') throw new Error('未冻结候选');
      const result = await submitCandidate(db, work, policy, sealed.id, await derive(sealed.plan.data), hooks);
      expect(result, JSON.stringify(result)).toMatchObject({kind: 'effective'});
      return sealed;
    };
    const liftKey = interventionLiftKey(id, 1);
    for (const [pairs, expected] of [[positive, 'verified'], [negative, 'demoted']] as const) {
      const measured = await run(lift.slot, liftKey, lift.name, ctx => lift.gather(ctx, async () => input(pairs)),
        async payload => { const result = await worker.derive(interventionLiftMethod, payload); return result.kind === 'ok' ? result.outcome : result; });
      const state = await run(status.slot, id, status.name, gatherState,
        payload => status.derive(payload as Parameters<typeof status.derive>[0]));
      expect(state.plan).toMatchObject({data: {status: expected, liftId: measured.id}});
      expect(state.manifest.inputs).toContainEqual({kind: 'slot', slotType: lift.slot, slotKey: liftKey,
        derivationId: measured.id, mode: 'following'});
      const teaching = await gather(async ({read}) =>
        ({kind: 'input', effects: [], data: await readVerifiedPlaybook(read, ref(0))}), 'teaching');
      expect(teaching.plan).toMatchObject({data: expected === 'verified' ? {status: {status: expected}} : null});
      if (expected === 'verified') continue;
      expect(state.plan).toMatchObject({data: {gardeningProposal: {light: 'yellow'}}});
      const proposal = (state.plan.data as Parameters<typeof status.derive>[0]).gardeningProposal!;
      const proposalId = command(101);
      await expect(handler({...scope, ...proposal.command, id: proposalId, actor: 'companion'})).resolves.toMatchObject({state: 'proposed'});
      await expect(handler.decideProposal({...scope, id: command(102), type: retire.type,
        proposalId, selection: 'accept'}, async (_tx, input) => input)).rejects.toThrow('slot reads are not implemented');
      expect(await db.snapshot(scope, tx => readCommandProposals(tx, retire.type, {}, proposalId))).toMatchObject([{state: 'pending'}]);
      expect(verifiedStatus(id, data, {id: measured.id, slot: {learner, type: lift.slot, key: liftKey},
        outcome: {kind: 'value', value: {...identity, version: 2, verdict: 'negative'}}}).status).toBe('candidate');
    }
    const source = positive[0]!.posttest!.submission;
    await apply([{kind: 'set_purpose', id: source.id, expectedRev: source.rev, purpose: ['teaching']}], 103);
    await apply([{kind: 'set_purpose', id: source.id, expectedRev: 2 as Revision, purpose: [purpose, 'teaching']}], 104);
    await expect(gather(gatherState)).rejects.toThrow('Derivation input is invalid or denied');
  }, {postgres: Boolean(testDatabaseUrl)});
});
