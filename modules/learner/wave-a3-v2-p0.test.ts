import { expect, it } from 'vitest';
import type { CanonicalEvidenceSliceV1, EvidenceEventV1, FactId, Revision, Tick } from '@mangekyo/kernel';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { isCanonicalEvidenceSliceV2 } from '../../executors/python-deriver/schema.ts';
import { readConceptAttemptEvidence } from '../activity/concept-evidence.ts';
import { graphMasterySources } from '../activity/graph-mastery-evidence.ts';
import { selectionEvidenceRows } from '../../runtime/studio/iqdb.ts';
import { buildCanonicalEvidenceSliceV2, adaptV1SliceToV2, adaptV2SliceToV1, formalItemCriteriaV2 } from './evidence-slice-v2.ts';
import { extractConceptForecastSignals, projectBatchConceptMastery } from './knowledge-mastery.ts';
import { buildSelectionEvidenceSlice } from './question-selection.ts';
import { FLOW_FACT_TYPES, indexRecordFlowSnapshot, projectRecordFlow, type RawFlowFact } from './record-flow.ts';
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
  const cPair = [crit('c1'), { ...crit('c2'), criterion_id: 'k2' }], cand = [{ ref: 'cand', concept_ids: ['c1'], item_novelty: 'same', est_min: 3 }];
  const dupBase = [ev({ ref: 'd', concept_ids: ['c1', 'c2'], criteria: cPair })], dupRev = [...dupBase, ev({ ref: 'd', concept_ids: ['c1', 'c2'], criteria: [...cPair].reverse() })];
  const [v2Cog, equivCog, dupA, dupB, igA, igB] = await Promise.all([deriveValue(host, { ...base, events: v2Items }),
    deriveValue(host, { ...base, events: revEquiv }), deriveValue(host, { ...base, events: dupBase }), deriveValue(host, { ...base, events: dupRev }),
    host.derive('plan/information-gain@1', { ...base, events: dupBase, candidate_pool: cand }),
    host.derive('plan/information-gain@1', { ...base, events: dupRev, candidate_pool: cand })]);
  expect([v2Cog.state_vector[0]?.mastery_prob, equivCog.state_vector[0]?.evidence_refs.length, dupB, igB]).toEqual([0.5, 2, dupA, igA]);
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
  const v2Base = retentionBaseline({ ...frozen, input: input('k1', [ev({ ref: 'v#1', concept_ids: ['k1', 'k2'], criteria: [crit('k1'), { ...crit('k2'), criterion_id: 'k2' }] }),
    ev({ ref: 'v', item_id: '1', concept_ids: ['k1', 'k2'], criteria: [{ ...crit('k2'), criterion_id: 'k2' }, crit('k1')] }), ev({ ref: 'v#1', rev: 2, concept_ids: ['k1'], outcome: 'incorrect' })]) });
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
    factRow('a1', 'activity.workbookAttempt', '3', { paperId: 'p1', submittedAt: '2026-11-20T01:00:00.000Z', helpLevel: 'independent', feedback: [{ questionId: 'i1', result: 'incorrect', scoreNorm: 0.1 }] }),
    factRow('a2', 'activity.workbookAttempt', '4', { paperId: 'p1', submittedAt: '2026-11-20T02:00:00.000Z', helpLevel: 'independent', feedback: [{ questionId: 'i1', result: 'incorrect', scoreNorm: 0.1 }] }),
  ], [
    { id: 'f0', slotType: 'activity.workbookFormalAssessment', slotKey: 'err', value: { kind: 'error', reason: 'boom' } },
    { id: 'f1', slotType: 'activity.workbookFormalAssessment', slotKey: 'a1', value: { kind: 'value', value: { result: { submissionRef: { id: 'a1', rev: 1 }, outcomes: [{ itemId: 'i1', criterionId: 'cr1', state: 'scored', earned: 8 }] } } } },
    { id: 'r1', slotType: 'activity.workbookRubricAssessment', slotKey: 'a1', value: { kind: 'value', value: { attemptId: 'a1', questionId: 'i1', verdict: 'incorrect' } } },
    { id: 'f2', slotType: 'activity.workbookFormalAssessment', slotKey: 'a2', value: { kind: 'value', value: { result: { submissionRef: { id: 'a2', rev: 1 }, outcomes: [{ itemId: 'i1', criterionId: 'cr1', state: 'partial', reason: 'm' }] } } } },
  ]);
  const built = buildSelectionEvidenceSlice({ clockWatermark: '9', asOfAt: at, exposureLocks: [], candidates: [], snap });
  const snapCog = await deriveValue(host, built.slice);
  const u = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5FA${n}` as FactId;
  const [subId, paperId, qId, eId, k1, k2, k3, k4] = [u(1), u(2), u(3), u(4), u(5), u(6), u(7), u(8)];
  const relCrit = (criterionId: string, kcId: FactId) => ({ criterionId, inputs: [{ slotId: 's', path: '' }], evaluator: { id: 'e', version: '1' }, parameters: {}, source: { kind: 'product-rubric', ref: { id: qId, rev: 1 } }, maximum: 10, missingEvidence: 'insufficient-evidence', kcLinks: [{ kcId, weight: 1, role: 'target', source: 'authored' }] });
  const relPaper = { title: 'p', materialId: null, savedAt: at, questions: [{ id: 'i1', kind: 'exact', prompt: 'q', answers: ['1'], selfCheck: false, explanation: null, sourceQuestionRef: { id: qId, rev: 1 } }],
    assessmentRelease: { releaseRef: { id: paperId, rev: 1 }, items: [{ itemId: 'i1', slots: [{ slotId: 's', schemaVersion: '1', fields: [{ path: '', kind: 'text' }] }], criteria: [relCrit('cr1', k1), relCrit('cr2', k2)] }] } };
  const attVal = { paperId, requestId: 'req-12345678', submittedAt: '2026-11-20T01:00:00.000Z', gradingVersion: 'workbook-v1', paper: relPaper, answers: { i1: '0' }, feedback: [{ questionId: 'i1', result: 'incorrect', answer: '0', expected: { kind: 'exact', values: ['1'] }, explanation: null }] };
  const runFormalRead = async (outcomes: unknown[], linkIds: readonly FactId[] = [k1, k3, k4], opts?: { denyId?: FactId; noSourceRef?: boolean }) => {
    const lr = u(9) as unknown as TextbookMasteryScope['learner'];
    const manifest = { version: 1, learner: lr, purpose: 'teaching', gatherTick: '3', inputs: [{ kind: 'fact', id: subId, rev: 1, accessEpoch: '9', mode: 'pinned' }] };
    const formalRows = [{ value: { kind: 'error', reason: 'x' }, manifest }, { value: { kind: 'value', value: { result: { releaseRef: { id: paperId, rev: 1 }, submissionRef: { id: subId, rev: 1 }, outcomes }, criteria: [] } }, manifest }];
    const paperObj = opts?.noSourceRef ? { ...relPaper, questions: [{ id: 'i1', kind: 'rubric', prompt: 'q', rubric: 'r', rubricVersion: 'rubric-v1', explanation: null }] } : relPaper;
    const attObj = opts?.noSourceRef ? { ...attVal, paper: paperObj, feedback: [{ questionId: 'i1', result: 'pending', answer: '0', expected: { kind: 'rubric', rubric: 'r', rubricVersion: 'rubric-v1' }, explanation: null }] } : attVal;
    let sawSql = false;
    const tx = { learner: lr, query: async (sql: string) => ({ rows:
      sql.includes('FROM derivations d') ? (sawSql = sql.includes("scope_keys->'submissionRef'->>'id'") && sql.includes("d.value->>'kind'='value'"), formalRows)
      : sql.includes('question_displayed') ? [{ question_displayed: true, printed: false, solution_presented: false, prior_attempt_feedback: false }]
      : sql.includes('cross_help') ? [{ seen: false, cross_help: false }]
      : sql.includes('submitted_at') ? [{ tick: '3', recorded_tick: '3', unchanged: true, submitted_at: attVal.submittedAt, condition: null }]
      : sql.includes('FROM fact_revs WHERE') ? [{ tick: '2' }] : sql.includes('FROM facts f') ? [{ id: subId, type: 'activity.workbookAttempt' }] : [] }) };
    const read = { fact: async (id: FactId) => { if (opts?.denyId && id === opts.denyId) throw Object.assign(new Error('denied'), { name: 'FactReadDeniedError' });
      return { ref: { id, rev: 1 as Revision, learner: lr }, type: id === subId ? 'activity.workbookAttempt' : id === paperId ? 'activity.workbookPaper' : 'content.asset', value: id === subId ? attObj : paperObj, accessEpoch: '9' as Tick }; } };
    const links = linkIds.map(conceptId => ({ questionId: qId, questionRev: 1 as Revision, conceptId, edgeRef: { id: eId, rev: 1 as Revision, type: 'content.knowledgeEdge' } }));
    const evRes = await readConceptAttemptEvidence(tx as never, read as never, links, () => false);
    const gv = await readConceptMastery({ ...scope, learner: lr }, new Set([k1, k2, k3, k4]), [], graphMasterySources({ tx: tx as never, links, read: read as never, python: host, reopen: async r => r, isUnavailable: () => false, evidence: evRes }));
    const leaked = evRes.attempts.some(a => a.criteria?.some(c => c.kc_links.some(l => l.kc_id === opts?.denyId)));
    return { sawSql, attempts: evRes.attempts.length, leaked, states: [k1, k2, k3, k4].map(k => gv.concept(k).state), rows: evRes.attempts };
  };
  const [pgHalf, pgPartial, pgCritOnly, pgDenied, pgNoSrc] = await Promise.all([
    runFormalRead([{ itemId: 'i1', criterionId: 'cr1', state: 'scored', earned: 8 }, { itemId: 'i1', criterionId: 'cr2', state: 'pending', reason: 'w' }]),
    runFormalRead([{ itemId: 'i1', criterionId: 'cr1', state: 'partial', reason: 'm' }, { itemId: 'i1', criterionId: 'cr2', state: 'pending', reason: 'w' }]),
    runFormalRead([{ itemId: 'i1', criterionId: 'cr1', state: 'pending', reason: 'w' }, { itemId: 'i1', criterionId: 'cr2', state: 'scored', earned: 9 }], []),
    runFormalRead([{ itemId: 'i1', criterionId: 'cr1', state: 'scored', earned: 8 }, { itemId: 'i1', criterionId: 'cr2', state: 'scored', earned: 9 }], [k1], { denyId: k2 }),
    runFormalRead([{ itemId: 'i1', criterionId: 'cr1', state: 'scored', earned: 10 }, { itemId: 'i1', criterionId: 'cr2', state: 'pending', reason: 'w' }], [], { noSourceRef: true })]);
  const inl2 = { ...pgNoSrc.rows[0]!, conceptId: k2, submission: { id: u(0), rev: 1 as Revision, type: 'activity.workbookAttempt' }, itemId: 'i2', occurredAt: '2026-11-20T02:00:00.000Z', recordedTick: '4' as Tick, criteria: [{ ...crit(k2), criterion_id: 'cr2', earned: 10, maximum: 10, score_norm: 1 }] };
  const inlFresh = selectionEvidenceRows([pgNoSrc.rows[0]!, inl2]), inlCog = await deriveValue(host, { ...base, events: inlFresh.events });
  const inlPriorSnap = indexRecordFlowSnapshot([factRow(paperId, 'activity.workbookPaper', '1', { questions: [{ id: 'i1' }, { id: 'i2' }] }),
    factRow('ih0', 'activity.helpExposure', '2', { kind: 'displayed', mount: { activityId: paperId, issuance: { id: paperId, rev: 1 }, item: { itemId: 'i1' } }, alsoAppliesTo: [], content: { id: paperId, rev: 1 }, step: { kind: 'hint', order: 1 } })], []);
  const inlPrior = selectionEvidenceRows([pgNoSrc.rows[0]!, inl2], inlPriorSnap);
  const rows = kcs.map(conceptId => ({ conceptId, submission: { id: 's1' as FactId, rev: 1 as Revision, type: 'activity.workbookAttempt' },
    questionId: 'q1' as FactId, questionRev: 1 as Revision, itemId: 'i1', occurredAt: '2026-11-20T01:00:00.000Z',
    recordedTick: '3' as Tick, outcome: 'partial' as const, scoreNorm: 0.8, exposure: 'independent' as const,
    helpLevel: 'independent' as const, criteria: [{ ...crit('kc1'), outcome: 'partial' as const, earned: 8, maximum: 10, score_norm: 0.8 }], basisRefs: [] }));
  const batch = projectBatchConceptMastery({ asOf: at, conceptIds: kcs, attempts: rows });
  const s3Row = { ...rows[0]!, submission: { id: 's3' as FactId, rev: 1 as Revision, type: 'activity.workbookAttempt' }, occurredAt: '2026-11-20T03:00:00.000Z' };
  const selRows = selectionEvidenceRows([rows[0]!, { ...rows[0]!, submission: { id: 's2' as FactId, rev: 1 as Revision, type: 'activity.workbookAttempt' }, questionId: 'q2' as FactId, itemId: 'i2', occurredAt: '2026-11-20T02:00:00.000Z' }, s3Row], snap);
  const priorOnlySnap = indexRecordFlowSnapshot([factRow('p1', 'activity.workbookPaper', '2', { questions: [{ id: 'i1', sourceQuestionRef: { id: 'q1', rev: 1 } }] }),
    factRow('h0', 'activity.helpExposure', '2', { kind: 'displayed', mount: { activityId: 'p1', issuance: { id: 'p1', rev: 1 }, item: { itemId: 'i1' } }, alsoAppliesTo: [], content: { id: 'q1', rev: 1 }, step: { kind: 'hint', order: 1 } })], []);
  const igOut = await host.derive('plan/information-gain@1', buildSelectionEvidenceSlice({ clockWatermark: '9', asOfAt: at, exposureLocks: [], events: selRows.events, omissions: selRows.omissions,
    candidates: [{ id: 'q3', rev: 1, title: 'q3', prompt: 'q3', matchReasons: [], conceptIds: ['kc1'], novelty: 'transfer', estMin: 3, semanticScore: 1 }] }).slice);
  const rel = (criterionId: string) => ({ criterionId, maximum: 10, inputs: [], evaluator: { id: 'e', version: '1' } });
  const halfDone = formalItemCriteriaV2([{ criterionId: 'c1', state: 'scored', earned: 10 }, { criterionId: 'c2', state: 'unsubmitted' }], [rel('c1'), rel('c2')]);
  const rfSnap = indexRecordFlowSnapshot([factRow('q1', 'content.asset', '1', { kind: 'question', title: 'Q1' }),
    ...kcs.map(k => factRow(k, k === 'kc2' ? 'activity.workspaceEntry' : 'content.asset', '1', { kind: 'concept', title: k })), ...kcs.map((k, i) => edge(`re${i}`, 'targets_concept', 'q1', k, 'concept')),
    factRow('p1', 'activity.workbookPaper', '2', { questions: [{ id: 'i1', sourceQuestionRef: { id: 'q1', rev: 1 } }], assessmentRelease: { items: [{ itemId: 'i1', criteria: [{ criterionId: 'cr1', maximum: 10, inputs: [], evaluator: { id: 'e', version: '1' }, kcLinks: [{ kcId: 'kc1', weight: 1, role: 'target', source: 'authored' }] }] }] } }),
    factRow('a1', 'activity.workbookAttempt', '3', { paperId: 'p1', submittedAt: '2026-11-20T01:00:00.000Z', feedback: [{ questionId: 'i1', result: 'incorrect', errorStage: 'reading' }] })], [
    { id: 'r1', slotType: 'activity.workbookRubricAssessment', slotKey: 'a1', value: { kind: 'value', value: { attemptId: 'a1', questionId: 'i1', verdict: 'incorrect', errorStage: 'reading', score: '0/10' } } },
    { id: 'f1', slotType: 'activity.workbookFormalAssessment', slotKey: 'a1', value: { kind: 'value', value: { result: { submissionRef: { id: 'a1', rev: 1 }, outcomes: [{ itemId: 'i1', criterionId: 'cr1', state: 'scored', earned: 10 }] } } } }]);
  const rfQ = projectRecordFlow('q1', rfSnap), rfK2 = projectRecordFlow('kc2', rfSnap), rfK3 = projectRecordFlow('kc3', rfSnap);
  const knownSnap = snapCog.state_vector.filter(r => r.state === 'known');
  expect([knownSnap.map(r => r.concept_id), (knownSnap[0]?.mastery_prob ?? 0) > 0.5, built.slice.events.map(e => [e.outcome, e.score_norm ?? null]),
    { sawSql: pgHalf.sawSql, attempts: pgHalf.attempts, states: pgHalf.states }, pgPartial.attempts, pgCritOnly.states, [pgDenied.leaked, pgDenied.states], pgNoSrc.states,
    inlFresh.events.map(e => e.item_novelty), inlCog.state_vector.map(r => [r.item_novelty, (r.effective_evidence ?? 0) > 0.7]), inlPrior.events.map(e => e.item_novelty),
    kcs.map(k => batch.get(k)?.status), rfQ?.attempts[0]?.verdict, rfQ?.attempts[0]?.scoreText, rfQ?.mastery.score, rfQ?.nextActions.some(a => a.kind === 'review_mistake'), rfK2?.mastery, rfK3?.mastery,
    selRows.events.map(e => [e.ref, e.item_novelty]), selectionEvidenceRows([s3Row], priorOnlySnap).events[0]?.item_novelty,
    (['activity.retentionPosttestSubmission', 'activity.recallSubmission', 'activity.helpExposure'] as const).every(t => FLOW_FACT_TYPES.includes(t)),
    igOut.kind === 'ok' && igOut.outcome.kind === 'value', formalItemCriteriaV2([{ criterionId: 'c1', state: 'partial' }]).outcome, halfDone.outcome, halfDone.scoreNorm, halfDone.criteria[0]?.outcome])
    .toEqual([['kc1'], true, [['partial', 0.8], ['unknown', null]], { sawSql: true, attempts: 1, states: ['decaying', 'unknown', 'unknown', 'unknown'] }, 0,
      ['unknown', 'decaying', 'unknown', 'unknown'], [false, ['decaying', 'unknown', 'unknown', 'unknown']], ['decaying', 'unknown', 'unknown', 'unknown'],
      ['transfer', 'transfer'], [['transfer', true], ['transfer', true]], ['same', 'transfer'],
      ['steady', 'unknown', 'unknown', 'unknown'], 'correct', '10/10', 1, false, { level: 'unknown', score: null, retrievability: null, evidenceCount: 0 }, { level: 'unknown', score: null, retrievability: null, evidenceCount: 0 },
      [['s1#i1', 'transfer'], ['s2#i2', 'isomorphic'], ['s3#i1', 'same']], 'same', true, true, 'unknown', 'unknown', null, 'correct']);
});
