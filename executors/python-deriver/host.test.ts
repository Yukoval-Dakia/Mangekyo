import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { createPythonDeriverHost } from './host.ts';
import { isCanonicalEvidenceSlice, isCognitionResult } from './schema.ts';
import sample from './samples/fixed-clock.json' with { type: 'json' };

const workerPath = fileURLToPath(new URL('./worker.py', import.meta.url));
const cognition = 'learner/cognition@1';
const legacy = 'learner/retention-forecast@1';
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
  expect(later).toMatchObject({ kind: 'ok', outcome: { kind: 'value', value: {
    method_version: 'cognition@1', r_now: expect.closeTo((2 / 3) * 2 ** (-1 / 3), 14),
  } } });
  const decay = 2 ** (-1 / 7);
  expect(prior).toMatchObject({ kind: 'ok', outcome: { kind: 'value', value: {
    method_version: 'dimensioned-retention@1', r_now: expect.closeTo((1 + decay) / (2 + decay), 14),
  } } });
  expect(await host.derive(cognition, sample)).toEqual(initial);

  const planning = { ...sample, events: [{ ...sample.events[0], confidence: 0.3 }],
    candidate_pool: [{ ref: 'variant', concept_ids: ['K'], item_novelty: 'transfer', est_min: 3 }] };
  expect(await host.derive('plan/information-gain@1', planning)).toMatchObject({ kind: 'ok', outcome: { value: {
    ranked_candidates: [{ ref: 'variant', info_gain: expect.closeTo(0.044110417748400965, 14) }],
  } } });

  const invalid = { ...sample, as_of_at: '2026-02-29T00:00:00Z' };
  expect(await host.derive(cognition, invalid)).toEqual({ kind: 'failed', reason: 'invalid CanonicalEvidenceSlice@v1' });
  const processResult = spawnSync(process.env.MANGEKYO_PYTHON ?? 'python3',
    ['-I', '-B', '-S', '-X', 'utf8', workerPath], {
      input: [sample, invalid].map((input, index) => JSON.stringify({ id: String(index), deriver: cognition, input })).join('\n') + '\n',
      encoding: 'utf8', env: {},
    });
  expect(processResult.status).toBe(0);
  const [validLine, invalidLine] = processResult.stdout.trim().split('\n');
  const {id, value: outcome} = JSON.parse(validLine!);
  expect(id).toBe('0');
  expect({kind: 'ok', outcome}).toEqual(initial);
  expect(JSON.parse(invalidLine!)).toEqual({ id: '1', error: 'invalid CanonicalEvidenceSlice@v1' });

  const noIndependent = { ...sample, events: sample.events.map(event => ({ ...event, help_level: 'hinted' })) };
  expect(await host.derive(cognition, noIndependent)).toMatchObject({ kind: 'ok', outcome: { kind: 'value', value: {
    state: 'unknown', uncertainty: { kind: 'unknown', reason: 'missing-independent-scored-evidence' },
  } } });
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
  expect(await host.derive('plan/exam-pacing@1', sample)).toMatchObject({kind: 'ok', outcome: {kind: 'value',
    value: {attempts: [], strategy: {kind: 'unknown'}}}});
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
  expect(await host.derive('learner/cognition@3', input)).toEqual({kind: 'ok', outcome: {kind: 'value',
    value: {...graded.outcome.value, method_version: 'cognition@3'}}});
  const helped = { ...input, events: [{ ...event, help_level: 'hint_l1' }, { ...error, help_level: 'hint_l2' }] };
  expect(await host.derive('learner/cognition@2', helped)).toMatchObject({ kind: 'ok', outcome: { value: { state: 'unknown' } } });
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
