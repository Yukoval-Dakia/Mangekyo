import { expect, it, vi } from 'vitest';
import { derivationId, learnerId, type GatherContext } from '@mangekyo/kernel';
import { witness } from './memory-evidence.ts';
import { admitExtraction, beliefsAsOf, blocksRefusal, effectiveDirective, extractionDecision, hypothesisView,
  projectExperience, type ExtractionActivity, type HypothesisEvidence } from './cognition.ts';
import status from './derivers/understanding-status.ts';
import propose from './commands/propose-playbook.ts';

const ref = (n: number) => witness({id: String(n).padStart(26, '0'), rev: 1, accessEpoch: '1'});
const at = (n: number) => new Date(n * 1000).toISOString();

it('separates real time and knowledge time, and keeps same-condition counterevidence', () => {
  const rows = [{validFrom: at(1), validTo: null, recordedAt: at(5), supersededAt: at(10)},
    {validFrom: at(1), validTo: at(4), recordedAt: at(10), supersededAt: null}];
  expect(beliefsAsOf(rows, {validAt: at(4), knownAt: at(9)})).toEqual([rows[0]]);
  expect(beliefsAsOf(rows, {validAt: at(4), knownAt: at(10)})).toEqual([]);
  const history = ['supports', 'supports', 'contradicts', 'contradicts', 'contradicts', 'supports'].map((d, i): HypothesisEvidence =>
    ({ref: ref(i+1), direction: d as HypothesisEvidence['direction'], occurredAt: at(i), recordedAt: at(i), origin: 'chronicle',
      assessment: i < 3 ? 'observation' : i === 3 ? 'independent-variant' : 'independent-transfer', source: 'business-event'}));
  const view = hypothesisView(history, {validAt: at(6), knownAt: at(5)});
  expect(view.trajectory.map(s => s.stage)).toEqual(['supported', 'disputed', 'improving', 'retired', 'relapsed']);
  expect(view.evidence).toHaveLength(6);
  expect(view.confidence.statement).toBe('unconfirmed');
});

it('honors exact reopening and TTL boundaries independently of wording or preference age', () => {
  const refusal = {goal: 'g', intent_key: 'reschedule', reopen_condition: {kind: 'at' as const, at: at(5)}};
  expect(blocksRefusal(refusal, {goal: 'g', intent_key: 'reschedule', learnerRequested: false, at: at(4)})).toBe(true);
  expect(blocksRefusal(refusal, {goal: 'g', intent_key: 'reschedule', learnerRequested: false, at: at(5)})).toBe(false);
  const common = {category: 'directive', validFrom: at(0), recordedAt: at(0), supersededAt: null,
    scope: {}, text: '先画图', sticky: true, evidence_refs: [ref(1)]} as const;
  expect(effectiveDirective({...common, kind: 'state', validTo: at(5)}, {validAt: at(5), knownAt: at(5)})).toBeNull();
  expect(effectiveDirective({...common, kind: 'preference', validTo: null}, {validAt: at(9e6), knownAt: at(9e6)})).toBeTruthy();
});

it('admits only clocked, permitted originals and keeps deterministic positive updates when model budget is zero', () => {
  const source: ExtractionActivity = {ref: ref(1), admittedAt: '3', kind: 'attempt', purpose: ['background-research'],
    conceptIds: ['k'], occurredAt: at(1), origin: 'chronicle'};
  const existing = [{ref: ref(2), conceptIds: ['k'], stage: 'supported' as const, sticky: false}];
  const host = {track: 'after-activity' as const, explicitLearnerIntent: false, afterClock: '2', clockThrough: '3', budgetAvailable: false,
    attempt: {source: ref(1), independent: true, allCorrect: true, novelty: 'transfer' as const, testedHypotheses: [ref(2).id],
      intervention: ref(3), firstUnfamiliarPostLessonTransfer: true, mastery: 0.87}};
  expect(extractionDecision(source, host, existing)).toMatchObject({model: 'none', contradictions: [{hypothesis: ref(2)}],
    evaluateLift: {posttest: ref(1)}, bridge: {conceptIds: ['k']}});
  for (const change of [{purpose: ['storage']}, {origin: 'consolidation' as const}, {admittedAt: '4'}])
    expect(extractionDecision({...source, ...change}, host, existing).contradictions).toEqual([]);
  const decision = extractionDecision(source, {...host, budgetAvailable: true}, existing);
  const edit = {op: 'success-strategy' as const, text: '拆段算', anchor: 'step', start: 0, excerpt: '拆段'};
  expect(admitExtraction(decision, source, [{anchor: 'step', text: '拆段算'}], existing, [edit])[0]).toMatchObject({stage: 'tentative'});
  expect(() => admitExtraction(decision, source, [], existing, [edit])).toThrow();
});

