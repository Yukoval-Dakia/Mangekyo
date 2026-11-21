import type { DerivationId, Tick } from '@mangekyo/kernel';
import {
  evaluateFrozenRetention, reconcileRetention, independentRetentionEvidence,
  type RetentionEstimate, type RetentionForecast, type RetentionObservation,
} from './retention.ts';

type ReconciliationStatus = ReturnType<typeof reconcileRetention>['status'];
type Score = { probability: number | null; expected?: 'correct' | 'incorrect' };
type ReplayCase = {
  forecastId: string;
  exposure: RetentionObservation['exposure']['kind'] | null;
  observed: RetentionObservation['result'] | null;
  recorded: { method: RetentionForecast['method']; estimate: RetentionEstimate; status: ReconciliationStatus };
  shadow: { estimate: RetentionEstimate; status: ReconciliationStatus };
  baseline: Score;
};

function forecastScore(estimate: RetentionEstimate): Score {
  if (estimate.kind === 'unknown') return { probability: null };
  if (estimate.kind === 'categorical') return { probability: null, expected: estimate.expected };
  const { probability } = estimate;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new Error('Invalid frozen retention probability');
  return { probability, expected: probability >= 0.5 ? 'correct' : 'incorrect' };
}

export function retentionBaseline({ input }: RetentionForecast): Score {
  const evidence = new Map<string, ReturnType<typeof independentRetentionEvidence>[number]>();
  const ambiguous = new Set<string>();
  for (const event of independentRetentionEvidence(input)) {
    const prior = evidence.get(event.ref);
    if (!prior) evidence.set(event.ref, event);
    else if (prior.rev !== event.rev || prior.outcome !== event.outcome || prior.occurred_at !== event.occurred_at)
      ambiguous.add(event.ref);
  }
  const recent = [...evidence.values()].filter(event => !ambiguous.has(event.ref))
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || a.ref.localeCompare(b.ref)).slice(0, 10);
  if (!recent.length) return { probability: null };
  const probability = recent.filter(o => o.outcome === 'correct').length / recent.length;
  return { probability, expected: probability >= 0.5 ? 'correct' : 'incorrect' };
}

function independentOutcome(status: ReconciliationStatus) {
  return status === 'matched' || status === 'missed' || status === 'observed';
}

type OrderedOutcome = {
  observation: { submittedAt: string; admittedAt: Tick; submission: { id: string } };
  status: ReconciliationStatus;
};

export function compareRetentionObservations(a: OrderedOutcome, b: OrderedOutcome) {
  const tickA = BigInt(a.observation.admittedAt), tickB = BigInt(b.observation.admittedAt);
  return Number(independentOutcome(b.status)) - Number(independentOutcome(a.status)) ||
    Date.parse(a.observation.submittedAt) - Date.parse(b.observation.submittedAt) ||
    (tickA < tickB ? -1 : tickA > tickB ? 1 : 0) ||
    a.observation.submission.id.localeCompare(b.observation.submission.id);
}

function summarize(cases: readonly ReplayCase[], method: 'recorded' | 'shadow' | 'baseline') {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    from: i / 10, through: (i + 1) / 10, count: 0, positives: 0, sum: 0,
  }));
  let eligible = 0, classified = 0, matched = 0, scored = 0, squaredError = 0;
  let contaminated = 0, missingIndependent = 0;
  for (const row of cases) {
    const { exposure, observed, recorded } = row;
    if (!independentOutcome(recorded.status) || exposure !== 'independent' || observed === null || observed === 'unknown') {
      if (recorded.status === 'contaminated') contaminated++;
      else missingIndependent++;
      continue;
    }
    eligible++;
    const score = method === 'baseline' ? row.baseline : forecastScore(row[method].estimate);
    if (score.expected !== undefined) {
      classified++;
      if (score.expected === observed) matched++;
    }
    const p = score.probability;
    if (p === null) continue;
    const actual = observed === 'correct' ? 1 : 0;
    const bin = bins[Math.min(9, Math.floor(p * 10))]!;
    bin.count++;
    bin.positives += actual;
    bin.sum += p;
    scored++;
    squaredError += (p - actual) ** 2;
  }
  const missed = classified - matched;
  // Ten fixed bins, left-inclusive and right-exclusive except for p = 1.
  return {
    eligible, classified, matched, missed, scored, contaminated, missingIndependent,
    missingPrediction: eligible - classified,
    coverage: eligible ? classified / eligible : null,
    probabilityCoverage: eligible ? scored / eligible : null,
    classificationError: classified ? missed / classified : null,
    brier: scored ? squaredError / scored : null,
    calibrationError: scored ? bins.reduce((total, b) => total + Math.abs(b.positives - b.sum), 0) / scored : null,
    bins: bins.map(b => ({ from: b.from, through: b.through, count: b.count,
      meanPredicted: b.count ? b.sum / b.count : null, observedRate: b.count ? b.positives / b.count : null,
      absoluteError: b.count ? Math.abs(b.positives - b.sum) / b.count : null })),
  };
}

