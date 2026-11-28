import { expect, it } from 'vitest';
import type { CanonicalEvidenceSliceV1, EvidenceEventV1, FactId, Revision, Tick } from '@mangekyo/kernel';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { buildCanonicalEvidenceSliceV2, adaptV1SliceToV2, adaptV2SliceToV1 } from './evidence-slice-v2.ts';
import { buildSelectionEvidenceSlice } from './question-selection.ts';
import { indexRecordFlowSnapshot, type RawFlowFact } from './record-flow.ts';
import { readConceptMastery, type TextbookMasteryEvidenceAnchor, type TextbookMasteryScope } from './textbook-mastery.ts';
import { defaultRetentionMethod, freezeCognition, independentRetentionEvidence, type CognitionOutput, type RetentionInput } from './retention.ts';
import { evaluateShadowCalibrationPkFromCases, type RetentionReplayCases } from './shadow-calibration-pk.ts';

const at = '2026-11-21T00:00:00.000Z';
const base = { clock_watermark: '9' as Tick, as_of_at: at, constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [] };
const ev = (over: Record<string, unknown>) => ({ ref: 'a', rev: 1, occurred_at: at, concept_ids: ['c1'],
  item_novelty: 'same', help_level: 'independent', outcome: 'correct', claim_ids: [], ...over });
const crit = (kcId: string) => ({ criterion_id: 'k', input_refs: [], earned: 1, maximum: 1, outcome: 'correct',
  kc_links: [{ kc_id: kcId, weight: 1, role: 'target', source: 'authored' }], evaluator: { id: 'e', version: '1' } });
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
  const [partial, scored, ratio] = await Promise.all([
    deriveValue(host, { ...base, events: [ev({ outcome: 'partial' })] }),
    deriveValue(host, { ...base, events: [ev({ outcome: 'partial', score_norm: 0.8 })] }),
    deriveValue(host, { ...base, events: [ev({ criteria: [{ ...crit('c1'), outcome: 'partial', earned: 9, maximum: 10 }] })] })]);
  expect([partial.state_vector[0]?.mastery_prob, scored.state_vector[0]?.mastery_prob, ratio.state_vector[0]?.mastery_prob])
    .toEqual([0.5, expect.closeTo(1.32 / 2.4, 10), expect.closeTo(1.36 / 2.4, 10)]);
  const items = [ev({ ref: 's#i1' }), ev({ ref: 's#i2' })];
  const shield = async (omission: Record<string, unknown>) =>
    (await deriveValue(host, { ...base, omissions: [omission], events: items })).state_vector[0]?.evidence_refs.length ?? 0;
  expect([await shield({ ref: { id: 's', rev: 1 }, item_id: 'i1', reason: 'retraction' }),
    await shield({ ref: { id: 's', rev: 1 }, reason: 'retraction' })]).toEqual([1, 0]);
  const ig = await host.derive('plan/information-gain@1', { ...base,
    events: [ev({ concept_ids: ['c1'], outcome: 'unknown', criteria: [crit('c1')] })],
    candidate_pool: [{ ref: 'cand', concept_ids: ['c1'], item_novelty: 'same', est_min: 3 }] });
  expect(ig.kind === 'ok' && ig.outcome.kind === 'value' &&
    (ig.outcome.value as { ranked_candidates: { reason_code: string }[] }).ranked_candidates[0]?.reason_code).toBe('reduce-uncertainty');
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
    readEvidence: async () => ({ completeConceptIds: concepts, anchors,
      slice: { ...base, events, constraints: base.constraints } }),
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
  const critEvent = ev({ concept_ids: ['c1', 'c2', 'c3', 'c4'], outcome: 'unknown', criteria: [crit('c1')] }) as never as EvidenceEventV1;
  const zero = await mastery([critEvent], [anchorFor(critEvent, 'i1')], ['c1', 'c2', 'c3', 'c4']);
  expect(['c1', 'c2', 'c3', 'c4'].map(id => zero.view.concept(id).state)).toEqual(['steady', 'unknown', 'unknown', 'unknown']);
  const pair = () => [ev({ ref: 's#i1' }), ev({ ref: 's#i2', outcome: 'incorrect' })] as EvidenceEventV1[];
  const anchors = [anchorFor(pair()[0]!, 'i1'), anchorFor(pair()[1]!, 'i2')];
  const forward = await mastery(pair(), anchors, ['c1']);
  const reversed = await mastery([...pair()].reverse(), anchors, ['c1']);
  expect(reversed.captured).toEqual(forward.captured);
  expect(JSON.stringify(reversed.view.concept('c1'))).toBe(JSON.stringify(forward.view.concept('c1')));
  const multiEv = ev({ concept_ids: ['c1', 'c2'] }) as EvidenceEventV1;
  const narrowed = await mastery([multiEv], [anchorFor(multiEv, 'i1')], ['c1']);
  expect(JSON.parse(narrowed.captured[0] as string)[0].criteria?.[0]?.kc_links).toEqual([{ kc_id: 'c1', weight: 0.5, role: 'target', source: 'question_fallback' }]);
});