it('projects only the requested run, including costs and unresolved outcomes', () => {
  const run = {runId: 'r', agentId: 'a', objective: 'lesson', strategyId: 'draw', environmentVersion: null,
    startedAt: at(2), finishedAt: at(3), tokenCost: 0};
  expect(projectExperience(run, [{runId: 'r2', actionRef: ref(1), observationRefs: []}], []))
    .toMatchObject({actionRefs: [], verificationRefs: [], outcome: 'unknown', latencyMs: 1000, tokenCost: 0});
});

it('proposes a candidate and reads the current version-specific independent Lift and its actual witnesses', async () => {
  const learner = learnerId(ref(1).id);
  const id = ref(2).id;
  const data = {version: 1, strategyId: 'draw', preconditions: ['分段'], strategy_steps: ['画图'], counterexamples: [],
    exit_conditions: ['能独自标出区间'], reflection: {rationale: '独立标图待复验', metric: '独立变式', evidence_refs: [ref(3)]}};
  const result = {playbookId: id, version: 1, strategyId: 'draw', verdict: 'positive', verificationRefs: [ref(4)]};
  const slot = {learner, type: 'learner.interventionLift', key: JSON.stringify([id, 1])};
  const read = {fact: vi.fn(async (key: string) => ({ref: {...ref(key === id ? 2 : key === ref(3).id ? 3 : 4), learner},
    accessEpoch: '1', value: data, purpose: ['background-research'], type: key === id ? 'learner.playbook' : 'activity.workbookAttempt'})),
    slot: vi.fn(async () => ({id: derivationId(ref(5).id), slot, outcome: {kind: 'value', value: result}})), range: vi.fn()};
  const ctx = {learner, read, snapshotTick: '1'} as unknown as GatherContext;
  const input = propose.schema.parse({id, data});
  expect(await propose.write(ctx, input, undefined)).toMatchObject([{kind: 'create', data, purpose: ['storage','background-research']}]);
  const gather = () => status.gather(ctx, {playbookId: id});
  expect(await gather()).toMatchObject({data: {status: 'verified', liftId: ref(5).id}});
  expect(read.slot).toHaveBeenCalledWith(slot, {mode: 'following'});
  result.verdict = 'negative';
  expect(await gather()).toMatchObject({data: {status: 'demoted'}});
  result.version++;
  expect(await gather()).toMatchObject({data: {status: 'candidate'}});
  expect(() => propose.schema.parse({id, data: {...data, status: 'verified'}})).toThrow();
});

it('admits all six activity families, gating feedback by pattern count or reason and immediate writes by learner intent', () => {
  const base = {ref: ref(1), admittedAt: '1', purpose: ['background-research','teaching'], conceptIds: [], occurredAt: at(0), origin: 'chronicle' as const};
  const host = {track: 'after-activity' as const, afterClock: '0', clockThrough: '1', budgetAvailable: true, explicitLearnerIntent: false};
  for (const kind of ['conversation','attempt','intake','notes','artifact','feedback'] as const)
    expect(extractionDecision({...base, kind}, {...host, feedback: {samePatternCount: 2, hasReason: false}}, []).model).toBe('extract');
  expect(extractionDecision({...base, kind: 'feedback'}, host, []).model).toBe('none');
  expect(extractionDecision({...base, kind: 'feedback'}, {...host, feedback: {samePatternCount: 1, hasReason: true}}, []).model).toBe('extract');
  expect(extractionDecision({...base, kind: 'conversation'}, {...host, track: 'in-turn', explicitLearnerIntent: true}, []).model).toBe('save_belief');
});
