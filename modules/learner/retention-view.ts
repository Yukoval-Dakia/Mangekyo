import { flashCheckPriority, nearFlashCrossing } from './flash-check.ts';
import type { FactSnapshot, Outcome, Tick } from '@mangekyo/kernel';
import { reconcileRetention, type RetentionForecast, type RetentionObservation, type RetentionTarget } from './retention.ts';
import { compareRetentionObservations, retentionBaseline, summarizeRetentionReplay } from './retention-replay.ts';

export type RetentionReconciliation = ReturnType<typeof reconcileRetention> & { forecastId: string; observedThrough: Tick };
type RetentionSelection = {
  id: string;
  key: string;
  effectiveTick: Tick;
  value: Outcome<RetentionForecast | RetentionReconciliation>;
};
type FrozenForecast = { id: string; value: RetentionForecast };
type RetentionFacts = { papers: readonly FactSnapshot[]; submissions: readonly FactSnapshot[] };

/** Project a teaching summary from source facts the caller has already opened. */
export function projectRetentionRead<Evidence>(row: RetentionSelection, forecast: FrozenForecast, facts: RetentionFacts,
  href: string, evidenceOf: (fact: FactSnapshot, itemId: string) => Evidence) {
  if (row.value.kind !== 'value') return;
  const { method, estimate, input } = forecast.value;
  const value = row.value.value;
  const { itemId, paper } = input.target;
  const matches = (ref: RetentionObservation['submission'], facts: readonly FactSnapshot[]) =>
    facts.find(fact => fact.ref.id === ref.id && fact.ref.rev === ref.rev);
  const source = matches(paper, facts.papers);
  if (!source) return;
  const observation = 'observation' in value ? value.observation : undefined;
  const refs = [...input.observations.map(item => item.submission), ...(observation ? [observation.submission] : [])];
  if (refs.some(ref => !matches(ref, facts.submissions))) return;
  // The frozen result and dispatch witness retain the full basis.
  const sources = new Set([source]);
  const forecastBasis = estimate.kind === 'categorical' ? estimate.basis : input.observations.at(-1)?.submission;
  for (const ref of [forecastBasis, observation?.submission]) {
    if (!ref) continue;
    const fact = matches(ref, facts.submissions);
    if (!fact) return;
    sources.add(fact);
  }
  const evidence = [...sources].map(fact => evidenceOf(fact, itemId));
  const common = { id: row.id, key: row.key, state: 'current' as const, effectiveTick: row.effectiveTick,
    method: { id: method.id, version: method.version }, itemId,
    window: { requestedAt: input.window.requestedAt, through: input.window.through }, evidence, href };
  if ('status' in value && observation) return { ...common, kind: 'reconciliation' as const,
    forecastId: forecast.id, status: value.status,
    observation: { result: observation.result, exposure: observation.exposure.kind } };
  if ('estimate' in value) {
    const priority = flashCheckPriority(forecast.value);
    const flag = priority ? { flash_check_priority: priority } : {};
    if (estimate.kind === 'probabilistic') {
      return { ...common, ...flag, kind: 'forecast' as const,
        estimate: { kind: 'probabilistic' as const, probability: estimate.probability,
          interval: estimate.interval, uncertainty: estimate.uncertainty } };
    }
    return { ...common, ...flag, kind: 'forecast' as const,
      estimate: estimate.kind === 'unknown' ? { kind: 'unknown' as const, reason: estimate.reason }
        : { kind: 'categorical' as const, expected: estimate.expected } };
  }
  return undefined;
}

export function againstFrozenTarget(observation: RetentionObservation, target: RetentionTarget): RetentionObservation {
  return {
    ...observation,
    ...(target.condition === 'same-item' ? {} : { novelty: target.condition }),
    ...(target.dimensions ? { dimensions: target.dimensions } : {}),
  };
}

export function retentionComparisonCase<Pair extends { forecastId: string }>(pair: Pair, recorded: RetentionForecast,
  alternate: RetentionForecast, outcome: RetentionReconciliation) {
  const { observation } = outcome;
  return {
    ...pair, forecastWatermark: recorded.input.observedThrough, observationWatermark: outcome.observedThrough,
    observation: { admittedAt: observation.admittedAt, submittedAt: observation.submittedAt, submission: { id: observation.submission.id } },
    exposure: observation.exposure.kind, observed: observation.result,
    recorded: { method: recorded.method, estimate: recorded.estimate, status: outcome.status },
    shadow: { estimate: alternate.estimate, status: reconcileRetention(alternate, outcome.observation).status },
    baseline: retentionBaseline(recorded),
  };
}

export function retentionComparisonReport<T extends ReturnType<typeof retentionComparisonCase>>(
  method: RetentionForecast['method'], cases: readonly T[],
) {
  const selected = new Map<string, T>();
  for (const row of cases) {
    const prior = selected.get(row.forecastId);
    if (!prior || compareRetentionObservations({ observation: row.observation, status: row.recorded.status },
      { observation: prior.observation, status: prior.recorded.status }) < 0) selected.set(row.forecastId, row);
  }
  return {
    kind: 'prospective-replay', method: { id: method.id, version: method.version },
    cases: cases.map(({ observation: _observation, ...row }) => row),
    ...summarizeRetentionReplay([...selected.values()]),
  };
}

/** Classify a frozen prediction only while its posttest observation window is open. */
export function classifyFrozenCrossing(forecast: RetentionForecast, opensAt: string, effectiveTick: Tick,
  now: number, horizonEnd: number) {
  const { input, estimate } = forecast;
  const start = Date.parse(opensAt);
  const end = Date.parse(input.window.through);
  if (!(start <= now && now < end) || BigInt(input.observedThrough) > BigInt(effectiveTick) ||
      estimate.kind !== 'probabilistic' || estimate.asOfAt !== opensAt || !estimate.crossingAt) return;
  const crossing = Date.parse(estimate.crossingAt);
  if (!(start <= crossing && crossing <= end)) return;
  return { at: new Date(crossing).toISOString(), asOf: opensAt, inHorizon: now < crossing && crossing <= horizonEnd };
}

export function projectForgettingRisks<Risk extends { crossing_at: string; forecast_id: string }>(
  risks: Risk[], classified: number, candidates: number, asOf: string, end: number, watermark: Tick,
) {
  return {
    scope: 'active_frozen_workbook_forecasts',
    state: !classified ? 'unknown' : classified === candidates ? 'complete' : 'partial',
    as_of_at: asOf, through: new Date(end).toISOString(), clock_watermark: watermark,
    risks: risks.map(risk => nearFlashCrossing(risk.crossing_at, Date.parse(asOf))
      ? { ...risk, flash_check_priority: 'threshold-crossing' as const } : risk)
      .sort((a, b) => a.crossing_at.localeCompare(b.crossing_at) || a.forecast_id.localeCompare(b.forecast_id)),
  };
}
