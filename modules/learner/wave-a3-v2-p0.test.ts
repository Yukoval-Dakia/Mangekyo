import { expect, it } from 'vitest';
import type { CanonicalEvidenceSliceV1, EvidenceEventV1, FactId, Revision, Tick } from '@mangekyo/kernel';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { isCanonicalEvidenceSliceV2 } from '../../executors/python-deriver/schema.ts';
import { graphMasterySources } from '../activity/graph-mastery-evidence.ts';
import { selectionEvidenceRows } from '../../runtime/studio/iqdb.ts';
import { buildCanonicalEvidenceSliceV2, adaptV1SliceToV2, adaptV2SliceToV1, formalItemCriteriaV2 } from './evidence-slice-v2.ts';
import { extractConceptForecastSignals, projectBatchConceptMastery } from './knowledge-mastery.ts';
import { buildSelectionEvidenceSlice } from './question-selection.ts';
import { indexRecordFlowSnapshot, type RawFlowFact } from './record-flow.ts';
import { readConceptMastery, type TextbookMasteryEvidenceAnchor, type TextbookMasteryScope } from './textbook-mastery.ts';
import { defaultRetentionMethod, freezeCognition, independentRetentionEvidence, retentionSlice, type CognitionOutput, type RetentionInput } from './retention.ts';
import { retentionBaseline, summarizeRetentionReplay } from './retention-replay.ts';
import { evaluateShadowCalibrationPk, evaluateShadowCalibrationPkFromCases, type RetentionReplayCases } from './shadow-calibration-pk.ts';

const at = '2026-11-21T00:00:00.000Z';
const base = { clock_watermark: '9' as Tick, as_of_at: at, constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [] };
const ev = (over: Record<string, unknown>) => ({ ref: 'a', rev: 1, occurred_at: at, concept_ids: ['c1'],
  item_novelty: 'same', help_level: 'independent', outcome: 'correct', claim_ids: [], ...over });
const crit = (kcId: string) => ({ criterion_id: 'k', input_refs: [], earned: 1, maximum: 1, outcome: 'correct' as const,
  kc_links: [{ kc_id: kcId, weight: 1, role: 'target' as const, source: 'authored' as const }], evaluator: { id: 'e', version: '1' } });
const deriveValue = async (host: ReturnType<typeof createPythonDeriverHost>, slice: unknown) => {
  const result = await host.derive('learner/cognition@3', slice);
  if (result.kind !== 'ok' || result.outcome.kind !== 'value') throw new Error('derive failed');
  return result.outcome.value as CognitionOutput & { anomalies: unknown[]; ranked_candidates: { reason_code: string }[] };
};

