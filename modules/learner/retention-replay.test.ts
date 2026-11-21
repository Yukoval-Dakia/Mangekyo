import { projectClassroomRadar } from './classroom-radar.ts';
import { expect, it } from 'vitest';
import type { CanonicalEvidenceSliceV1, FactId, FactSnapshot, LearnerId, Revision, Tick } from '@mangekyo/kernel';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { flashCheckPriority } from './flash-check.ts';
import { projectRetentionRead } from './retention-view.ts';
import { defaultRetentionMethod, evaluateFrozenRetention, freezeCognition, readPythonRetentionMethod, retentionSlice,
  type CognitionOutput, type RetentionInput } from './retention.ts';

const tick = '9007199254740997' as Tick;
const rev = 2 as Revision;
const now = '2026-11-21T00:00:00.000Z';
const submission = {id: 'a' as FactId, rev};
const paper = {id: 'p' as FactId, rev};
const observation = {
  submission, admittedAt: tick, submittedAt: now, exposure: {kind: 'independent'}, result: 'correct', confidence: 0.35,
} satisfies RetentionInput['observations'][number];
const input: RetentionInput = {
  target: {activity: 'frozen-workbook-item', paper, itemId: 'q', condition: 'same-item', gradingVersion: '1'},
  window: {requestedAt: now, through: now}, observedThrough: tick, observations: [observation],
};
const event = {ref: submission.id, rev, occurred_at: now, item_novelty: 'same', concept_ids: [],
  help_level: 'independent', outcome: 'correct', confidence: observation.confidence, claim_ids: []} as const;
const slice = (events: CanonicalEvidenceSliceV1['events']): CanonicalEvidenceSliceV1 => ({
  ...retentionSlice(input), events,
});

it('binds the frozen cutoff and selects only the exact target from a multi-dimensional result', () => {
  const canonicalEvidence = slice([{...event, item_novelty: 'transfer', concept_ids: ['K'], context: 'field'}]);
  const classified: RetentionInput = {...input, observations: [], canonicalEvidence,
    target: {...input.target, condition: 'fresh-context', dimensions: {kcId: 'K', context: 'field'}}};
  expect(retentionSlice(classified)).toBe(canonicalEvidence);
  expect(() => retentionSlice({...classified, observedThrough: '2' as Tick})).toThrow(/cutoff/);
  const row = {state: 'known' as const, concept_id: 'K', item_novelty: 'transfer', representation: null, context: 'field',
    method: null, r_now: 0.7, effective_evidence: 2, evidence_refs: [{ref: submission.id, rev}],
    uncertainty: {kind: 'interval' as const, low: 0.2, high: 0.8}};
  const output = {method_version: 'cognition@1', state_vector: [{...row, context: 'class', r_now: 0.4}, row]};
  expect(freezeCognition(classified, output).estimate).toMatchObject({kind: 'probabilistic', probability: 0.7});
  const older = {...row, evidence_refs: [...row.evidence_refs, {ref: submission.id, rev: 1}]};
  expect(() => freezeCognition(classified, {...output, state_vector: [older]})).toThrow(/frozen target/);
  expect(freezeCognition({...classified, target: {...classified.target, condition: 'variant'}}, output).estimate.kind).toBe('unknown');
});

it('scopes only witnessed exact-item submissions to an unclassified target, preserving the raw slice', () => {
  const exact = ['frozen-item/p/2/q'];
  const concepts = (events: CanonicalEvidenceSliceV1['events'], version?: string, observed: RetentionInput['observations'][number] = observation) => {
    const canonicalEvidence = slice(events);
    const scoped = retentionSlice({...input, observations: [observed], canonicalEvidence}, version);
    expect(canonicalEvidence.events.every(row => !row.concept_ids.length)).toBe(true);
    return scoped.events.map(row => row.concept_ids);
  };
  const raw = [event, {...event, rev: 1}, {...event, ref: 'other'}, {...event, item_novelty: 'transfer' as const}];
  expect(concepts(raw)).toEqual([exact, [], [], []]);
  const exposed = {...observation, exposure: {kind: 'exposed' as const, refs: []}};
  for (const [version, expected] of [['cognition@1', []], ['cognition@2', exact]] as const)
    expect(concepts([{...event, help_level: 'hinted'}], version, exposed)).toEqual([expected]);
  expect(concepts([event, {...event, outcome: 'incorrect'}])).toEqual([[], []]);
});

