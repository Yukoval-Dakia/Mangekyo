import type { BeliefTime, FactSnapshot } from '@mangekyo/kernel';
import { expect, it, vi } from 'vitest';
import { understandingProjection } from '../companion/understanding.ts';
import { beliefsAsOf, blocksRefusal, effectiveDirective, evidencePriority, hypothesesAsOf, hypothesisView, projectBelief,
  refusalBoundary, type HypothesisEvidence, type MetacognitiveRead } from './belief-view.ts';
import { activityEvidenceSlice } from '../activity/evidence-slice.ts';
import preferenceTeaching from './commands/preference-teaching.ts';
import { learner, ref, snapshot, use } from './test/facts.ts';

const at = (day: number) => new Date(day * 86_400_000).toISOString();
const asOf = (valid: number, known = valid) => ({validAt: at(valid), knownAt: at(known)});
const revisionTime: BeliefTime = {validFrom: at(1), recordedAt: at(2), supersededAt: null, validTo: null};
const fact = (id: number, type: string, value?: FactSnapshot['value']) => snapshot(use(id, type), value);
const project = (snapshot: FactSnapshot, time = revisionTime) =>
  projectBelief(snapshot, understandingProjection(snapshot)!, time)!;

it('keeps real preference and claim values stable and reads remembered, corrected and forgotten revisions', () => {
  const row = project(fact(10, 'learner.preference', {text: '先画图', scope: {subject: '物理'}}));
  expect(row.value).toMatchObject({category: 'directive', kind: 'preference', sticky: true, validTo: null,
    evidence_refs: [row.ref]});
  if (row.value.category !== 'directive') throw new Error('缺少偏好指令');
  expect(effectiveDirective(row.value, asOf(365))).toBe(row.value);
  expect(project(fact(11, 'companion.claim', {quote: '下次先给提示', source: ref(1)})).value)
    .toMatchObject({category: 'directive', kind: 'statement', validTo: null});

  const claim = {version: 1, action: 'remember', category: 'state', origin: 'turn', scope: {kind: 'general'},
    evidence_refs: [{...ref(2), start: 0, excerpt: '今天累'}], supersedes: null, text: '今天累', valid_until: at(8)};
  const original = fact(12, 'companion.claim', claim);
  const shortened = project(original, {...revisionTime, validTo: at(6), recordedAt: at(4)}).value;
  expect(shortened.validTo).toBe(at(6));
  const old = project(original, {...revisionTime, supersededAt: shortened.recordedAt}).value;
  const history = (valid: number, known: number) => beliefsAsOf([old, shortened], asOf(valid, known));
  expect(history(3, 1)).toEqual([]);
  expect(history(3, 3)).toEqual([{...old, category: 'directive'}]);
  expect(history(3, 4)).toEqual([shortened]);
  expect(history(8, 3)).toEqual([]);
  expect(history(6, 3)).toEqual([old]);
  expect(history(6, 4)).toEqual([]);
  const corrected = project(fact(14, 'companion.claim', {...claim, action: 'correct', origin: 'learner',
    evidence_refs: [], supersedes: ref(12), text: '今天只做一题'}), {...revisionTime, recordedAt: shortened.recordedAt}).value;
  expect(beliefsAsOf([corrected], asOf(3, 4))).toMatchObject([{category: 'directive', text: '今天只做一题'}]);
  expect(project(fact(13, 'companion.claim', {...claim, action: 'forget', supersedes: ref(12)}))).toBeUndefined();
});

