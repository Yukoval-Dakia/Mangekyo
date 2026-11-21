import { expect, test } from 'vitest';
import { factId, type Revision, type Tick } from '@mangekyo/kernel';
import {
  projectBatchConceptMastery, projectCalibrationSummary, type CalibrationInputRecord, type ConceptAttemptEvidence,
} from './knowledge-mastery.ts';

const id = (n: number) => factId(String(n).padStart(26, '0'));
const rev = 1 as Revision;
const tick = (n: number) => String(n) as Tick;
const asOf = '2026-11-21T12:00:00.000Z';

function attempt(conceptId: ReturnType<typeof id>, overrides: Partial<ConceptAttemptEvidence> = {}): ConceptAttemptEvidence {
  return {
    conceptId, submission: { id: id(10), rev, type: 'activity.retentionPosttestSubmission' },
    questionId: id(20), occurredAt: '2026-11-21T10:00:00.000Z', recordedTick: tick(10),
    outcome: 'correct', exposure: 'independent', basisRefs: [{ id: id(30), rev, type: 'content.knowledgeEdge' }],
    ...overrides,
  };
}

test('projectBatchConceptMastery enforces honest unknown and classifies steady/fading/fragile', () => {
  const [cEmpty, cExposed, cIncomplete, cSteady, cFading, cFragile, cMisconception, cForecast] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
  const result = projectBatchConceptMastery({
    asOf,
    conceptIds: [cEmpty!, cExposed!, cIncomplete!, cSteady!, cFading!, cFragile!, cMisconception!, cForecast!],
    attempts: [
      attempt(cExposed!, { exposure: 'exposed' }),
      attempt(cIncomplete!, { exposure: 'unknown' }),
      attempt(cSteady!, { submission: { id: id(11), rev, type: 'activity.retentionPosttestSubmission' } }),
      attempt(cFading!, { submission: { id: id(12), rev, type: 'activity.retentionPosttestSubmission' }, occurredAt: '2026-11-10T10:00:00.000Z' }),
      attempt(cFragile!, { submission: { id: id(13), rev, type: 'activity.retentionPosttestSubmission' }, outcome: 'incorrect' }),
      attempt(cMisconception!, { submission: { id: id(14), rev, type: 'activity.retentionPosttestSubmission' } }),
      attempt(cForecast!, { submission: { id: id(15), rev, type: 'activity.retentionPosttestSubmission' }, recordedTick: tick(15) }),
    ],
    forecasts: [{
      conceptId: cForecast!, effectiveTick: tick(18), observedThrough: tick(16), probability: 0.52,
      basisRefs: [{ id: id(40), rev, type: 'activity.workbookPaper' }],
    }],
    activeMisconceptionConceptIds: new Set([cEmpty!, cMisconception!]),
  });
  expect(result.get(cEmpty!)).toMatchObject({ status: 'unknown', retrievability: null, independentCount: 0, basisRefs: [] });
  expect(result.get(cExposed!)).toMatchObject({ status: 'unknown', retrievability: null, independentCount: 0 });
  expect(result.get(cIncomplete!)).toMatchObject({ status: 'unknown', retrievability: null, reason: 'incomplete-coverage' });
  expect(result.get(cSteady!)).toMatchObject({ status: 'steady', retrievability: null, independentCount: 1 });
  expect(result.get(cFading!)).toMatchObject({ status: 'fading', retrievability: null, independentCount: 1 });
  expect(result.get(cFragile!)).toMatchObject({ status: 'fragile', retrievability: null, independentCount: 1 });
  expect(result.get(cMisconception!)).toMatchObject({ status: 'fragile', retrievability: null, independentCount: 1 });
  expect(result.get(cForecast!)).toMatchObject({ status: 'fading', retrievability: 0.52, independentCount: 1 });
});

test('projectCalibrationSummary stays unknown without independent matched/missed reconciliations', () => {
  const base: CalibrationInputRecord = {
    id: id(50), key: 'k1', forecastId: id(51), itemId: 'q1', status: 'contaminated', effectiveTick: tick(20),
    method: { id: 'cognition', version: '3' }, window: { requestedAt: asOf, through: asOf },
    observation: { result: 'correct', exposure: 'exposed' }, href: '/api/retention/k1',
  };
  expect(projectCalibrationSummary([])).toEqual({ status: 'unknown', totalReconciliations: 0, confirmed: 0, missed: 0, recent: [] });
  expect(projectCalibrationSummary([base])).toMatchObject({ status: 'unknown', totalReconciliations: 1, confirmed: 0, missed: 0 });
  expect(projectCalibrationSummary([base, { ...base, id: id(52), status: 'matched', effectiveTick: tick(21), observation: { result: 'correct', exposure: 'independent' } },
    { ...base, id: id(53), status: 'missed', effectiveTick: tick(22), observation: { result: 'incorrect', exposure: 'independent' } }]))
    .toMatchObject({ status: 'available', totalReconciliations: 3, confirmed: 1, missed: 1 });
});