it('python: criterion 归因零污染、多 KC 分摊、partial 与 score_norm、omission 规范屏蔽', async ({ onTestFinished }) => {
  const host = createPythonDeriverHost();
  onTestFinished(host.close);
  const multiKc = ev({ concept_ids: ['c1', 'c2', 'c3', 'c4'], criteria: [crit('c1')] });
  expect((await deriveValue(host, { ...base, events: [multiKc] })).state_vector.map(row => row.concept_id)).toEqual(['c1']);
  const split = await deriveValue(host, { ...base, events: [ev({ concept_ids: ['x1', 'x2'] })] });
  expect(split.state_vector.map(row => [row.concept_id, row.mastery_prob, row.evidence_refs.length]))
    .toEqual([['x1', 1.2 / 2.2, 1], ['x2', 1.2 / 2.2, 1]]);
  const zeroLink = ev({ concept_ids: ['z1'], criteria: [{ ...crit('z1'), kc_links: [{ kc_id: 'z1', weight: 0, role: 'target', source: 'authored' }] }] });
  const cleanStage = ev({ concept_ids: ['s1'], outcome: 'incorrect', error_stage: 'reading', criteria: [{ ...crit('s1'), outcome: 'partial', score_norm: 0.5 }] });
  const hiErrClean = ev({ concept_ids: ['c1'], outcome: 'incorrect', confidence: 0.9, criteria: [crit('c1')] });
  const [zeroOut, stageOut, hiOut, conflict] = await Promise.all([
    deriveValue(host, { ...base, events: [zeroLink] }), deriveValue(host, { ...base, events: [cleanStage] }),
    deriveValue(host, { ...base, events: [hiErrClean], candidate_pool: [{ ref: 't', concept_ids: ['c1'], item_novelty: 'transfer', est_min: 3 }] }),
    host.derive('learner/cognition@3', { ...base, events: [ev({ concept_ids: ['z1'], criteria: [crit('z1')] }), zeroLink] })]);
  expect([zeroOut.state_vector[0]?.state, stageOut.state_vector[0]?.mastery_prob, hiOut.anomalies.length,
    hiOut.ranked_candidates[0]?.reason_code, conflict.kind === 'ok' && conflict.outcome.kind === 'value'])
    .toEqual(['unknown', 0.5, 0, 'probe-unknown', false]);
  const [partial, scored, ratio, ordA, ordB] = await Promise.all([
    deriveValue(host, { ...base, events: [ev({ outcome: 'partial' })] }),
    deriveValue(host, { ...base, events: [ev({ outcome: 'partial', score_norm: 0.8 })] }),
    deriveValue(host, { ...base, events: [ev({ criteria: [{ ...crit('c1'), outcome: 'partial', earned: 9, maximum: 10 }] })] }),
    deriveValue(host, { ...base, events: [ev({ criteria: [crit('c1'), { ...crit('c1'), criterion_id: 'k2', outcome: 'incorrect', earned: 0 }] })] }),
    deriveValue(host, { ...base, events: [ev({ criteria: [{ ...crit('c1'), criterion_id: 'k2', outcome: 'incorrect', earned: 0 }, crit('c1')] })] })]);
  expect([partial.state_vector[0]?.mastery_prob, scored.state_vector[0]?.mastery_prob, ratio.state_vector[0]?.mastery_prob, ordA.state_vector[0]?.stability_days])
    .toEqual([0.5, expect.closeTo(1.32 / 2.4, 10), expect.closeTo(1.36 / 2.4, 10), ordB.state_vector[0]?.stability_days]);
  const items = [ev({ ref: 's', item_id: 'i1' }), ev({ ref: 's#i2' })];
  const shield = async (omission: Record<string, unknown>) =>
    (await deriveValue(host, { ...base, omissions: [omission], events: items })).state_vector[0]?.evidence_refs.length ?? 0;
  expect([await shield({ ref: { id: 's', rev: 1 }, item_id: 'i1', reason: 'retraction' }), await shield({ ref: { id: 's', rev: 1 }, reason: 'retraction' })]).toEqual([1, 0]);
  const v2Items = [ev({ ref: 'v2s', fact_ref: { id: 'v2s', rev: 1 }, item_id: 'i1', outcome: 'correct' }),
    ev({ ref: 'v2s', fact_ref: { id: 'v2s', rev: 1 }, item_id: 'i2', outcome: 'incorrect' })];
  const revEquiv = [ev({ ref: 'r#i1', rev: 1 }), ev({ ref: 'r', rev: 1, fact_ref: { id: 'r', rev: 1 }, item_id: 'i1' }),
    ev({ ref: 'r#i1', rev: 2, outcome: 'incorrect' })];
  const [v2Cog, equivCog, ig] = await Promise.all([deriveValue(host, { ...base, events: v2Items }),
    deriveValue(host, { ...base, events: revEquiv }), host.derive('plan/information-gain@1', {
      ...base, events: [...v2Items, ...revEquiv, ev({ concept_ids: ['c1'], outcome: 'unknown', criteria: [crit('c1')] })],
      candidate_pool: [{ ref: 'cand', concept_ids: ['c1'], item_novelty: 'same', est_min: 3 }] })]);
  expect([v2Cog.state_vector[0]?.mastery_prob, equivCog.state_vector[0]?.evidence_refs.length,
    ig.kind === 'ok' && ig.outcome.kind === 'value' &&
    (ig.outcome.value as { ranked_candidates: { reason_code: string }[] }).ranked_candidates[0]?.reason_code])
    .toEqual([0.5, 2, 'reduce-uncertainty']);
});

