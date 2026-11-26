import { expect, it } from 'vitest'; import type { PlanRule } from './rules.ts'; import { filterMicroActivities, resolveCampaignState } from './campaign-and-micro.ts';
const exam: PlanRule = { kind: 'exam', date: '2026-12-01', scope: ['物理'], weights: [{ topic: '物理', weight: 100 }] };
it('resolves campaign windows and precise one-hand micro filtering', () => {
  expect(resolveCampaignState({ now: '2026-11-24T00:00:00+08:00', rules: [exam] })).toMatchObject({ phase: 'sprint', source: 'deadline', daysToExam: 7 });
  expect(resolveCampaignState({ now: '2026-12-02T00:00:00+08:00', rules: [exam] }).phase).toBe('decompress');
  expect(resolveCampaignState({ now: '2026-11-24T00:00:00+08:00', rules: [exam], manualOverride: 'steady' }).source).toBe('manual');
  const filtered = filterMicroActivities([{ id: 'write', minutes: 2, input: 'write' }, { id: 'tap', minutes: 2, input: 'tap' }, { id: 'late', minutes: 6, input: 'tap' }], { bucket: '3min', inputMode: 'one_hand' });
  expect(filtered.admitted.map((item) => item.id)).toEqual(['tap']);
  expect(filtered.filteredOut.map((item) => item.reason)).toEqual(['requires_writing', 'over_duration']);
  expect(filterMicroActivities([{ id: 'exam', minutes: 1, input: 'tap', kind: 'exam' }], { bucket: '3min', inputMode: 'any', campaignPhase: 'decompress' }).filteredOut[0]?.reason).toBe('paused_by_decompress'); });