export function summarizeRetentionReplay(cases: readonly ReplayCase[]) {
  const byMethod = new Map<string, ReplayCase[]>();
  for (const row of cases) {
    const { id, version } = row.recorded.method;
    const key = id + '@' + version;
    const group = byMethod.get(key);
    if (group) group.push(row);
    else byMethod.set(key, [row]);
  }
  const recorded = summarize(cases, 'recorded');
  return {
    state: cases.length === 0 ? 'empty' as const : recorded.eligible === 0 ? 'awaiting-independent' as const : 'ready' as const,
    forecasts: cases.length,
    observations: {
      independent: cases.filter(row => row.exposure === 'independent').length,
      exposed: cases.filter(row => row.exposure === 'exposed').length,
      unknown: cases.filter(row => row.exposure === 'unknown').length,
      unobserved: cases.filter(row => row.exposure === null).length,
    },
    recorded, shadow: summarize(cases, 'shadow'), baseline: summarize(cases, 'baseline'),
    recordedByMethod: [...byMethod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => ({
      method: rows[0]!.recorded.method, ...summarize(rows, 'recorded'),
    })),
  };
}

export type RetentionHistoryEntry = {
  forecastId: DerivationId;
  effectiveTick: Tick;
  forecast: RetentionForecast;
  observation?: RetentionObservation;
  observations?: readonly RetentionObservation[];
};

function selectObservation(entry: RetentionHistoryEntry) {
  const { forecast, effectiveTick, observation } = entry;
  const candidates = entry.observations ?? (observation ? [observation] : []);
  const submissions = new Map<string, ReturnType<typeof reconcileRetention>>();
  for (const candidate of candidates) {
    if (BigInt(candidate.admittedAt) <= BigInt(effectiveTick))
      throw new Error('Observation predates the frozen forecast');
    const prior = submissions.get(candidate.submission.id);
    const outcome = reconcileRetention(forecast, candidate);
    if (prior && (prior.observation.submission.rev !== candidate.submission.rev || prior.status !== outcome.status ||
        prior.observation.result !== candidate.result || prior.observation.exposure.kind !== candidate.exposure.kind ||
        prior.observation.admittedAt !== candidate.admittedAt || prior.observation.submittedAt !== candidate.submittedAt))
      throw new Error('Conflicting revisions of a retention outcome');
    submissions.set(candidate.submission.id, outcome);
  }
  return [...submissions.values()].sort(compareRetentionObservations)[0];
}

// The host enumerates the complete authorized inventory of frozen forecasts and later reconciliations
// in one snapshot, pinning exact revisions. It owns revalidation and shadow candidate persistence.
export async function replayRetentionHistory(history: Iterable<RetentionHistoryEntry> | AsyncIterable<RetentionHistoryEntry>,
  method: Parameters<typeof evaluateFrozenRetention>[0], derive: Parameters<typeof evaluateFrozenRetention>[2]) {
  async function replay(entry: RetentionHistoryEntry) {
    const { forecastId, forecast, effectiveTick } = entry;
    if (BigInt(forecast.input.observedThrough) > BigInt(effectiveTick))
      throw new Error('Forecast evidence cutoff follows its effective tick');
    const outcome = selectObservation(entry);
    const alternate = await evaluateFrozenRetention(method, forecast.input, derive);
    const observation = outcome?.observation;
    return {
      forecastId, effectiveTick, observedThrough: forecast.input.observedThrough,
      observation: observation?.submission ?? null,
      exposure: observation?.exposure.kind ?? null,
      observed: observation?.result ?? null,
      recorded: { method: forecast.method, estimate: forecast.estimate, status: outcome?.status ?? 'awaiting-independent' as const },
      shadow: { method: alternate.method, estimate: alternate.estimate,
        status: observation ? reconcileRetention(alternate, observation).status : 'awaiting-independent' as const },
      baseline: retentionBaseline(forecast),
    };
  }
  const cases: Awaited<ReturnType<typeof replay>>[] = [];
  const visited = new Set<DerivationId>();
  let batch: RetentionHistoryEntry[] = [];
  async function flush() {
    const results = await Promise.allSettled(batch.map(replay));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      cases.push(result.value);
    }
    batch = [];
  }
  for await (const entry of history) {
    if (visited.has(entry.forecastId)) throw new Error('Duplicate forecast in replay inventory');
    visited.add(entry.forecastId);
    batch.push(entry);
    if (batch.length === 4) await flush();
  }
  await flush();
  return { kind: 'frozen-input-replay' as const, method: { id: method.id, version: method.version }, cases,
    ...summarizeRetentionReplay(cases) };
}