const anchorFor = (event: { ref: string; rev: number }, itemId: string): TextbookMasteryEvidenceAnchor => ({
  submission: { id: event.ref.split('#')[0] as FactId, rev: 1 as Revision, learner: scope.learner, type: 'activity.workbookAttempt', mode: 'following', accessEpoch: '9' as Tick },
  question: { id: 'q' as FactId, rev: 1 as Revision, learner: scope.learner, type: 'content.asset', mode: 'following', accessEpoch: '9' as Tick },
  itemId, href: `/${itemId}`, recordedAt: '9' as Tick, basis: [] });
const scope: TextbookMasteryScope = { learner: 'l1' as TextbookMasteryScope['learner'], purpose: 'teaching', recipientId: 'wave', asOf: at, clockWatermark: '9' as Tick };
const mastery = async (events: readonly EvidenceEventV1[], anchors: readonly TextbookMasteryEvidenceAnchor[], concepts: readonly string[]) => {
  const captured: unknown[] = [];
  const sources = {
    prepareEvidence: () => undefined,
    readEvidence: async () => ({ completeConceptIds: concepts, anchors, slice: { ...base, events, constraints: base.constraints } }),
    derive: async (_s: unknown, method: { id: string; version: string }, slice: { events: readonly EvidenceEventV1[] }) => {
      captured.push(JSON.stringify(slice.events));
      return { method_version: `${method.id}@${method.version}`, state_vector: slice.events.map(event => ({
        state: 'known', concept_id: event.concept_ids[0], item_novelty: event.item_novelty, representation: null,
        context: null, method: null, uncertainty: { kind: 'interval', low: .1, high: .9 },
        evidence_refs: [{ ref: event.ref, rev: event.rev }], r_now: .8 })) };
    },
    reopen: async (_s: unknown, witnesses: readonly unknown[]) => witnesses,
  };
  const view = await readConceptMastery(scope, new Set(concepts), [], sources as never);
  return { view, captured };
};

it('textbook-mastery: criterion 归因零污染且多 item 乱序逐字节一致', async () => {
  const critEvent = ev({ concept_ids: ['c1', 'c2', 'c3', 'c4'], outcome: 'incorrect', criteria: [crit('c1')] }) as never as EvidenceEventV1;
  const zeroW = ev({ ref: 'z', concept_ids: ['c1'], criteria: [{ ...crit('c1'), kc_links: [{ kc_id: 'c1', weight: 0, role: 'target', source: 'authored' }] }] }) as never as EvidenceEventV1;
  const zero = await mastery([critEvent, zeroW], [anchorFor(critEvent, 'i1'), anchorFor(zeroW, 'i2')], ['c1', 'c2', 'c3', 'c4']);
  expect(['c1', 'c2', 'c3', 'c4'].map(id => [zero.view.concept(id).state, 'anchor' in zero.view.concept(id)])).toEqual([['steady', false], ['unknown', false], ['unknown', false], ['unknown', false]]);
  const pair = () => [ev({ ref: 's#i1' }), ev({ ref: 's#i2', outcome: 'incorrect' })] as EvidenceEventV1[];
  const anchors = [anchorFor(pair()[0]!, 'i1'), anchorFor(pair()[1]!, 'i2')];
  const forward = await mastery(pair(), anchors, ['c1']);
  const reversed = await mastery([...pair()].reverse(), anchors, ['c1']);
  const unkeyed = await mastery([ev({ ref: 's', outcome: 'incorrect' }), ev({ ref: 's', outcome: 'correct' })] as EvidenceEventV1[], anchors, ['c1']);
  const mismatched = await mastery([ev({ ref: 's', outcome: 'incorrect' }), ev({ ref: 's', outcome: 'correct' })] as EvidenceEventV1[], [anchors[0]!], ['c1']);
  expect([reversed.captured, JSON.stringify(reversed.view.concept('c1')),
    (JSON.parse(unkeyed.captured[0] as string) as { ref: string; outcome: string }[]).find(e => e.ref === '["s","i1"]')?.outcome,
    mismatched.view.concept('c1').state]).toEqual([forward.captured, JSON.stringify(forward.view.concept('c1')), 'incorrect', 'unknown']);
  const multiEv = ev({ concept_ids: ['c1', 'c2'] }) as EvidenceEventV1;
  const narrowed = await mastery([multiEv], [anchorFor(multiEv, 'i1')], ['c1']);
  expect(JSON.parse(narrowed.captured[0] as string)[0].criteria?.[0]?.kc_links).toEqual([{ kc_id: 'c1', weight: 0.5, role: 'target', source: 'question_fallback' }]);
});

