import type { BusWitness, Revision, Tick } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { createAuthorizedFactReader } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../kernel/test/learner-database.ts';
import { projectMemoryOverview, readMemoryOverview, type MemoryRecentChangeKind } from './memory-overview.ts';
import { factWriter, learner, seed, snapshot, use as ref } from './test/facts.ts';

const scope = { learner, purpose: 'teaching', recipientId: 'learner',
  asOf: '2026-11-21T05:00:00.000Z', clockWatermark: '9' as Tick };
const change = (n: number, reasonKind: MemoryRecentChangeKind, at = scope.asOf) =>
  ({ occurredAt: at, reasonKind, witnesses: [ref(n, 'test.change')] });

it('projects learner-facing calibration, cognition, authorized changes, and outlook', async () => {
  const pass = change(2, 'correction'), revoked = change(3, 'revocation');
  const future = change(4, 'independent-evidence', '2026-11-21T06:00:00.000Z');
  const view = await readMemoryOverview({ ...scope,
    calibration: { recorded: { classified: 2, matched: 1, eligible: 2, contaminated: 1, missingIndependent: 1 } },
    cognition: ['solid', 'decaying', {status: 'fragile'}, 'unknown'],
    recentChanges: [pass, revoked, future, { ...change(5, 'plan-adjustment'), witnesses: [{...ref(5, 'test.change'), accessEpoch: '10' as Tick}] }],
    examOutlook: { kind: 'value', value: { low: 60, high: 75, maximum: 100 } },
  }, { reopen: async (_scope, witness) => witness.id === revoked.witnesses[0]!.id ? undefined : snapshot(witness) });
  expect(view.calibration).toMatchObject({ state: 'ready', hitRatePercent: 50, sampleCount: 2, awaitingIndependentCount: 2 });
  expect(view.cognition).toMatchObject({ totalCount: 4, solidCount: 1, fadingCount: 1, weakCount: 1, unknownCount: 1 });
  expect(view.recentChanges.map(row => row.kind)).toEqual(['correction']);
  expect(view.examOutlook?.headline).toContain('不是承诺');
});

it('reports missing independent evidence without inventing a score', () => {
  const view = projectMemoryOverview({ ...scope, calibration: { recorded: { classified: 0, eligible: 1 } } });
  expect(view.calibration).toMatchObject({ state: 'awaiting-evidence', hitRatePercent: null, sampleCount: 0 });
});

it('keeps engineering measurements out of the public JSON', () => {
  const view = projectMemoryOverview({ ...scope, calibration: { cases: [] }, recentChanges: [],
    examOutlook: { kind: 'unknown', reason: 'x' } });
  const leaks = new Set<string>(['methodVersion', 'absoluteError', 'brier', 'calibrationError', 'clockWatermark', 'accessEpoch']);
  const visit = (value: unknown): void => { if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (leaks.has(key)) throw new Error(key); visit(child); } };
  visit(view); expect(view.examOutlook?.state).toBe('unknown');
});

it('reopens authorized witnesses on Postgres and silently drops revoked ones', { timeout: 20_000 }, () =>
  withLearnerDatabase(learner, async db => {
    const apply = factWriter(db, { learner, purpose: 'teaching' });
    await apply([seed({ id: ref(6, 'test.change').id, type: 'test.change' }, ['teaching']),
      seed({ id: ref(7, 'test.change').id, type: 'test.change' }, ['teaching'])], 30);
    const epochs = new Map<string, string>(
      (await db.query<{ id: string; access_epoch: string }>(
        'SELECT id, access_epoch FROM facts WHERE learner_id=$1', [learner])).rows
        .map(row => [row.id, String(row.access_epoch)]));
    const w = (n: number) => ({ ...ref(n, 'test.change'), accessEpoch: epochs.get(ref(n, 'test.change').id) as Tick });
    const read = (tx: ReadTransaction) => ({
      reopen: (_scope: unknown, ref: BusWitness) => readable(() => createAuthorizedFactReader(tx, 'teaching', () => true).reopen(ref)),
    });
    const request = { ...scope, clockWatermark: '999999999' as Tick,
      recentChanges: [{ ...change(6, 'correction'), witnesses: [w(6)] }, { ...change(7, 'revocation'), witnesses: [w(7)] }] };
    const before = await db.snapshot({ learner }, tx => readMemoryOverview(request, read(tx)));
    expect(before.recentChanges).toHaveLength(2);
    await apply([{ kind: 'set_purpose', id: ref(7, 'test.change').id, expectedRev: 1 as Revision, purpose: ['storage'] }], 31);
    const after = await db.snapshot({ learner }, tx => readMemoryOverview(request, read(tx)));
    expect(after.recentChanges.map(row => row.kind)).toEqual(['correction']);
  }, { postgres: Boolean(testDatabaseUrl) }));
