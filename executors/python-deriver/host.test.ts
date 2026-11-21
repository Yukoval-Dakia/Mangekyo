import { spawn } from 'node:child_process';
import { pythonLines } from './test/worker.ts';
import { afterAll, expect, it } from 'vitest';
import { createPythonDeriverHost } from './host.ts';
import { isCanonicalEvidenceSlice, isCognitionResult } from './schema.ts';
import sample from './samples/fixed-clock.json' with { type: 'json' };

const cognition = 'learner/cognition@1';
const legacy = 'learner/retention-forecast@1';
const success = (value: unknown) => ({kind: 'ok', outcome: {kind: 'value', value}});
const host = createPythonDeriverHost();
afterAll(host.close);

it('replays one fixed-clock slice through the TS host and direct Python IPC', async () => {
  const nextDay = { ...sample, as_of_at: '2026-11-22T01:02:03.1Z' };
  const [initial, later, prior] = await Promise.all([
    host.derive(cognition, sample), host.derive(cognition, nextDay), host.derive(legacy, nextDay),
  ]);
  expect(initial).toMatchObject({ kind: 'ok', outcome: { kind: 'value', value: {
    state: 'known', method_version: 'cognition@1', r_now: 2 / 3,
    state_vector: [{ r_now: 2 / 3, stability_days: 3, evidence_refs: [{ ref: 'fixture-attempt', rev: 1 }] }],
  } } });
  const decay = 2 ** (-1 / 7);
  for (const [result, version, retention] of [
    [later, 'cognition@1', (2 / 3) * 2 ** (-1 / 3)], [prior, 'dimensioned-retention@1', (1 + decay) / (2 + decay)],
  ] as const) expect(result).toMatchObject(success({method_version: version, r_now: expect.closeTo(retention, 14)}));
  expect(await host.derive(cognition, sample)).toEqual(initial);

  const planning = { ...sample, events: [{ ...sample.events[0], confidence: 0.3 }],
    candidate_pool: [{ ref: 'variant', concept_ids: ['K'], item_novelty: 'transfer', est_min: 3 }] };
  expect(await host.derive('plan/information-gain@1', planning)).toMatchObject({ kind: 'ok', outcome: { value: {
    ranked_candidates: [{ ref: 'variant', info_gain: expect.closeTo(0.044110417748400965, 14) }],
  } } });

  const invalid = { ...sample, as_of_at: '2026-02-29T00:00:00Z' };
  const invalidSlice = 'invalid CanonicalEvidenceSlice@v1';
  expect(await host.derive(cognition, invalid)).toEqual({kind: 'failed', reason: invalidSlice});
  const requests = [sample, invalid].map((input, i) => ({id: String(i), deriver: cognition, input}));
  if (initial.kind !== 'ok') throw new Error('Missing initial result');
  expect(pythonLines(['worker.py'], requests)).toEqual([{id: '0', value: initial.outcome}, {id: '1', error: invalidSlice}]);

  const noIndependent = { ...sample, events: sample.events.map(event => ({ ...event, help_level: 'hinted' })) };
  const uncertainty = {kind: 'unknown', reason: 'missing-independent-scored-evidence'};
  expect(await host.derive(cognition, noIndependent)).toMatchObject(success({state: 'unknown', uncertainty}));
});