it('retention bucket: criteria 指向的 KC 之外零计入且未知整题可由 criterion 冻结', () => {
  const event = { ...ev({ concept_ids: ['k1', 'k2'], outcome: 'unknown' }), criteria: [crit('k1')] };
  const input = (kcId?: string, evs: unknown[] = [event], obs: RetentionInput['observations'] = []): RetentionInput => ({
    window: { requestedAt: at, through: at }, observedThrough: '9' as Tick, observations: obs, canonicalEvidence: { ...base, events: evs as never },
    target: { activity: 'frozen-workbook-item', paper: { id: 'p' as FactId, rev: 1 as Revision }, itemId: 'q', condition: 'same-item', gradingVersion: '1', ...(kcId ? { dimensions: { kcId } } : {}) } });
  const frozen = freezeCognition(input('k1'), { method_version: defaultRetentionMethod, state_vector: [{ state: 'known', concept_id: 'k1',
    item_novelty: 'same', representation: null, context: null, method: null, uncertainty: { kind: 'interval', low: .2, high: .9 },
    evidence_refs: [{ ref: 'a', rev: 1 }], r_now: .7, effective_evidence: 1 }] });
  const obs1 = [{ submission: { id: 'a' as FactId, rev: 1 as Revision }, submittedAt: at, admittedAt: '9' as Tick, result: 'correct' as const, exposure: { kind: 'independent' as const } }];
  const local = input(undefined, [{ ...ev({ concept_ids: ['k1', 'k2'] }) }], obs1);
  const v2Base = retentionBaseline({ ...frozen, input: input('k1', [ev({ ref: 'v#1', concept_ids: ['k1'] }),
    ev({ ref: 'v', item_id: '1', concept_ids: ['k1'] }), ev({ ref: 'v#1', rev: 2, concept_ids: ['k1'], outcome: 'incorrect' })]) });
  const localCrits = (retentionSlice(local).events[0] as { criteria?: { kc_links: { weight: number }[] }[] }).criteria ?? [];
  const noLeak = extractConceptForecastSignals([{ effectiveTick: '9' as Tick, observedThrough: '9' as Tick, probability: .8,
    kcId: 'k1', paperQuestionIds: ['q:1'], basisRefs: [] }], new Set(['k2']), new Map([['q:1', ['k2' as FactId]]]));
  expect([independentRetentionEvidence(input('k1')).length, independentRetentionEvidence(input('k2')).length,
    independentRetentionEvidence(local).length, frozen.estimate.kind, retentionBaseline(frozen).probability,
    v2Base.probability, localCrits.map(c => c.kc_links[0]?.weight), noLeak.length]).toEqual([1, 0, 1, 'probabilistic', 1, 0.5, [0.5, 1], 0]);
});

