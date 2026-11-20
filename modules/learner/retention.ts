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
  window: { requestedAt: string; through: string };
  observedThrough: Tick;
  observations: readonly RetentionObservation[];
};

export type RetentionEstimate =
  | { kind: 'unknown'; reason: 'missing-independent-scored-evidence' }
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
