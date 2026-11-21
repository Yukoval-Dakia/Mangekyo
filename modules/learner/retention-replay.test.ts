import { projectClassroomRadar } from './classroom-radar.ts';
import { expect, it } from 'vitest';
import type { EvidenceEventV1, FactId, FactSnapshot, LearnerId, Revision, Tick } from '@mangekyo/kernel';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { evaluateStudioRetention } from '../../runtime/studio/retention.ts';
import { flashCheckPriority } from './flash-check.ts';
import { projectRetentionRead } from './retention-view.ts';
import { defaultRetentionMethod, freezeCognition, readPythonRetentionMethod, retentionSlice,
  type RetentionInput, type RetentionObservation } from './retention.ts';

const tick = '9007199254740997' as Tick;
const rev = 2 as Revision;
const now = '2026-11-21T00:00:00.000Z';
const submission = {id: 'a' as FactId, rev};
const paper = {id: 'p' as FactId, rev};
const answer = (confidence: number, result: 'correct' | 'incorrect' = 'correct') => ({
  observation: {submission, admittedAt: tick, submittedAt: now, exposure: {kind: 'independent'},
    result, confidence} satisfies RetentionObservation,
  event: {ref: submission.id, rev, occurred_at: now, item_novelty: 'same', concept_ids: [],
    help_level: 'independent', outcome: result, confidence, claim_ids: []} satisfies EvidenceEventV1,
});
const {observation, event} = answer(0.35);
const input: RetentionInput = {
  target: {activity: 'frozen-workbook-item', paper, itemId: 'q', condition: 'same-item', gradingVersion: '1'},
  window: {requestedAt: now, through: now}, observedThrough: tick, observations: [observation],
};
const frozen = {...input, canonicalEvidence: retentionSlice(input)};
const slice = (...events: EvidenceEventV1[]) => ({...frozen.canonicalEvidence, events});

it('binds the frozen cutoff and selects only the exact target from a multi-dimensional result', () => {
  const canonicalEvidence = slice({...event, item_novelty: 'transfer', concept_ids: ['K'], context: 'field'});
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
  const concepts = (events: EvidenceEventV1[], version?: string, observed: RetentionObservation = observation) => {
    const canonicalEvidence = slice(...events);
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
  const run = (frozenInput: RetentionInput, version = defaultRetentionMethod) =>
    evaluateStudioRetention(readPythonRetentionMethod(version)!, frozenInput, host);
  const aboveThreshold = {...input, observations: [answer(0.350001).observation]};
  const [guess, full, prior] = await Promise.all([run(frozen), run(aboveThreshold), run(frozen, 'cognition@2')]);
  expect(guess).toMatchObject({method: {version: '3'}, estimate: {masteryProb: 1.1 / 2.1, stabilityDays: 2.1,
    effectiveEvidence: expect.closeTo(0.1), basis: submission}});
  expect(full.estimate).toEqual(prior.estimate);
  expect(full.estimate).toMatchObject({masteryProb: 1.4 / 2.4, stabilityDays: 2.4, effectiveEvidence: expect.closeTo(0.4)});

  const snapshot = (ref: typeof paper): FactSnapshot => ({
    ref: {learner: 'L' as LearnerId, ...ref}, type: 'example', value: {}, accessEpoch: tick, purpose: ['teaching'],
  });
  const facts = {papers: [snapshot(paper)], submissions: [snapshot(submission)]};
  const project = (sources = facts) => projectRetentionRead({
    id: 'forecast', key: 'key', effectiveTick: tick, value: {kind: 'value', value: guess},
  }, {id: 'forecast', value: guess}, sources, '/retention', (fact, itemId) => ({ref: fact.ref.id, rev: fact.ref.rev, itemId}));
  expect(project()).toMatchObject({flash_check_priority: 'lucky-guess-check',
    evidence: [{ref: 'p', rev, itemId: 'q'}, {ref: 'a', rev, itemId: 'q'}]});
  for (const denied of [{...facts, submissions: []}, {...facts, papers: [snapshot({...paper, rev: 1 as Revision})]}])
    expect(project(denied)).toBeUndefined();
  const priority = (input: RetentionInput) => flashCheckPriority({...guess, input});
  expect(flashCheckPriority(prior)).toBeUndefined();
  expect(priority(input)).toBeUndefined();
  expect(priority({...frozen, target: {...input.target, condition: 'variant'}})).toBeUndefined();
  const withheld = {...frozen.canonicalEvidence, omissions: [{ref: submission, reason: 'withheld'}]};
  for (const canonicalEvidence of [withheld, slice({...event, rev: 1}), slice(event, event),
    slice({...event, confidence: 0.3}), slice({...event, help_level: 'hinted'})])
    expect(priority({...input, canonicalEvidence})).toBeUndefined();
  const wrong = answer(0.9, 'incorrect');
  expect(priority({...input, observations: [wrong.observation], canonicalEvidence: slice(wrong.event)}))
    .toBe('high-confidence-error');
});

it('distinguishes an authorized empty forecast inventory from missing coverage', () => {
  expect(projectClassroomRadar(now, {forecasts: []})).toMatchObject({
    weakTop3: {kind: 'value', value: []}, forgetting24h: {kind: 'value', value: 0}});
  expect(projectClassroomRadar(now, {}).forgetting24h.kind).toBe('unknown');
});