const factRow = (id: string, type: string, tick: string, data: unknown): RawFlowFact => ({ id, type, rev: 1, author: 'test', createdTick: tick, data });
it('deriveEventsFromSnap: partial/score_norm 保留、novelty 真实区分、item 级 omission', () => {
  const edgeRow = (id: string, kind: string, from: string, fromKind: string, to: string, toKind: string) =>
    factRow(id, 'content.knowledgeEdge', '2', { kind, from: { kind: fromKind, sourceUse: { id: from } }, to: { kind: toKind, sourceUse: { id: to } } });
  const attempt = (id: string, submittedAt: string, feedback: readonly Record<string, unknown>[]) =>
    factRow(id, 'activity.workbookAttempt', '6', { paperId: 'p', submittedAt, helpLevel: 'independent', feedback });
  const facts = [
    edgeRow('t1', 'targets_concept', 'q1', 'question', 'c1', 'concept'), edgeRow('t2', 'targets_concept', 'q2', 'question', 'c1', 'concept'), edgeRow('t3', 'targets_concept', 'q3', 'question', 'c1', 'concept'),
    edgeRow('v1', 'variant_of', 'q4', 'question', 'q2', 'question'),
    factRow('p', 'activity.workbookPaper', '5', { questions: [{ id: 'i1', sourceQuestionRef: { id: 'q1', rev: 1 } }, { id: 'i2', sourceQuestionRef: { id: 'q2', rev: 1 } }, { id: 'i3', sourceQuestionRef: { id: 'q3', rev: 1 } }, { id: 'i4', sourceQuestionRef: { id: 'q4', rev: 1 } }] }),
    attempt('a1', '2026-11-20T01:00:00Z', [{ questionId: 'i1', result: 'partial', scoreNorm: 0.4 }, { questionId: 'i4', result: 'correct' }]),
    attempt('a2', '2026-11-20T01:00:00.500Z', [{ questionId: 'i1', result: 'incorrect', scoreNorm: 0 }]), attempt('a3', '2026-11-20T03:00:00.000Z', [{ questionId: 'i2', result: 'correct' }]),
    factRow('a4', 'activity.workbookAttempt', '7', { paperId: 'p', submittedAt: '2026-11-20T04:00:00.000Z', feedback: [{ questionId: 'i1', result: 'correct' }, { questionId: 'i3', result: 'correct' }] }),
    attempt('a5', '2026-11-20T05:00:00.000Z', [{ questionId: 'i3', result: 'correct' }]),
  ];
  const built = buildSelectionEvidenceSlice({ clockWatermark: '9', asOfAt: '2026-11-21T00:00:00.000Z', exposureLocks: [], candidates: [], snap: indexRecordFlowSnapshot(facts, [{ id: 'd1', slotType: 'activity.workbookFormalAssessment', slotKey: 'a2', value: { attemptId: 'a2', items: [{ itemId: 'i1', verdict: 'correct', score: { earned: 10, maximum: 10 } }] } }]) });
  expect(built.slice.events.map(e => [e.ref, e.item_novelty, e.outcome, e.score_norm ?? null])).toEqual([['a1#i1', 'transfer', 'partial', 0.4], ['a2#i1', 'same', 'correct', 1], ['a3#i2', 'isomorphic', 'correct', null], ['a5#i3', 'same', 'correct', null]]);
  expect(built.slice.omissions).toEqual([{ ref: { id: 'a4', rev: 1 }, item_id: 'i1', reason: 'unwitnessed-independence' }, { ref: { id: 'a4', rev: 1 }, item_id: 'i3', reason: 'unwitnessed-independence' }]);
});

it('V1/V2 适配器 F37 零漂移且生产默认 cognition@3', async ({ onTestFinished }) => {
  const host = createPythonDeriverHost();
  onTestFinished(host.close);
  expect(defaultRetentionMethod).toBe('cognition@3');
  const legacy: CanonicalEvidenceSliceV1 = { ...base, events: [ev({})] as EvidenceEventV1[],
    omissions: [{ ref: { id: 'none', rev: 1 }, reason: 'x' }] };
  const v2 = buildCanonicalEvidenceSliceV2({ ...adaptV1SliceToV2(legacy, { purpose: ['teaching'], recipient_id: 'wave', inputs: [{ ref: { id: 'a', rev: 1 }, access_epoch: '9' as Tick, mode: 'following', sticky: false }] }),
    concept_graph: { nodes: [{ kc_id: 'c1', kli_profile: 'procedural_fluency' }], edges: [{ from_kc_id: 'c1', to_kc_id: 'c1', kind: 'prereq_of', weight: 1, verified: true, ref: { id: 'e1', rev: 1 } }] } });
  const [direct, lifted, reduced] = await Promise.all([deriveValue(host, legacy), deriveValue(host, v2), deriveValue(host, adaptV2SliceToV1(v2))]);
  expect([lifted, reduced, isCanonicalEvidenceSliceV2(v2), isCanonicalEvidenceSliceV2({ ...v2, authorization: undefined }),
    isCanonicalEvidenceSliceV2({ ...v2, events: [{ ...v2.events[0]!, fact_ref: undefined }] }),
    isCanonicalEvidenceSliceV2({ ...v2, events: [{ ...v2.events[0]!, attribution_status: undefined }] })]).toEqual([direct, direct, true, false, false, false]);
});

  const pkEst = (p: number | null) => p === null ? { kind: 'unknown' as const, reason: 'missing' }
    : { kind: 'probabilistic' as const, probability: p, interval: [0, 1] as [number, number], uncertainty: .1, effectiveEvidence: 1, bucket: { kcId: 'k', representation: 'r', context: 'c', method: 'm' }, basis: null };
