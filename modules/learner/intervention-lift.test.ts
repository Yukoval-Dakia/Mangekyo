import { expect, it } from 'vitest';
import { factId, type Revision, type Tick } from '@mangekyo/kernel';
import { measureInterventionLift, type InterventionPair } from './intervention-lift.ts';

it('只用成熟的独立配对结算，缺失后测保留在不确定区间中', () => {
  const ref = (n: number) => ({ id: factId(String(n).padStart(26, '0')), rev: 1 as Revision, accessEpoch: '0' as Tick });
  const identity = { playbookId: ref(0).id, strategyId: 'inspect-boundary', version: 1 };
  function pair(i: number): InterventionPair {
    const assessment = { comparisonKey: 'rubric-1:stratum-2', independence: 'independent', novelty: 'transfer' } as const;
    return { ...identity, intervention: ref(3*i+1), deliveredAt: '2026-01-02T00:00:00.000Z',
      plannedBaselineItem: 'pre', plannedPosttestItem: 'transfer', comparisonKey: assessment.comparisonKey,
      baseline: { ...assessment, submission: ref(3*i+2), item: 'pre', occurredAt: '2026-01-01T00:00:00.000Z', score: 0 },
      posttest: { ...assessment, submission: ref(3*i+3), item: 'transfer', occurredAt: '2026-01-05T00:00:00.000Z', score: 1 } };
  }
  const closed = Array.from({ length: 12 }, (_, i) => pair(i));
  const read = (interventions: InterventionPair[], asOf = '2026-01-16T00:00:00.000Z') =>
    measureInterventionLift({ ...identity, interventions, asOf });
  expect(read(closed)).toMatchObject({ value: { verdict: 'positive', pairedMean: 1, eligible: 12 } });
  expect(read(closed, '2026-01-15T23:59:59.999Z')).toMatchObject({ kind: 'unknown' });
  expect(read(closed.map(row => ({ ...row, posttest: { ...row.posttest!, novelty: 'same' } })))).toMatchObject({ kind: 'unknown' });
  expect(read(closed.map((row, i) => i < 6 ? { ...row, posttest: null } : row)))
    .toMatchObject({ value: { verdict: 'inconclusive', eligible: 6, unresolved: 6 } });
  expect(() => read([closed[0]!, closed[0]!])).toThrow('重复');
});