it('retention bucket: criteria 指向的 KC 之外零计入且未知整题可由 criterion 冻结', () => {
  const event = { ...ev({ concept_ids: ['k1', 'k2'], outcome: 'unknown' }), criteria: [crit('k1')] };
  const input = (kcId: string): RetentionInput => ({ window: { requestedAt: at, through: at }, observedThrough: '9' as Tick, observations: [],
    canonicalEvidence: { ...base, events: [event] as never },
    target: { activity: 'frozen-workbook-item', paper: { id: 'p' as FactId, rev: 1 as Revision }, itemId: 'q', condition: 'same-item', gradingVersion: '1', dimensions: { kcId } } });
  const frozen = freezeCognition(input('k1'), { method_version: defaultRetentionMethod, state_vector: [{ state: 'known', concept_id: 'k1',
    item_novelty: 'same', representation: null, context: null, method: null, uncertainty: { kind: 'interval', low: .2, high: .9 },
    evidence_refs: [{ ref: 'a', rev: 1 }], r_now: .7, effective_evidence: 1 }] });
  expect([independentRetentionEvidence(input('k1')).length, independentRetentionEvidence(input('k2')).length, frozen.estimate.kind]).toEqual([1, 0, 'probabilistic']);
});

const factRow = (id: string, type: string, tick: string, data: unknown): RawFlowFact => ({ id, type, rev: 1, author: 'test', createdTick: tick, data });
it('deriveEventsFromSnap: partial/score_norm 保留、novelty 真实区分、item 级 omission', () => {
  const edgeRow = (id: string, kind: string, from: string, fromKind: string, to: string, toKind: string) =>
    factRow(id, 'content.knowledgeEdge', '2', { kind, from: { kind: fromKind, sourceUse: { id: from } }, to: { kind: toKind, sourceUse: { id: to } } });
  const attempt = (id: string, submittedAt: string, feedback: readonly Record<string, unknown>[]) =>
    factRow(id, 'activity.workbookAttempt', '6', { paperId: 'p', submittedAt, helpLevel: 'independent', feedback });
  const facts = [
    edgeRow('t1', 'targets_concept', 'q1', 'question', 'c1', 'concept'), edgeRow('t2', 'targets_concept', 'q2', 'question', 'c1', 'concept'),
    edgeRow('v1', 'variant_of', 'q1', 'question', 'q2', 'question'),
    factRow('p', 'activity.workbookPaper', '5', { questions: [{ id: 'i1', sourceQuestionRef: { id: 'q1', rev: 1 } }, { id: 'i2', sourceQuestionRef: { id: 'q2', rev: 1 } }] }),
    attempt('a1', '2026-11-20T01:00:00.000Z', [{ questionId: 'i1', result: 'partial', scoreNorm: 0.4 }]),
    attempt('a2', '2026-11-20T02:00:00.000Z', [{ questionId: 'i1', result: 'correct' }]),
    attempt('a3', '2026-11-20T03:00:00.000Z', [{ questionId: 'i2', result: 'correct' }]),
    factRow('a4', 'activity.workbookAttempt', '7', { paperId: 'p', submittedAt: '2026-11-20T04:00:00.000Z',
      feedback: [{ questionId: 'i1', result: 'correct' }, { questionId: 'i2', result: 'correct' }] }),
  ];
  const built = buildSelectionEvidenceSlice({ clockWatermark: '9', asOfAt: '2026-11-21T00:00:00.000Z',
    exposureLocks: [], candidates: [], snap: indexRecordFlowSnapshot(facts, []) });
  const rows = built.slice.events.map(e => [e.ref, e.item_novelty, e.outcome, e.score_norm ?? null]);
  expect(rows).toEqual([['a1#i1', 'transfer', 'partial', 0.4], ['a2#i1', 'same', 'correct', null], ['a3#i2', 'isomorphic', 'correct', null]]);
  expect(built.slice.omissions).toEqual([
    { ref: { id: 'a4', rev: 1 }, item_id: 'i1', reason: 'unwitnessed-independence' },
    { ref: { id: 'a4', rev: 1 }, item_id: 'i2', reason: 'unwitnessed-independence' }]);
});