const pkRow = (i: number, recordedP: number, shadowP: number | null): RetentionReplayCases[number] => ({
  forecastId: `f${i}`, exposure: 'independent', observed: i % 2 ? 'incorrect' : 'correct',
  recorded: { method: { id: 'r', version: '1' }, estimate: pkEst(recordedP) as never, status: i % 2 ? 'missed' : 'matched' },
  shadow: { estimate: pkEst(shadowP), status: 'observed' }, baseline: { probability: .5 } });
it('shadow PK: 成对交集公平比较且 ECE 改善未达门槛拒绝放行', () => {
  const wins = Array.from({ length: 20 }, (_, i) => pkRow(i, .8, i % 2 ? .1 : .9));
  const gated = evaluateShadowCalibrationPkFromCases(wins, { minCalibrationImprovement: 0.25 });
  const skewed = evaluateShadowCalibrationPkFromCases([...wins, pkRow(20, .9, null)]);
  const baseCheck = evaluateShadowCalibrationPkFromCases(Array.from({ length: 20 }, (_, i) => ({
    ...pkRow(i, .2, i === 0 ? .4 : 1), observed: 'correct' as const, baseline: { probability: i === 0 ? .5 : null } })));
  const { paired: _, ...legacySummary } = summarizeRetentionReplay(wins);
  expect([evaluateShadowCalibrationPkFromCases(wins).verdict, evaluateShadowCalibrationPk(legacySummary as never).verdict, gated.verdict, gated.verdictReason.includes('校准误差改善未达门槛'), skewed.recorded.scored, skewed.recorded.probabilityCoverage, skewed.shadow.probabilityCoverage, skewed.coverageDelta, baseCheck.baseline.probabilityCoverage, baseCheck.verdict])
    .toEqual(['shadow_wins_ready', 'insufficient_sample', 'tied_keep_active', true, 20, 1, expect.closeTo(20 / 21, 10), expect.closeTo(-1 / 21, 10), expect.closeTo(1 / 20, 10), 'keep_active']);
});