it('routes exam pacing and intervention Lift to one real worker with their own evidence contracts', async () => {
  const outcomes = await Promise.all([
    host.derive('plan/exam-pacing@1', {attempts: [
      {id: 'first', effective_duration_ms: 1000, score: {earned: 2, maximum: 2}},
      {id: 'second', effective_duration_ms: 2000, score: {earned: 1, maximum: 2}},
      {id: 'unmeasured', score: null},
    ]}),
    host.derive('learner/intervention-lift@1', {playbookId: '00000000000000000000000001',
      version: 1, strategyId: 'diagram', asOf: '2026-11-21T00:00:00.000Z', interventions: []}),
  ]);
  expect(outcomes[0]).toMatchObject({kind: 'ok', outcome: {kind: 'value', value: {
    strategy: {kind: 'observed', comparisons: [{extra_duration_ms: 1000, score_rate_gap: 0.5}]},
    attempts: [{id: 'first'}, {id: 'second'}, {kind: 'unknown', missing: ['effective_duration_ms', 'score']}],
  }}});
  expect(outcomes[1]).toMatchObject({kind: 'ok', outcome: {kind: 'unknown'}});
  expect(await host.derive('plan/exam-pacing@1', sample)).toMatchObject(success({attempts: [], strategy: {kind: 'unknown'}}));
  const exam = (ref: string, duration: number, earned: number) => ({...sample.events[0], ref,
    concept_ids: [], outcome: 'unknown', help_level: 'unknown', effective_duration_ms: duration, exam_pacing: {paper_key: 'paper@2', scale_key: 'release@4', score: {earned, maximum: 10}}});
  const events = [exam('recent', 2000, 6), exam('prior', 1000, 8), exam('withheld', 9000, 0)];
  const slice = {...sample, events, omissions: [{ref: {id: 'withheld', rev: 1}, reason: 'not available'}]};
  for (const event of [{...events[0], exam_pacing: undefined}, {...events[0], concept_ids: ['K']}, {...events[0], outcome: 'correct'}])
    expect(isCanonicalEvidenceSlice({...slice, events: [event]})).toBe(false);
  const pacing = await host.derive('plan/exam-pacing@1', slice);
  expect(pacing).toMatchObject({kind: 'ok', outcome: {kind: 'value', value: {
    attempts: expect.arrayContaining([expect.objectContaining({id: 'recent', paper_key: 'paper@2'})]),
    strategy: {kind: 'observed', comparisons: [{slower_attempt_id: 'recent', faster_attempt_id: 'prior', extra_duration_ms: 1000}]},
  }}});
  expect(JSON.stringify(pacing)).not.toContain('withheld');
  const {exam_pacing: _, ...neutral} = events[2]!;
  const hiddenItem = {...neutral, exam_pacing_item: {attempt_ref: {id: 'recent', rev: 1}, paper_key: 'paper@2',
    item_id: 'q2', position: 2, item_count: 2, skipped: true}};
  expect(await host.derive('plan/exam-pacing@1', {...slice, events: [...events, hiddenItem]})).toEqual(pacing);
  const process = {...hiddenItem, ref: 'timer', effective_duration_ms: 500};
  const first = {...process, exam_pacing_item: {...process.exam_pacing_item, item_id: 'q1', position: 1}};
  const timeValue = (ref: string) => host.derive('plan/exam-pacing@2', {attempt_ref: first.exam_pacing_item.attempt_ref,
    slice: {...slice, events: [...events, first, {...process, ref}]}});
  expect(await timeValue('second-timer')).toMatchObject(success({kind: 'observed', total_duration_ms: 1000}));
  expect(await timeValue('timer')).toEqual(success({method_version: 'plan/exam-pacing@2', attempt_ref: first.exam_pacing_item.attempt_ref, kind: 'unknown'}));
});

