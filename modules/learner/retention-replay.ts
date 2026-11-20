import type { DerivationId, Tick } from '@mangekyo/kernel';
import {
  evaluateFrozenRetention, reconcileRetention, retentionSlice, retentionBucketId,
  type RetentionForecast, type RetentionObservation,
} from './retention.ts';

type HistoryEntry = {
  forecastId: DerivationId;
  effectiveTick: Tick;
  forecast: RetentionForecast;
  // Gather supplies the earliest eligible later independent attempt, or the
  // observed contaminated/unknown attempt if none is eligible.
  observation?: RetentionObservation;
};
type Score = { probability: number | null; expected?: 'correct' | 'incorrect' };
type CalibrationCase = { actual: 0 | 1; score: Score };

function summarize(cases: readonly CalibrationCase[]) {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    from: i / 10, through: (i + 1) / 10, count: 0, positives: 0, sum: 0,
  }));
  let scored = 0, classified = 0, matched = 0, squaredError = 0;
  for (const { actual, score } of cases) {
    if (score.expected) {
      classified++;
      if ((score.expected === 'correct') === Boolean(actual)) matched++;
    }
    const p = score.probability;
    if (p === null) continue;
    const bin = bins[Math.min(9, Math.floor(p * 10))]!;
    bin.count++;
    bin.positives += actual;
    bin.sum += p;
    scored++;
    squaredError += (p - actual) ** 2;
  }
  return {
    eligible: cases.length, classified, matched, scored,
    coverage: cases.length ? classified / cases.length : null,
    brier: scored ? squaredError / scored : null,
    calibrationError: scored ? bins.reduce((total, b) => total + Math.abs(b.positives - b.sum), 0) / scored : null,
    bins: bins.map(b => ({ from: b.from, through: b.through, count: b.count,
      meanPredicted: b.count ? b.sum / b.count : null, observedRate: b.count ? b.positives / b.count : null })),
  };
}

function forecastScore({ estimate }: RetentionForecast): Score {
  if (estimate.kind === 'unknown') return { probability: null };
  if (estimate.kind === 'categorical') return { probability: null, expected: estimate.expected };
  return { probability: estimate.probability, expected: estimate.probability >= 0.5 ? 'correct' : 'incorrect' };
}

function recentRate({ input }: RetentionForecast): Score {
  const dims = input.target.dimensions ?? {};
  const novelty = { 'same-item': 'same', variant: 'isomorphic', 'fresh-context': 'transfer' } as const;
  const recent = retentionSlice(input).events.filter(e => e.help_level === 'independent' && e.outcome !== 'unknown' &&
    e.item_novelty === novelty[input.target.condition] && e.concept_ids.includes(dims.kcId ?? retentionBucketId(input)) &&
    e.representation === dims.representation && e.context === dims.context && e.method === dims.method)
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || a.ref.localeCompare(b.ref)).slice(0, 10);
  if (!recent.length) return { probability: null };
  const probability = recent.filter(o => o.outcome === 'correct').length / recent.length;
  return { probability, expected: probability >= 0.5 ? 'correct' : 'incorrect' };
}

// Read-only fold over the authorized frozen history, including unmatched forecasts.
// The caller seals the exact selected versions, then persists the report as a shadow.
export async function replayRetentionHistory(history: Iterable<HistoryEntry> | AsyncIterable<HistoryEntry>,
  method: Parameters<typeof evaluateFrozenRetention>[0], derive: Parameters<typeof evaluateFrozenRetention>[2]) {
  const cases = [];
  const recorded: CalibrationCase[] = [], shadow: CalibrationCase[] = [], baseline: CalibrationCase[] = [];
  const visited = new Set<DerivationId>();
  for await (const { forecastId, forecast, observation, effectiveTick } of history) {
    if (visited.has(forecastId)) throw new Error('Duplicate forecast in replay inventory');
    visited.add(forecastId);
    const alternate = await evaluateFrozenRetention(method, forecast.input, derive);
    if (observation && BigInt(observation.admittedAt) <= BigInt(effectiveTick))
      throw new Error('Observation predates the frozen forecast');
    const status = observation ? reconcileRetention(forecast, observation).status : 'awaiting-independent';
    const shadowStatus = observation ? reconcileRetention(alternate, observation).status : 'awaiting-independent';
    const baselineScore = recentRate(forecast);
    if (observation && ['matched', 'missed', 'observed'].includes(status)) {
      const actual = observation.result === 'correct' ? 1 : 0;
      recorded.push({ actual, score: forecastScore(forecast) });
      shadow.push({ actual, score: forecastScore(alternate) });
      baseline.push({ actual, score: baselineScore });
    }
    cases.push({ forecastId, effectiveTick, observedThrough: forecast.input.observedThrough,
      observation: observation?.submission ?? null,
      recorded: { method: forecast.method, estimate: forecast.estimate, status },
      shadow: { method: alternate.method, estimate: alternate.estimate, status: shadowStatus }, baseline: baselineScore });
  }
  return { kind: 'frozen-input-replay' as const, cases, recorded: summarize(recorded),
    shadow: summarize(shadow), baseline: summarize(baseline) };
}