it('V1/V2 适配器 F37 零漂移且生产默认 cognition@3', async ({ onTestFinished }) => {
  const host = createPythonDeriverHost();
  onTestFinished(host.close);
  expect(defaultRetentionMethod).toBe('cognition@3');
  const legacy: CanonicalEvidenceSliceV1 = { ...base, events: [ev({})] as EvidenceEventV1[],
    omissions: [{ ref: { id: 'none', rev: 1 }, reason: 'x' }] };
  const v2 = adaptV1SliceToV2(legacy, { purpose: ['teaching'], recipient_id: 'wave', inputs: [] });
  const { schema_version: _version, ...v2Input } = v2;
  const [direct, lifted, reduced] = await Promise.all([
    deriveValue(host, legacy), deriveValue(host, v2), deriveValue(host, adaptV2SliceToV1(buildCanonicalEvidenceSliceV2(v2Input)))]);
  expect([lifted, reduced]).toEqual([direct, direct]);
});

const pkRow = (i: number, recordedP: number, shadowP: number | null): RetentionReplayCases[number] => ({
  forecastId: `f${i}`, exposure: 'independent', observed: i % 2 ? 'incorrect' : 'correct',
  recorded: { method: { id: 'r', version: '1' }, estimate: { kind: 'probabilistic', probability: recordedP,
      interval: [0, 1], uncertainty: .1, effectiveEvidence: 1, bucket: { kcId: 'k', representation: 'r', context: 'c', method: 'm' }, basis: null },
    status: i % 2 ? 'missed' : 'matched' },
  shadow: { estimate: shadowP === null ? { kind: 'unknown', reason: 'missing' } : { kind: 'probabilistic', probability: shadowP,
      interval: [0, 1], uncertainty: .1, effectiveEvidence: 1, bucket: { kcId: 'k', representation: 'r', context: 'c', method: 'm' }, basis: null },
    status: 'observed' },
  baseline: { probability: .5 } });
it('shadow PK: 成对交集公平比较且 ECE 改善未达门槛拒绝放行', () => {
  const wins = Array.from({ length: 20 }, (_, i) => pkRow(i, .8, i % 2 ? .1 : .9));
  const gated = evaluateShadowCalibrationPkFromCases(wins, { minCalibrationImprovement: 0.25 });
  const skewed = evaluateShadowCalibrationPkFromCases([...wins, pkRow(20, .9, null)]);
  const baseCheck = evaluateShadowCalibrationPkFromCases(Array.from({ length: 20 }, (_, i) => ({
    ...pkRow(i, .2, i === 0 ? .4 : 1), observed: 'correct' as const, baseline: { probability: i === 0 ? .5 : null } })));
  expect(evaluateShadowCalibrationPkFromCases(wins).verdict).toBe('shadow_wins_ready');
  expect([gated.verdict, gated.verdictReason.includes('校准误差改善未达门槛')]).toEqual(['tied_keep_active', true]);
  expect([skewed.recorded.scored, baseCheck.verdict]).toEqual([20, 'keep_active']);
});