it('uses one exact low-confidence correct answer for retention discount and the authorized flash check', async ({onTestFinished}) => {
  const host = createPythonDeriverHost();
  onTestFinished(host.close);
  const canonical = retentionSlice(input), frozen = {...input, canonicalEvidence: canonical};
  const run = (input: RetentionInput, version = defaultRetentionMethod) => {
    const method = readPythonRetentionMethod(version)!;
    return evaluateFrozenRetention(method, input, async slice => {
      const reply = await host.derive(method.deriver, slice);
      if (reply.kind !== 'ok' || reply.outcome.kind !== 'value') throw new Error(JSON.stringify(reply));
      return reply.outcome.value as CognitionOutput;
    });
  };
  const aboveThreshold = {...input, observations: [{...observation, confidence: 0.350001}]};
  const [guess, full, prior] = await Promise.all([run(frozen), run(aboveThreshold), run(frozen, 'cognition@2')]);
  expect(guess).toMatchObject({method: {version: '3'}, estimate: {masteryProb: 1.1 / 2.1, stabilityDays: 2.1,
    effectiveEvidence: expect.closeTo(0.1), basis: submission}});
  expect(full.estimate).toEqual(prior.estimate);
  expect(full.estimate).toMatchObject({masteryProb: 1.4 / 2.4, stabilityDays: 2.4, effectiveEvidence: expect.closeTo(0.4)});

  const snapshot = (ref: typeof paper): FactSnapshot => ({
    ref: {learner: 'L' as LearnerId, ...ref}, type: 'example', value: {}, accessEpoch: tick, purpose: ['teaching'],
  });
  const facts = {papers: [snapshot(paper)], submissions: [snapshot(submission)]};
  const project = (value: typeof guess, sources = facts) => projectRetentionRead({
    id: 'forecast', key: 'key', effectiveTick: tick, value: {kind: 'value', value},
  }, {id: 'forecast', value}, sources, '/retention', (fact, itemId) => ({ref: fact.ref.id, rev: fact.ref.rev, itemId}));
  expect(project(guess)).toMatchObject({flash_check_priority: 'lucky-guess-check',
    evidence: [{ref: 'p', rev, itemId: 'q'}, {ref: 'a', rev, itemId: 'q'}]});
  for (const denied of [{...facts, submissions: []}, {...facts, papers: [snapshot({...paper, rev: 1 as Revision})]}])
    expect(project(guess, denied)).toBeUndefined();
  const event = canonical.events[0]!;
  if ('exam_pacing' in event) throw new Error('Expected item evidence');
  const variants = [{...canonical, omissions: [{ref: submission, reason: 'withheld'}]},
    {...canonical, events: [{...event, rev: 1}]}, {...canonical, events: [event, event]},
    {...canonical, events: [{...event, confidence: 0.3}]},
    {...canonical, events: [{...event, help_level: 'hinted' as const}]}];
  const ineligible = [input, {...frozen, target: {...input.target, condition: 'variant' as const}},
    ...variants.map(canonicalEvidence => ({...input, canonicalEvidence}))];
  for (const forecast of [prior, ...ineligible.map(input => ({...guess, input}))])
    expect(flashCheckPriority(forecast)).toBeUndefined();
  const wrong = {...observation, result: 'incorrect' as const, confidence: 0.9};
  expect(flashCheckPriority({...guess, input: {...input, observations: [wrong],
    canonicalEvidence: {...canonical, events: [{...event, outcome: 'incorrect', confidence: 0.9}]}}})).toBe('high-confidence-error');
});

it('distinguishes an authorized empty forecast inventory from missing coverage', () => {
  expect(projectClassroomRadar(now, {forecasts: []})).toMatchObject({
    weakTop3: {kind: 'value', value: []}, forgetting24h: {kind: 'value', value: 0}});
  expect(projectClassroomRadar(now, {}).forgetting24h.kind).toBe('unknown');
});
