import type { FactSnapshot, Outcome, Tick } from '@mangekyo/kernel';
import { reconcileRetention, type RetentionForecast, type RetentionObservation, type RetentionTarget } from './retention.ts';

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
    if (estimate.kind === 'probabilistic') {
      return { ...common, kind: 'forecast' as const,
        estimate: { kind: 'probabilistic' as const, probability: estimate.probability,
          interval: estimate.interval, uncertainty: estimate.uncertainty } };
    }
    return { ...common, kind: 'forecast' as const,
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

function metrics(statuses: readonly RetentionReconciliation['status'][]) {
  const matched = statuses.filter(status => status === 'matched').length;
  const missed = statuses.filter(status => status === 'missed').length;
  const eligible = matched + missed + statuses.filter(status => status === 'observed').length;
  return {
    eligible, matched, missed,
    contaminated: statuses.filter(status => status === 'contaminated').length,
    missingIndependent: statuses.filter(status => status === 'awaiting-independent').length,
    coverage: eligible ? (matched + missed) / eligible : null,
    classificationError: matched + missed ? missed / (matched + missed) : null,
  };
}

export function retentionComparisonCase<Pair>(pair: Pair, recorded: RetentionForecast, alternate: RetentionForecast,
  outcome: RetentionReconciliation) {
  return {
    ...pair, forecastWatermark: recorded.input.observedThrough, observationWatermark: outcome.observedThrough,
    exposure: outcome.observation.exposure.kind, observed: outcome.observation.result,
    recorded: { method: recorded.method, estimate: recorded.estimate, status: outcome.status },
    shadow: { estimate: alternate.estimate, status: reconcileRetention(alternate, outcome.observation).status },
  };
}

export function retentionComparisonReport<T extends ReturnType<typeof retentionComparisonCase>>(
  method: RetentionForecast['method'], cases: readonly T[],
) {
  return {
    kind: 'prospective-replay', method: { id: method.id, version: method.version }, cases,
    recorded: metrics(cases.map(row => row.recorded.status)), shadow: metrics(cases.map(row => row.shadow.status)),
  };
}
