import type { DerivationId, FactRef, Tick } from '@mangekyo/kernel';

type Window = { observedThrough: Tick; asOfAt: string; through: string };
type Evidence = { ref: FactRef; recordedAt: Tick; occurredAt: string };
type Blueprint = { ref: FactRef; sections: readonly { id: string; points: number }[] };
type Assessment = Evidence & { section: string; independent: boolean; scoreNorm: number };
type Calibration = Evidence & {
  forecastId: DerivationId; frozenAt: Tick; forecastAt: string; method: string;
  blueprint: FactRef; predicted: number; actual: number; independent: boolean;
};

const examMethod = 'weighted-assessment-residuals@1';
const durationMethod = 'comparable-active-duration@1';

function sameRef(a: FactRef, b: FactRef) {
  return a.learner === b.learner && a.id === b.id && a.rev === b.rev;
}
function visible(window: Window, evidence: Evidence, learner: FactRef['learner']) {
  return evidence.ref.learner === learner && BigInt(evidence.recordedAt) <= BigInt(window.observedThrough) &&
    Date.parse(evidence.occurredAt) <= Date.parse(window.asOfAt);
}
function countOnce<T extends Evidence>(evidence: readonly T[], key: (e: T) => string) {
  const ids = new Set<string>();
  for (const row of evidence) {
    const id = key(row);
    if (ids.has(id)) throw new Error('Duplicate observation in assessment input');
    ids.add(id);
  }
}

export type ExamInput = Window & {
  examId: string; blueprint: Blueprint; assessments: readonly Assessment[]; calibration: readonly Calibration[];
};

// Calibration residuals must come from earlier frozen point estimates evaluated
// on independent exams using the same version and unchanged blueprint.
export function freezeExam(input: ExamInput) {
  const { blueprint } = input;
  const unknown = (reason: string) => ({ kind: 'unknown' as const, reason });
  const predict = () => {
    const ids = new Set(blueprint.sections.map(s => s.id));
    if (!ids.size || ids.size !== blueprint.sections.length ||
        blueprint.sections.some(s => !s.id || !Number.isFinite(s.points) || s.points <= 0))
      return unknown('missing-exam-scope-or-weights');
    const evidence = input.assessments.filter(a => ids.has(a.section) && a.independent &&
      visible(input, a, blueprint.ref.learner) && Number.isFinite(a.scoreNorm) && a.scoreNorm >= 0 && a.scoreNorm <= 1);
    countOnce(evidence, a => a.ref.id + '/' + a.section);
    const basis = evidence.map(a => a.ref);
    let center = 0, maxScore = 0;
    for (const { id, points } of blueprint.sections) {
      const applicable = evidence.filter(a => a.section === id);
      if (!applicable.length) return unknown('missing-applicable-assessment');
      center += points * applicable.reduce((s, a) => s + a.scoreNorm, 0) / applicable.length;
      maxScore += points;
    }
    const calibration = input.calibration.filter(c => sameRef(c.blueprint, blueprint.ref) && c.method === examMethod &&
      c.independent && visible(input, c, blueprint.ref.learner) && BigInt(c.frozenAt) < BigInt(c.recordedAt) &&
      Date.parse(c.forecastAt) < Date.parse(c.occurredAt) &&
      [c.actual, c.predicted].every(x => Number.isFinite(x) && x >= 0 && x <= maxScore));
    countOnce(calibration, c => c.ref.id);
    countOnce(calibration, c => c.forecastId);
    const errors = calibration.map(c => Math.abs(c.predicted - c.actual)).sort((a, b) => a - b);
    // Finite sample rank for a 90% residual interval. When the sample is too
    // small the rank falls outside the observed residuals, so abstain.
    const error = errors[Math.ceil((errors.length + 1) * 0.9) - 1];
    if (error === undefined) return unknown('missing-prospective-method-calibration');
    return { kind: 'score-range' as const, low: Math.max(0, center - error), high: Math.min(maxScore, center + error),
      center, maxScore, basis, calibrationError: error, calibrationCount: errors.length,
      calibrationForecasts: calibration.map(c => c.forecastId) };
  };
  return { kind: 'exam' as const, method: examMethod, input, estimate: predict() };
}

export type DurationInput = Window & {
  activityId: string; condition: FactRef;
  attempts: readonly (Evidence & { condition: FactRef; effectiveDurationMs: number })[];
};

export function freezeDuration(input: DurationInput) {
  const attempts = input.attempts.filter(a => sameRef(input.condition, a.condition) && visible(input, a, input.condition.learner)
    && Number.isSafeInteger(a.effectiveDurationMs) && a.effectiveDurationMs > 0)
    .sort((a, b) => a.effectiveDurationMs - b.effectiveDurationMs);
  countOnce(attempts, a => a.ref.id);
  const at = (p: number) => attempts[Math.floor((attempts.length - 1) * p)]!.effectiveDurationMs;
  const estimate = attempts.length < 3 ? { kind: 'unknown' as const, reason: 'insufficient-comparable-effective-durations' }
    : { kind: 'duration-range' as const, lowMs: at(0.1), highMs: attempts[Math.ceil((attempts.length - 1) * 0.9)]!.effectiveDurationMs,
      medianMs: (at(0.5) + attempts[Math.ceil((attempts.length - 1) * 0.5)]!.effectiveDurationMs) / 2,
      basis: attempts.map(a => a.ref) };
  return { kind: 'duration' as const, method: durationMethod, input, estimate };
}

export function reconcileAssessment(forecast: ReturnType<typeof freezeExam> | ReturnType<typeof freezeDuration>,
  effectiveTick: Tick, actual: Evidence & { condition: FactRef; activityId: string; value: number;
    help: 'independent' | 'exposed' | 'unknown' }) {
  const { input, estimate } = forecast;
  const exam = forecast.kind === 'exam';
  const target = exam ? forecast.input.blueprint.ref : forecast.input.condition;
  const same = sameRef(target, actual.condition) && actual.ref.learner === target.learner &&
    actual.activityId === (exam ? forecast.input.examId : forecast.input.activityId);
  const inWindow = BigInt(actual.recordedAt) > BigInt(effectiveTick) &&
    Date.parse(actual.occurredAt) >= Date.parse(input.asOfAt) && Date.parse(actual.occurredAt) <= Date.parse(input.through);
  const validValue = exam ? actual.value >= 0 && actual.value <= forecast.input.blueprint.sections.reduce((s, x) => s + x.points, 0)
    : Number.isSafeInteger(actual.value) && actual.value > 0;
  if (!same || !inWindow || !Number.isFinite(actual.value) || !validValue) return 'awaiting-independent';
  if (actual.help === 'exposed') return 'contaminated';
  if (actual.help === 'unknown') return 'awaiting-independent';
  if (estimate.kind === 'unknown') return 'observed';
  const [low, high] = estimate.kind === 'score-range' ? [estimate.low, estimate.high] : [estimate.lowMs, estimate.highMs];
  return actual.value >= low && actual.value <= high ? 'matched' : 'missed';
}