it('生产链路: 4-KC formal assessment 零污染 + selectionEvidenceRows novelty 与重复作答', async ({ onTestFinished }) => {
  const host = createPythonDeriverHost();
  onTestFinished(host.close);
  const kcs = ['kc1', 'kc2', 'kc3', 'kc4'] as FactId[];
  const edge = (id: string, kind: string, from: string, to: string, toKind: string) =>
    factRow(id, 'content.knowledgeEdge', '1', { kind, from: { kind: 'question', sourceUse: { id: from } }, to: { kind: toKind, sourceUse: { id: to } } });
  const snap = indexRecordFlowSnapshot([
    ...kcs.map((k, i) => edge(`e${i}`, 'targets_concept', 'q1', k, 'concept')), edge('v1', 'variant_of', 'q2', 'q1', 'question'),
    factRow('p1', 'activity.workbookPaper', '2', { questions: [{ id: 'i1', sourceQuestionRef: { id: 'q1', rev: 1 } }],
      assessmentRelease: { items: [{ itemId: 'i1', criteria: [{ criterionId: 'cr1', maximum: 10, inputs: [],
        evaluator: { id: 'e', version: '1' }, kcLinks: [{ kcId: 'kc1', weight: 1, role: 'target', source: 'authored' }] }] }] } }),
    factRow('a1', 'activity.workbookAttempt', '3', { paperId: 'p1', submittedAt: '2026-11-20T01:00:00.000Z',
      helpLevel: 'independent', feedback: [{ questionId: 'i1', result: 'incorrect', scoreNorm: 0.1 }] }),
  ], [{ id: 'f1', slotType: 'activity.workbookFormalAssessment', slotKey: 'a1', value: {
    result: { submissionRef: { id: 'a1', rev: 1 }, outcomes: [{ itemId: 'i1', criterionId: 'cr1', state: 'scored', earned: 8 }] } } }]);
  const built = buildSelectionEvidenceSlice({ clockWatermark: '9', asOfAt: at, exposureLocks: [], candidates: [], snap });
  const snapCog = await deriveValue(host, built.slice);
  const rows = kcs.map(conceptId => ({ conceptId, submission: { id: 's1' as FactId, rev: 1 as Revision, type: 'activity.workbookAttempt' },
    questionId: 'q1' as FactId, questionRev: 1 as Revision, itemId: 'i1', occurredAt: '2026-11-20T01:00:00.000Z',
    recordedTick: '3' as Tick, outcome: 'partial' as const, scoreNorm: 0.8, exposure: 'independent' as const,
    helpLevel: 'independent' as const, criteria: [{ ...crit('kc1'), outcome: 'partial' as const, earned: 8, maximum: 10, score_norm: 0.8 }], basisRefs: [] }));
  const graphView = await readConceptMastery(scope, new Set(kcs), [], graphMasterySources({
    tx: {} as never, links: [], python: host, reopen: async refs => refs, isUnavailable: () => false,
    read: { fact: async (id: FactId) => ({ ref: { id, rev: 1 as Revision, learner: scope.learner }, type: 'activity.workbookAttempt', accessEpoch: '9' as Tick }) } as never,
    evidence: { attempts: rows, incompleteConceptIds: new Set() } }));
  const batch = projectBatchConceptMastery({ asOf: at, conceptIds: kcs, attempts: rows });
  const s3Row = { ...rows[0]!, submission: { id: 's3' as FactId, rev: 1 as Revision, type: 'activity.workbookAttempt' }, occurredAt: '2026-11-20T03:00:00.000Z' };
  const selRows = selectionEvidenceRows([rows[0]!,
    { ...rows[0]!, submission: { id: 's2' as FactId, rev: 1 as Revision, type: 'activity.workbookAttempt' }, questionId: 'q2' as FactId, itemId: 'i2', occurredAt: '2026-11-20T02:00:00.000Z' }, s3Row], snap);
  const priorOnlySnap = indexRecordFlowSnapshot([factRow('p1', 'activity.workbookPaper', '2', { questions: [{ id: 'i1', sourceQuestionRef: { id: 'q1', rev: 1 } }] }),
    factRow('a0', 'activity.workbookAttempt', '2', { paperId: 'p1', submittedAt: '2026-11-20T00:30:00.000Z', feedback: [{ questionId: 'i1', result: 'correct' }] })], []);
  const igOut = await host.derive('plan/information-gain@1', buildSelectionEvidenceSlice({
    clockWatermark: '9', asOfAt: at, exposureLocks: [], events: selRows.events, omissions: selRows.omissions,
    candidates: [{ id: 'q3', rev: 1, title: 'q3', prompt: 'q3', matchReasons: [], conceptIds: ['kc1'], novelty: 'transfer', estMin: 3, semanticScore: 1 }] }).slice);
  const rel = (criterionId: string) => ({ criterionId, maximum: 10, inputs: [], evaluator: { id: 'e', version: '1' } });
  const halfDone = formalItemCriteriaV2([{ criterionId: 'c1', state: 'scored', earned: 10 }, { criterionId: 'c2', state: 'unsubmitted' }], [rel('c1'), rel('c2')]);
  expect([snapCog.state_vector.map(r => r.concept_id), (snapCog.state_vector[0]?.mastery_prob ?? 0) > 0.5, built.slice.events[0]?.score_norm,
    kcs.map(k => graphView.concept(k).state), kcs.map(k => batch.get(k)?.status),
    selRows.events.map(e => [e.ref, e.item_novelty]), selectionEvidenceRows([s3Row], priorOnlySnap).events[0]?.item_novelty,
    igOut.kind === 'ok' && igOut.outcome.kind === 'value', formalItemCriteriaV2([{ criterionId: 'c1', state: 'partial' }]).outcome,
    halfDone.outcome, halfDone.scoreNorm, halfDone.criteria[0]?.outcome])
    .toEqual([['kc1'], true, 0.8, ['decaying', 'unknown', 'unknown', 'unknown'], ['steady', 'unknown', 'unknown', 'unknown'],
      [['s1#i1', 'transfer'], ['s2#i2', 'isomorphic'], ['s3#i1', 'same']], 'same', true, 'unknown', 'unknown', null, 'correct']);
});
