import { describe, expect, it } from 'vitest';
import { projectWeaknessAndErrorSummary, type WeaknessErrorSample } from './weakness-error-summary.ts';

const asOf = '2026-11-22T06:00:00.000Z';
const sample = (id: string, errorStage: WeaknessErrorSample['errorStage'], overrides: Partial<WeaknessErrorSample> = {}): WeaknessErrorSample => ({
  evidenceRef: { id, rev: 1, itemId: 'q1', href: `/papers/${id}` },
  occurredAt: '2026-11-21T06:00:00.000Z',
  outcome: 'incorrect',
  helpLevel: 'independent',
  errorStage,
  ...overrides,
});

describe('projectWeaknessAndErrorSummary (Wave Next-D)', () => {
  it('stays honest when samples < 2, rejects S11 helped samples, and never double-counts 1 attempt', () => {
    const one = projectWeaknessAndErrorSummary({
      asOf,
      errorSamples: [
        sample('s1', 'reading', { conceptId: 'c1' }),
        sample('s-hinted', 'execution', { helpLevel: 'hinted', conceptId: 'c2' }),
        sample('s-sol', 'strategy', { helpLevel: 'solution_seen', conceptId: 'c3' }),
        sample('s-future', 'modeling', { occurredAt: '2026-11-23T00:00:00.000Z' }),
      ],
      concepts: [{ conceptId: 'c1', title: '交变电流', status: 'fragile', retrievability: 0.41, independentAttempts: 1 }],
    });
    expect(one).toEqual({
      asOf, status: 'insufficient_evidence', sampleCount: 1, neededCount: 2,
      topErrorStages: [], priorityConcepts: [],
      summary: '还差 1 条独立错题或复盘记录，积累后这里会总结你最常卡住的环节。',
    });
  });

  it('ranks stages by count then recency and prioritizes weak/uncorrected concepts with nextAction', () => {
    const view = projectWeaknessAndErrorSummary({
      asOf,
      errorSamples: [
        sample('e1', 'reading', { occurredAt: '2026-11-21T00:00:00.000Z' }),
        sample('e2', 'reading', { occurredAt: '2026-11-20T00:00:00.000Z' }),
        sample('e2', 'reading', { occurredAt: '2026-11-20T00:00:00.000Z' }), // duplicate deduped
        sample('e3', 'execution', { occurredAt: '2026-11-22T00:00:00.000Z', outcome: 'partial' }),
        sample('e4', 'execution', { occurredAt: '2026-11-21T12:00:00.000Z' }),
        sample('e5', 'modeling', { occurredAt: '2026-11-01T00:00:00.000Z' }),
      ],
      concepts: [
        { conceptId: 'c-fading', title: '电磁感应', status: 'fading', retrievability: 0.55, independentAttempts: 2 },
        { conceptId: 'c-weak-uncorr', title: '交变电流', status: 'fragile', retrievability: 0.42, independentAttempts: 1, uncorrectedErrorCount: 2 },
        { conceptId: 'c-weak-empty', title: '楞次定律', status: 'weak', retrievability: 0.35, independentAttempts: 1, hasPracticeQuestions: false },
        { conceptId: 'c-solid', title: '欧姆定律', status: 'solid', retrievability: 0.9, independentAttempts: 4 },
      ],
    });
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(view.topErrorStages.map(s => [s.stage, s.count])).toEqual([['execution', 2], ['reading', 2], ['modeling', 1]]);
    expect(view.topErrorStages[0]!.recentWeight).toBeGreaterThan(view.topErrorStages[1]!.recentWeight);
    expect(view.topErrorStages[0]!.evidenceRefs.map(r => r.id)).toEqual(['e3', 'e4']);
    expect(view.priorityConcepts.map(c => [c.conceptId, c.nextAction])).toEqual([
      ['c-weak-uncorr', 'review_mistake'],
      ['c-weak-empty', 'start_classroom'],
      ['c-fading', 'quick_paper'],
    ]);
  });

  it('deduplicates sampleCount and topErrorStages when one wrong item spans multiple concepts', () => {
    const mkConcept = (id: string, refId: string) => ({
      conceptId: id, title: id, status: 'fragile' as const, retrievability: 0.4, independentAttempts: 1, evidenceRefs: [{ id: refId, rev: 1 }],
    });
    const oneItem = projectWeaknessAndErrorSummary({
      asOf, errorSamples: ['c1', 'c2', 'c3'].map(conceptId => sample('sub1', 'modeling', { conceptId })),
      concepts: ['c1', 'c2', 'c3'].map(id => mkConcept(id, 'sub1')),
    });
    expect(oneItem).toMatchObject({ status: 'insufficient_evidence', sampleCount: 1, neededCount: 2 });
    const twoItems = projectWeaknessAndErrorSummary({
      asOf,
      errorSamples: [...['c1', 'c2', 'c3'].map(c => sample('sub1', 'modeling', { conceptId: c })),
        ...['c4', 'c5', 'c6'].map(c => sample('sub2', 'modeling', { conceptId: c }))],
      concepts: [...['c1', 'c2', 'c3'].map(id => mkConcept(id, 'sub1')), ...['c4', 'c5', 'c6'].map(id => mkConcept(id, 'sub2'))],
    });
    expect(twoItems).toMatchObject({ status: 'ready', sampleCount: 2 });
    if (twoItems.status === 'ready') {
      expect(twoItems.topErrorStages).toMatchObject([{ stage: 'modeling', count: 2 }]);
      expect(twoItems.topErrorStages[0]!.evidenceRefs.map(r => r.id)).toEqual(['sub1', 'sub2']);
    }
  });
});