it('requires structured refusal keys and applies only the recorded reopening condition', () => {
  const request = {goal: 'exam', intent_key: 'push-practice', learnerRequested: false, at: at(4)};
  const boundary = refusalBoundary({goal: request.goal, intent_key: request.intent_key, reopen_condition: {kind: 'learner_request'}});
  const reworded = {...request, wording: '来一小题吧'};
  expect(blocksRefusal(boundary, reworded)).toBe(true);
  expect(blocksRefusal(boundary, {...request, goal: 'another-exam'})).toBe(false);
  expect(blocksRefusal(boundary, {...request, learnerRequested: true})).toBe(false);
  for (const change of [{intent_key: ''}, {reopen_condition: {kind: 'at', at: 'tomorrow'}},
    {reopen_condition: null}, {reopen_condition: {kind: 'learner_request', at: at(7)}}])
    expect(() => refusalBoundary({...boundary, ...change})).toThrow();

  const scheduled = {...boundary, reopen_condition: {kind: 'at' as const, at: at(7)}};
  expect(blocksRefusal(scheduled, {...reworded, at: at(6)})).toBe(true);
  expect(blocksRefusal(scheduled, {...reworded, at: at(7)})).toBe(false);
  const snapshot = fact(12, 'companion.claim', {version: 1, action: 'remember', authority: 'directive', category: 'refusal', origin: 'learner',
    text: '这周别再推荐', scope: {kind: 'general'}, supersedes: null, evidence_refs: [], refusal: scheduled});
  const row = projectBelief(snapshot, {...understandingProjection(snapshot)!, refusal: scheduled}, revisionTime)!;
  if (row.value.category !== 'directive' || row.value.kind !== 'refusal') throw new Error('缺少拒绝指令');
  expect(effectiveDirective(row.value, asOf(6))).toBe(row.value);
  expect(effectiveDirective(row.value, asOf(7))).toBeNull();
});

it('co-projects assertion formats, preserving both conflicting witnesses and temporal visibility', () => {
  const extracted = project(fact(20, 'companion.memoryAssertion', {version: 2, kind: 'preference', text: '总是先算',
    scope: {kind: 'general'}, ttl: null, sticky: false, undo_token: ref(9).id,
    evidence_refs: [{...ref(5), anchor: 'message', excerpt: '先算', direction: 'support'}]}));
  const manual = project(fact(21, 'companion.memoryAssertion', {text: '先画图', scope: {subject: '物理', validFrom: at(1)},
    links: [{kind: 'source', id: ref(6).id}], evidence: [{...ref(6), itemId: 'Q1', direction: 'support'}]}));
  const rows = [extracted, manual].flatMap(({ref, value}) => value.category === 'hypothesis' ? [{ref, value}] : []);
  const edge = {...revisionTime, validFrom: at(3), recordedAt: at(4), from_ref: extracted.ref, to_ref: manual.ref,
    basis: [use(7, 'activity.workbookAttempt')],
    kind: 'contradicts' as const, author: 'companion' as const, confidence: null, sticky: false};
  expect(rows.map(row => row.value.kind)).toEqual(['observation', 'observation']);
  const disputed = hypothesesAsOf(rows, [edge], asOf(3, 4), edge.basis);
  expect(disputed.hypotheses.map(row => [row.ref.id, row.value.status, row.value.evidence_refs[0].id]))
    .toEqual([[ref(20).id, 'disputed', ref(5).id], [ref(21).id, 'disputed', ref(6).id]]);
  for (const [candidate, when, opened] of [[edge, asOf(2, 4), edge.basis], [edge, asOf(3, 3), edge.basis],
    [edge, asOf(3, 4), []], [{...edge, from_ref: ref(20, '1')}, asOf(3, 4), edge.basis]] as const)
    expect(hypothesesAsOf(rows, [candidate], when, opened).relations).toEqual([]);
});

