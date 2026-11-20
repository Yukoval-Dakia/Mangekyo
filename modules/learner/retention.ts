import type { FactId, Revision, Tick } from '@mangekyo/kernel';

export const forecastType = 'predict.forecast';
export const reconciliationType = 'predict.reconciliation';

export type RetentionTarget = {
  activity: 'frozen-workbook-item';
  paper: { id: FactId; rev: Revision };
  itemId: string;
  condition: 'same-item';
  gradingVersion: string;
};

export type RetentionObservation = {
  submission: { id: FactId; rev: Revision };
  submittedAt: string;
  admittedAt: Tick;
  result: 'correct' | 'incorrect' | 'unknown';
  exposure:
    | { kind: 'independent' }
    | { kind: 'exposed'; refs: readonly { id: FactId; rev: Revision }[] }
    | { kind: 'unknown'; reason: string };
};

export type RetentionInput = {
  target: RetentionTarget;
  window: { requestedAt: string; scheduledAt?: string; through: string };
  observedThrough: Tick;
  observations: readonly RetentionObservation[];
};

export type RetentionEstimate =
  | { kind: 'unknown'; reason: 'missing-independent-scored-evidence' | 'insufficient-retained-evidence' }
  | { kind: 'categorical'; expected: 'correct' | 'incorrect'; basis: RetentionObservation['submission'] };

export type RetentionMethod = {
  id: string;
  version: string;
  predict(input: RetentionInput): RetentionEstimate;
};

export const lastIndependentResult: RetentionMethod = {
  id: 'last-independent-result',
  version: '1',
  predict(input) {
    const latest = input.observations.findLast(observation =>
      observation.exposure.kind === 'independent' && observation.result !== 'unknown',
    );
    if (latest?.result === 'correct' || latest?.result === 'incorrect') {
      return { kind: 'categorical', expected: latest.result, basis: latest.submission };
    }
    return { kind: 'unknown', reason: 'missing-independent-scored-evidence' };
  },
};

const elapsedIndependentEvidence: RetentionMethod = {
  id: 'elapsed-independent-evidence',
  version: '1',
  predict(input) {
    const evidence = input.observations.filter(item => item.exposure.kind === 'independent' && item.result !== 'unknown');
    if (!evidence.length) return { kind: 'unknown', reason: 'missing-independent-scored-evidence' };
    const target = Date.parse(input.window.scheduledAt ?? input.window.through);
    // Compare a fixed prototype with the baseline before fitting any parameters.
    // A seven-day half-life shrinks the signed evidence as the target time moves away.
    const balance = evidence.reduce((total, item) => {
      const elapsedDays = Math.max(0, (target - Date.parse(item.submittedAt)) / 86_400_000);
      const weight = 2 ** (-elapsedDays / 7);
      return total + (item.result === 'correct' ? weight : -weight);
    }, 0);
    if (Math.abs(balance) < 0.25) return { kind: 'unknown', reason: 'insufficient-retained-evidence' };
    const expected = balance > 0 ? 'correct' : 'incorrect';
    return { kind: 'categorical', expected, basis: evidence.findLast(item => item.result === expected)!.submission };
  },
};

const retentionMethods = [lastIndependentResult, elapsedIndependentEvidence];
export const defaultRetentionMethod = 'last-independent-result@1';

export function readRetentionMethod(ref: string) {
  return retentionMethods.find(method => method.id + '@' + method.version === ref);
}

export function evaluateRetention(method: RetentionMethod, input: RetentionInput) {
  return { method: { id: method.id, version: method.version }, estimate: method.predict(input), input };
}

/** A shadow caller can run evaluateRetention on this same frozen input. It has no write capability. */
export type RetentionForecast = ReturnType<typeof evaluateRetention>;

export function reconcileRetention(forecast: RetentionForecast, observation: RetentionObservation) {
  let status: 'contaminated' | 'awaiting-independent' | 'observed' | 'matched' | 'missed';
  if (observation.exposure.kind === 'exposed') status = 'contaminated';
  else if (observation.exposure.kind === 'unknown' || observation.result === 'unknown') status = 'awaiting-independent';
  else if (forecast.estimate.kind === 'unknown') status = 'observed';
  else status = forecast.estimate.expected === observation.result ? 'matched' : 'missed';
  return { status, observation };
}
