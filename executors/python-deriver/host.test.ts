import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createPythonDeriverHost } from './host.ts';
import { isCanonicalEvidenceSlice, isCognitionResult } from './schema.ts';
import sample from './samples/fixed-clock.json' with { type: 'json' };

const workerPath = fileURLToPath(new URL('./worker.py', import.meta.url));
const cognition = 'learner/cognition@1';
const legacy = 'learner/retention-forecast@1';

it('replays one fixed-clock slice through the TS host and direct Python IPC', async () => {
  const host = createPythonDeriverHost();
  const nextDay = { ...sample, as_of_at: '2026-11-22T01:02:03.1Z' };
  try {
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

    const invalid = { ...sample, as_of_at: '2026-02-29T00:00:00Z' };
    expect(isCanonicalEvidenceSlice(invalid)).toBe(false);
    expect(await host.derive(cognition, invalid)).toEqual({ kind: 'failed', reason: 'invalid CanonicalEvidenceSlice@v1' });
    const processResult = spawnSync(process.env.MANGEKYO_PYTHON ?? 'python3',
      ['-I', '-B', '-S', '-X', 'utf8', workerPath], {
        input: [sample, invalid].map((input, index) => JSON.stringify({ id: String(index), deriver: cognition, input })).join('\n') + '\n',
        encoding: 'utf8', env: {},
      });
    expect(processResult.status).toBe(0);
    const [validLine, invalidLine] = processResult.stdout.trim().split('\n');
    const validReply = JSON.parse(validLine!);
    expect(isCognitionResult(validReply.value.value)).toBe(true);
    expect({ kind: 'ok', outcome: validReply.value }).toEqual(initial);
    expect(JSON.parse(invalidLine!)).toEqual({ id: '1', error: 'invalid CanonicalEvidenceSlice@v1' });

    const noIndependent = { ...sample, events: sample.events.map(event => ({ ...event, help_level: 'hinted' })) };
    expect(await host.derive(cognition, noIndependent)).toMatchObject({ kind: 'ok', outcome: { kind: 'value', value: {
      state: 'unknown', uncertainty: { kind: 'unknown', reason: 'missing-independent-scored-evidence' },
    } } });
  } finally {
    await host.close();
  }
});

it.each([
  { reason: 'timed out', script: 'import sys\nfor _ in sys.stdin: pass' },
  { reason: 'exited', script: 'import sys\nsys.stdin.readline()\nsys.exit(1)' },
])('returns failed when the worker $reason and starts a fresh process', async ({ script, reason }) => {
  let starts = 0;
  const host = createPythonDeriverHost({
    timeoutMs: 1000,
    restartDelayMs: 0,
    spawnProcess: (python, args) => spawn(python, ++starts === 1
      ? ['-c', script]
      : [...args], { stdio: ['pipe', 'pipe', 'ignore'], env: {} }),
  });
  try {
    expect(await host.derive(cognition, sample))
      .toEqual({ kind: 'failed', reason: expect.stringContaining(reason) });
    expect(await host.derive(cognition, sample)).toMatchObject({ kind: 'ok', outcome: { kind: 'value' } });
    expect(starts).toBe(2);
  } finally {
    await host.close();
  }
});