it('separates trust from attestation and outcome, excluding consolidation even when labeled as high trust', () => {
  expect(Object.values(evidencePriority)).toEqual([5, 5, 4, 3, 2, 1]);
  const item = (n: number, source: HypothesisEvidence['source']): HypothesisEvidence => ({
    ref: ref(n), occurredAt: at(1), recordedAt: at(2), origin: 'chronicle', source,
    direction: 'supports', assessment: 'independent-transfer',
  });
  const events = [item(1, 'learner-quote'), item(2, 'learner-quote'), item(3, 'agent-note'),
    item(4, 'agent-inference'), item(5, 'first-hand-tool'), {...item(6, 'business-event'), origin: 'consolidation' as const}];
  const review = hypothesisView(events, asOf(1, 2));
  expect(review.confidence).toEqual({statement: 'directly-attested', fact: 'tentative', outcome: 'unknown'});
  expect(review.evidence.map(event => event.ref.id)).not.toContain(ref(6).id);
  expect(hypothesisView([...events, item(7, 'independent-verification')], asOf(1, 2)).confidence)
    .toMatchObject({fact: 'supported', outcome: 'independently-observed'});
});

it('narrows legacy all-purpose preferences when the learner removes teaching', async () => {
  const snapshot = {...fact(10, 'learner.preference', {text: '先画图'}), purpose: ['all']};
  const context = {learner, read: {fact: vi.fn().mockResolvedValue(snapshot), slot: vi.fn(), range: vi.fn()}};
  const input = preferenceTeaching.schema.parse({id: snapshot.ref.id, expectedRev: 1, enabled: false});
  expect(await preferenceTeaching.write(context, {...input, enabled: true}, undefined)).toEqual([]);
  expect(await preferenceTeaching.write(context, input, undefined)).toEqual([
    {kind: 'set_purpose', id: snapshot.ref.id, expectedRev: input.expectedRev, purpose: ['storage']},
  ]);
});

it('requires two reopened independent submissions in distinct disciplines for a cross-subject habit', async () => {
  const [physics, math] = [use(3, 'content.asset'), use(4, 'content.asset')] as const;
  const facts = [fact(1, 'activity.workbookAttempt'), fact(2, 'activity.retentionPosttestSubmission'), fact(6, 'activity.workbookAttempt'),
    ...[physics, math].map(subject => snapshot(subject, {kind: 'discipline'}))];
  const reader = (secondSubject = math, secondHelp: 'independent' | 'hinted' = 'independent'): MetacognitiveRead => ({
    learner, purpose: 'teaching', reopen: async ({id}) => facts.find(row => row.ref.id === id),
    observe: async ({ref: submission, accessEpoch}, citation) => ({discipline: citation.anchor === 'first' ? physics : secondSubject, basis: [physics],
      slice: activityEvidenceSlice(accessEpoch, at(submission.id === ref(6).id ? 4 : 3), undefined, [{submission,
        occurredAt: at(submission.id === ref(6).id ? 4 : 2), concepts: [], novelty: 'transfer',
        helpLevel: submission.id === ref(1).id ? 'independent' : secondHelp, result: 'incorrect'}])}),
  });
  const read = reader();
  const count = async (second = ref(2), opened: MetacognitiveRead | null = read, when = asOf(3), includeLater = false) =>
    (await hypothesesAsOf<unknown, unknown>([{ref: ref(5), value: {...revisionTime, category: 'hypothesis', kind: 'metacognitive_habit',
      status: 'tentative', sticky: false, scope: {}, text: '漏读限制词',
      evidence_refs: [{...ref(1), direction: 'support', anchor: 'first'}, {...second, direction: 'support'},
        ...(includeLater ? [{...ref(6), direction: 'support'}] : [])],
    }}], [], when, [], opened ?? undefined)).hypotheses.length;
  expect(await count()).toBe(1);
  expect(await count(undefined, read, asOf(3, 4), true)).toBe(0);
  expect(await count(undefined, read, asOf(1, 3))).toBe(0);
  expect(await count(undefined, read, asOf(3, 2))).toBe(0);
  expect(await count(ref(1))).toBe(0);
  expect(await count(undefined, null)).toBe(0);
  expect(await count(ref(2, '1'))).toBe(0);
  expect(await count(undefined, {...read, purpose: 'background-research'})).toBe(0);
  expect(await count(undefined, reader(physics))).toBe(0);
  expect(await count(undefined, reader(math, 'hinted'))).toBe(0);
});