it('prioritizes the shortest matching variant with the frozen error revision', async () => {
  const event = sample.events[0]!;
  const error = { ...event, ref: 'wrong', rev: 2, outcome: 'incorrect', confidence: 0.8, error_stage: 'execution' };
  const candidate = { concept_ids: ['K'], item_novelty: 'isomorphic', est_min: 2 };
  const input = { ...sample, events: [event, error, { ...error, ref: 'later', occurred_at: '2026-11-22T00:00:00Z' }],
    candidate_pool: [{ ...candidate, ref: 'long', est_min: 4 }, { ...candidate, ref: 'short' },
      { ...candidate, ref: 'different-context', context: 'other', est_min: 1 }] };
  expect(await host.derive(cognition, input)).toMatchObject({kind: 'ok', outcome: {value: {
    method_version: 'cognition@1', state_vector: [{mastery_prob: 0.5}], anomalies: [{refs: ['wrong']}],
  }}});
  const withheld = {...input, omissions: [{ref: {id: 'wrong', rev: 2}, reason: 'withheld'}]};
  const filtered = await host.derive('learner/cognition@2', withheld);
  expect(filtered).toMatchObject({kind: 'ok', outcome: {value: {anomalies: [], state_vector: [{mastery_prob: 2 / 3}]}}});
  expect(JSON.stringify(filtered)).not.toContain('wrong');
  const graded = await host.derive('learner/cognition@2', input);
  expect(graded).toMatchObject({ kind: 'ok', outcome: { value: {
    state_vector: [{ mastery_prob: 2 / 3.5 }],
    ranked_candidates: [{ ref: 'short', reason_code: 'probe-high-confidence-error', evidence_refs: [{ ref: 'wrong', rev: 2 }] },
      { ref: 'long' }, { ref: 'different-context', reason_code: 'probe-unknown' }],
    anomalies: [{ refs: ['wrong'], evidence_refs: [{ ref: 'wrong', rev: 2 }], error_stage: 'execution' }],
  } } });
  if (graded.kind !== 'ok' || graded.outcome.kind !== 'value' || !isCognitionResult(graded.outcome.value))
    throw new Error('Missing graded result');
  expect(await host.derive('learner/cognition@3', input)).toEqual(success({...graded.outcome.value, method_version: 'cognition@3'}));
  const helped = { ...input, events: [{ ...event, help_level: 'hint_l1' }, { ...error, help_level: 'hint_l2' }] };
  expect(await host.derive('learner/cognition@2', helped)).toMatchObject(success({state: 'unknown'}));
});

it('weights error_stage losses and labels anomalies for graded methods only', async () => {
  const event = sample.events[0]!;
  const error = (ref: string, error_stage?: string, confidence = 0.8, concept_ids = ['K']) =>
    ({ ...event, ref, concept_ids, outcome: 'incorrect', confidence, ...(error_stage ? { error_stage } : {}) });
  const input = { ...sample, events: [
    event, error('execution-slip', 'execution'),
    { ...event, concept_ids: ['K2'] }, error('modeling-miss', 'modeling', 0.8, ['K2']),
    error('unclassified', undefined), error('quiet-slip', 'execution', 0.4, ['K3']),
  ] };
  const graded = await host.derive('learner/cognition@3', input);
  expect(graded).toMatchObject(success({
    state_vector: [
      // a=2; execution loss 0.5 + unclassified full loss -> b=2.5; K2 loses 1 fully.
      { concept_id: 'K', mastery_prob: 2 / 4.5 },
      { concept_id: 'K2', mastery_prob: 0.5 },
      // confidence 0.4 stays below the anomaly threshold; execution still halves its loss.
      { concept_id: 'K3', mastery_prob: 1 / 2.5 },
    ],
    anomalies: [
      { refs: ['unclassified'] },
      { refs: ['execution-slip'], error_stage: 'execution' },
      { refs: ['modeling-miss'], error_stage: 'modeling' },
    ],
  }));
  // cognition@1 keeps full loss and collapses stages into one unlabeled anomaly.
  const legacy = await host.derive('learner/cognition@1', input);
  expect(legacy).toMatchObject(success({
    anomalies: [{ refs: ['execution-slip', 'modeling-miss', 'unclassified'] }],
  }));
  expect(JSON.stringify(legacy)).not.toContain('error_stage');
});

