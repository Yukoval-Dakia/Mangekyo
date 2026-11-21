import { expect, it } from 'vitest';
import { ref as factRef } from './test/facts.ts';
import { admitExtraction, extractionDecision, hypothesisView,
  projectExperience, type ExtractionActivity, type HypothesisEvidence } from './cognition.ts';

const ref = (n: number) => factRef(n, '1');
const at = (n: number) => new Date(n * 1000).toISOString();

it('keeps same-condition counterevidence and tracks improvement, retirement and relapse', () => {
  const history = ['supports', 'supports', 'contradicts', 'contradicts', 'contradicts', 'supports'].map((d, i): HypothesisEvidence =>
    ({ref: ref(i+1), direction: d as HypothesisEvidence['direction'], occurredAt: at(i), recordedAt: at(i), origin: 'chronicle',
      assessment: i < 3 ? 'observation' : i === 3 ? 'independent-variant' : 'independent-transfer', source: 'business-event'}));
  const view = hypothesisView(history, {validAt: at(6), knownAt: at(5)});
  expect(view.trajectory.map(s => s.stage)).toEqual(['supported', 'disputed', 'improving', 'retired', 'relapsed']);
  expect(view.evidence).toHaveLength(6);
  expect(view.confidence.statement).toBe('unconfirmed');
});

it('gates activity extraction by permission, clock, feedback and intent while retaining deterministic updates', () => {
  const source: ExtractionActivity = {ref: ref(1), admittedAt: '3', kind: 'attempt', purpose: ['background-research'],
    conceptIds: ['k'], occurredAt: at(1), origin: 'chronicle'};
  const existing = [{ref: ref(2), conceptIds: ['k'], stage: 'supported' as const, sticky: false}];
  const funded = {track: 'after-activity' as const, explicitLearnerIntent: false, afterClock: '2', clockThrough: '3', budgetAvailable: true};
  const host = {...funded, budgetAvailable: false,
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
  const ordinary = {...source, purpose: ['background-research', 'teaching']};
  const repeated = {...funded, feedback: {samePatternCount: 2, hasReason: false}};
  for (const kind of ['conversation', 'attempt', 'intake', 'notes', 'artifact', 'feedback'] as const)
    expect(extractionDecision({...ordinary, kind}, repeated, []).model).toBe('extract');
  const feedback = {...ordinary, kind: 'feedback' as const};
  expect(extractionDecision(feedback, funded, []).model).toBe('none');
  expect(extractionDecision(feedback, {...funded, feedback: {samePatternCount: 1, hasReason: true}}, []).model).toBe('extract');
  expect(extractionDecision({...ordinary, kind: 'conversation'}, {...funded, track: 'in-turn', explicitLearnerIntent: true}, []).model).toBe('save_belief');
});

it('projects only the requested run, including costs and unresolved outcomes', () => {
  const run = {runId: 'r', agentId: 'a', objective: 'lesson', strategyId: 'draw', environmentVersion: null,
    startedAt: at(2), finishedAt: at(3), tokenCost: 0};
  expect(projectExperience(run, [{runId: 'r2', actionRef: ref(1), observationRefs: []}], []))
    .toMatchObject({actionRefs: [], verificationRefs: [], outcome: 'unknown', latencyMs: 1000, tokenCost: 0});
});