it('marks only reading or execution misses on fast items as fast-slip in exam time-value', async () => {
  const at = '2026-11-21T10:00:00.000Z';
  const attemptRef = { id: 'sub', rev: 1 };
  const attempt = { ref: 'sub', rev: 1, occurred_at: at, concept_ids: [], item_novelty: 'same',
    help_level: 'unknown', outcome: 'unknown', claim_ids: [], effective_duration_ms: 200_000,
    exam_pacing: { paper_key: 'paper@1', scale_key: 'release@1', score: { earned: 4, maximum: 6 } } };
  const item = (role: 'proc' | 'est' | 'formal', item_id: string, position: number, fields: Record<string, unknown>) =>
    ({ ref: `${role}-${item_id}`, rev: 1, occurred_at: at, concept_ids: [], item_novelty: 'same',
      help_level: 'unknown', outcome: 'unknown', claim_ids: [],
      ...(role === 'proc' ? { effective_duration_ms: fields.duration } : {}),
      ...(fields.stage ? { error_stage: fields.stage } : {}),
      exam_pacing_item: { attempt_ref: attemptRef, paper_key: 'paper@1', item_id, position, item_count: 3,
        ...(role === 'est' ? { estimated_duration_ms: fields.estimate } : {}),
        ...(role === 'formal' ? { scale_key: 'release@1', score: fields.score } : {}) } });
  const events = (stageA?: string, stageB?: string) => [
    attempt,
    item('proc', 'q1', 1, { duration: 5_000 }), item('proc', 'q2', 2, { duration: 4_000 }),
    item('proc', 'q3', 3, { duration: 95_000 }),
    item('est', 'q1', 1, { estimate: 10_000 }), item('est', 'q2', 2, { estimate: 10_000 }),
    item('est', 'q3', 3, { estimate: 80_000 }),
    item('formal', 'q1', 1, { score: { earned: 0, maximum: 2 }, stage: stageA }),
    item('formal', 'q2', 2, { score: { earned: 0, maximum: 2 }, stage: stageB }),
    item('formal', 'q3', 3, { score: { earned: 2, maximum: 2 } }),
  ];
  const slice = (stageA?: string, stageB?: string) => ({ ...sample, as_of_at: at, events: events(stageA, stageB) });
  const derive = (stageA?: string, stageB?: string) =>
    host.derive('plan/exam-pacing@2', { slice: slice(stageA, stageB), attempt_ref: attemptRef });
  const states = (result: unknown) => (result as { outcome?: { value?: { items?: { state: string }[] } } })
    .outcome?.value?.items?.map(row => row.state);
  expect(states(await derive('reading', 'modeling'))).toEqual(['fast-slip', 'unknown', 'steady']);
  expect(states(await derive('execution', 'strategy'))).toEqual(['fast-slip', 'unknown', 'steady']);
  expect(states(await derive('expression'))).toEqual(['unknown', 'unknown', 'steady']);
  expect(states(await derive())).toEqual(['unknown', 'unknown', 'steady']);
});

it('starts the worker from warmup while derive keeps the same request contract', async ({ onTestFinished }) => {
  let starts = 0;
  const host = createPythonDeriverHost({
    spawnProcess: (python, args) => (++starts, spawn(python, args, { stdio: ['pipe', 'pipe', 'ignore'], env: {} })),
  });
  onTestFinished(host.close);
  host.warmup();
  expect(starts).toBe(1);
  expect(await host.derive(cognition, sample)).toMatchObject({ kind: 'ok', outcome: { kind: 'value' } });
  expect(starts).toBe(1);
});

it.for([
  { reason: 'timed out', script: 'import sys\nfor _ in sys.stdin: pass' },
  { reason: 'exited', script: 'import sys\nsys.stdin.readline()\nsys.exit(1)' },
])('returns failed when the worker $reason and starts a fresh process', async ({ script, reason }, { onTestFinished }) => {
  let starts = 0;
  const host = createPythonDeriverHost({
    timeoutMs: 1000,
    restartDelayMs: 0,
    spawnProcess: (python, args) => spawn(python, ++starts === 1
      ? ['-c', script]
      : [...args], { stdio: ['pipe', 'pipe', 'ignore'], env: {} }),
  });
  onTestFinished(host.close);
  expect(await host.derive(cognition, sample))
    .toEqual({ kind: 'failed', reason: expect.stringContaining(reason) });
  expect(await host.derive(cognition, sample)).toMatchObject({ kind: 'ok', outcome: { kind: 'value' } });
  expect(starts).toBe(2);
});
