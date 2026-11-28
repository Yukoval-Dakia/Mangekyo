import type { CriterionObservationV2, FactId, Revision, Tick } from '@mangekyo/kernel';
import { eventAttributedKcIds, eventKcOutcome } from './evidence-refs.ts';
import { nearFlashCrossing } from './flash-check.ts';

export type ConceptMasteryStatus = 'steady' | 'fading' | 'fragile' | 'unknown';

export type ConceptMasteryBasisRef = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly type: string;
};

export type ConceptMasteryView = {
  readonly status: ConceptMasteryStatus;
  readonly retrievability: number | null;
  readonly independentCount: number;
  readonly basisRefs: readonly ConceptMasteryBasisRef[];
  readonly reason?: 'no-independent-evidence' | 'incomplete-coverage' | 'unavailable';
};

export type ConceptAttemptEvidence = {
  readonly conceptId: FactId;
  readonly submission: ConceptMasteryBasisRef;
  readonly questionId: FactId;
  readonly itemId?: string;
  readonly occurredAt: string;
  readonly recordedTick: Tick;
  readonly outcome: 'correct' | 'incorrect' | 'partial' | 'unknown';
  readonly scoreNorm?: number;
  readonly exposure: 'independent' | 'exposed' | 'unknown';
  readonly basisRefs: readonly ConceptMasteryBasisRef[];
  readonly criteria?: readonly CriterionObservationV2[];
};

export type ConceptForecastSignal = {
  readonly conceptId: FactId;
  readonly effectiveTick: Tick;
  readonly observedThrough: Tick;
  readonly probability: number;
  readonly crossingAt?: string;
  readonly basisRefs: readonly ConceptMasteryBasisRef[];
};

export type BatchConceptMasteryInput = {
  readonly asOf: string;
  readonly conceptIds: readonly FactId[];
  readonly attempts: readonly ConceptAttemptEvidence[];
  readonly forecasts?: readonly ConceptForecastSignal[];
  readonly incompleteConceptIds?: ReadonlySet<string>;
  readonly activeMisconceptionConceptIds?: ReadonlySet<string>;
};

export type CalibrationInputRecord = {
  readonly id: string;
  readonly key: string;
  readonly forecastId: string;
  readonly itemId: string;
  readonly status: 'contaminated' | 'awaiting-independent' | 'observed' | 'matched' | 'missed';
  readonly effectiveTick: Tick;
  readonly method: { readonly id: string; readonly version: string };
  readonly window: { readonly requestedAt: string; readonly through: string };
  readonly observation: { readonly result: 'correct' | 'incorrect' | 'unknown'; readonly exposure: 'independent' | 'exposed' | 'unknown' };
  readonly href: string;
};

export type CalibrationRecord = {
  readonly id: string;
  readonly key: string;
  readonly forecastId: string;
  readonly itemId: string;
  readonly status: CalibrationInputRecord['status'];
  readonly outcome: 'confirmed' | 'missed' | 'contaminated' | 'awaiting-independent' | 'observed';
  readonly observedResult: 'correct' | 'incorrect' | 'unknown';
  readonly exposure: 'independent' | 'exposed' | 'unknown';
  readonly effectiveTick: Tick;
  readonly method: { readonly id: string; readonly version: string };
  readonly window: { readonly requestedAt: string; readonly through: string };
  readonly href: string;
};

export type CalibrationSummary = {
  readonly status: 'available' | 'unknown';
  readonly totalReconciliations: number;
  readonly confirmed: number;
  readonly missed: number;
  readonly recent: readonly CalibrationRecord[];
};

const crossingProbability = 0.60;
const halfLifeDays = 7;

function dedupeRefs(refs: readonly ConceptMasteryBasisRef[]): readonly ConceptMasteryBasisRef[] {
  const seen = new Map<string, ConceptMasteryBasisRef>();
  for (const ref of refs) seen.set(`${ref.id}:${ref.rev}:${ref.type}`, ref);
  return [...seen.values()].sort((left, right) => left.id.localeCompare(right.id) || left.rev - right.rev);
}

const outcomeSeverity: Readonly<Record<ConceptAttemptEvidence['outcome'], number>> = { unknown: 0, correct: 1, partial: 2, incorrect: 3 };

function partialScoreFor(attempt: ConceptAttemptEvidence, conceptId: string): number {
  let num = 0, den = 0;
  for (const c of attempt.criteria ?? []) {
    const w = c.kc_links.filter(l => l.kc_id === conceptId && l.weight > 0).reduce((s, l) => s + l.weight, 0);
    if (w <= 0) continue;
    const score = typeof c.score_norm === 'number' && Number.isFinite(c.score_norm) ? Math.max(0, Math.min(1, c.score_norm))
      : c.earned !== null && c.maximum !== null && c.maximum > 0 ? Math.max(0, Math.min(1, c.earned / c.maximum))
      : c.outcome === 'correct' ? 1 : c.outcome === 'incorrect' ? 0 : 0.5;
    num += score * w;
    den += w;
  }
  if (den > 0) return num / den;
  return typeof attempt.scoreNorm === 'number' && Number.isFinite(attempt.scoreNorm)
    ? Math.max(0, Math.min(1, attempt.scoreNorm)) : 0.5;
}

function compareAttempts(left: ConceptAttemptEvidence, right: ConceptAttemptEvidence) {
  const timeDiff = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (timeDiff !== 0) return timeDiff;
  const tickDiff = BigInt(left.recordedTick) - BigInt(right.recordedTick);
  if (tickDiff !== 0n) return tickDiff > 0n ? 1 : -1;
  const subDiff = left.submission.id.localeCompare(right.submission.id);
  if (subDiff !== 0) return subDiff;
  const sevDiff = outcomeSeverity[left.outcome] - outcomeSeverity[right.outcome];
  if (sevDiff !== 0) return sevDiff;
  return (left.itemId ?? left.questionId).localeCompare(right.itemId ?? right.questionId);
}

/** Batch read-time concept mastery projection.
 * Never fabricates mastery or retrievability: returns `unknown` whenever
 * independent scored evidence is missing or coverage is incomplete, and only
 * populates numeric `retrievability` from a current probabilistic forecast.
 */
export function projectBatchConceptMastery(input: BatchConceptMasteryInput): ReadonlyMap<FactId, ConceptMasteryView> {
  const now = Date.parse(input.asOf);
  const result = new Map<FactId, ConceptMasteryView>();
  const attemptsByConcept = new Map<FactId, ConceptAttemptEvidence[]>();
  const forecastsByConcept = new Map<FactId, ConceptForecastSignal[]>();

  for (const attempt of input.attempts) {
    let effective = attempt;
    if (eventAttributedKcIds(attempt) !== null) {
      const outcome = eventKcOutcome(attempt, attempt.conceptId);
      if (outcome === 'unknown') continue;
      if (outcome !== attempt.outcome) effective = { ...attempt, outcome };
    }
    const list = attemptsByConcept.get(effective.conceptId) ?? [];
    list.push(effective);
    attemptsByConcept.set(effective.conceptId, list);
  }
  for (const signal of input.forecasts ?? []) {
    const list = forecastsByConcept.get(signal.conceptId) ?? [];
    list.push(signal);
    forecastsByConcept.set(signal.conceptId, list);
  }

  for (const conceptId of input.conceptIds) {
    if (!Number.isFinite(now)) {
      result.set(conceptId, { status: 'unknown', retrievability: null, independentCount: 0, basisRefs: [], reason: 'unavailable' });
      continue;
    }
    const allAttempts = (attemptsByConcept.get(conceptId) ?? [])
      .filter(entry => Number.isFinite(Date.parse(entry.occurredAt)) && Date.parse(entry.occurredAt) <= now);

    let incomplete = input.incompleteConceptIds?.has(conceptId) === true;
    const independentByKey = new Map<string, ConceptAttemptEvidence>();
    for (const attempt of allAttempts) {
      if (attempt.exposure === 'unknown' || (attempt.exposure === 'independent' && attempt.outcome === 'unknown')) {
        incomplete = true;
        continue;
      }
      if (attempt.exposure !== 'independent') continue;
      const key = `${attempt.submission.id}:${attempt.questionId}:${attempt.itemId ?? ''}`;
      const existing = independentByKey.get(key);
      if (!existing || compareAttempts(existing, attempt) < 0) independentByKey.set(key, attempt);
    }

    const independent = [...independentByKey.values()].sort(compareAttempts);
    if (incomplete) {
      result.set(conceptId, {
        status: 'unknown', retrievability: null, independentCount: independent.length,
        basisRefs: [], reason: 'incomplete-coverage',
      });
      continue;
    }
    if (!independent.length) {
      result.set(conceptId, {
        status: 'unknown', retrievability: null, independentCount: 0,
        basisRefs: [], reason: 'no-independent-evidence',
      });
      continue;
    }

    const latest = independent.at(-1)!;
    const usableForecast = (forecastsByConcept.get(conceptId) ?? [])
      .filter(signal =>
        Number.isFinite(signal.probability) && signal.probability >= 0 && signal.probability <= 1 &&
        BigInt(signal.observedThrough) >= BigInt(latest.recordedTick) &&
        (signal.crossingAt === undefined || Date.parse(signal.crossingAt) >= now))
      .sort((left, right) => {
        const diff = BigInt(right.effectiveTick) - BigInt(left.effectiveTick);
        return diff === 0n ? 0 : diff > 0n ? 1 : -1;
      })[0];

    const basisRefs = dedupeRefs([
      ...independent.flatMap(entry => [entry.submission, ...entry.basisRefs]),
      ...(usableForecast?.basisRefs ?? []),
    ]);
    const retrievability = usableForecast ? Number(usableForecast.probability.toFixed(4)) : null;

    let status: ConceptMasteryStatus;
    if (latest.outcome === 'incorrect' || input.activeMisconceptionConceptIds?.has(conceptId)) {
      status = 'fragile';
    } else if (usableForecast) {
      const decaying = usableForecast.probability <= crossingProbability ||
        (usableForecast.crossingAt !== undefined && nearFlashCrossing(usableForecast.crossingAt, now));
      status = decaying ? 'fading' : 'steady';
    } else {
      const elapsedDays = Math.max(0, (now - Date.parse(latest.occurredAt)) / 86_400_000);
      const retentionFactor = 2 ** (-elapsedDays / halfLifeDays);
      const quality = latest.outcome === 'partial' ? partialScoreFor(latest, conceptId) : 1;
      status = quality < crossingProbability ? 'fragile' : quality * retentionFactor <= crossingProbability ? 'fading' : 'steady';
    }

    result.set(conceptId, { status, retrievability, independentCount: independent.length, basisRefs });
  }
  return result;
}

export function projectCalibrationSummary(
  reconciliations: readonly CalibrationInputRecord[],
  limit = 12,
): CalibrationSummary {
  const sorted = [...reconciliations].sort((left, right) => {
    const diff = BigInt(right.effectiveTick) - BigInt(left.effectiveTick);
    if (diff !== 0n) return diff > 0n ? 1 : -1;
    return right.id.localeCompare(left.id);
  });
  let confirmed = 0;
  let missed = 0;
  for (const row of sorted) {
    if (row.status === 'matched') confirmed += 1;
    else if (row.status === 'missed') missed += 1;
  }
  const recent: CalibrationRecord[] = sorted.slice(0, limit).map(row => ({
    id: row.id,
    key: row.key,
    forecastId: row.forecastId,
    itemId: row.itemId,
    status: row.status,
    outcome: row.status === 'matched' ? 'confirmed' : row.status === 'missed' ? 'missed' : row.status,
    observedResult: row.observation.result,
    exposure: row.observation.exposure,
    effectiveTick: row.effectiveTick,
    method: row.method,
    window: row.window,
    href: row.href,
  }));
  return {
    status: confirmed + missed > 0 ? 'available' : 'unknown',
    totalReconciliations: sorted.length,
    confirmed,
    missed,
    recent,
  };
}
export function extractConceptForecastSignals(
  forecasts: readonly {
    readonly effectiveTick: Tick;
    readonly observedThrough: Tick;
    readonly probability: number;
    readonly crossingAt?: string;
    readonly kcId?: string;
    readonly paperQuestionIds: readonly string[];
    readonly basisRefs: readonly ConceptMasteryBasisRef[];
  }[],
  conceptIdSet: ReadonlySet<string>,
  conceptsByQuestion: ReadonlyMap<string, readonly FactId[]>,
): readonly ConceptForecastSignal[] {
  const signals: ConceptForecastSignal[] = [];
  for (const row of forecasts) {
    const targets = new Set<FactId>();
    if (row.kcId) {
      // An explicit kcId is the precise attribution target: never leak into
      // unrelated paper concepts when the explicit kcId is outside this view.
      if (conceptIdSet.has(row.kcId)) targets.add(row.kcId as FactId);
    } else {
      for (const qid of row.paperQuestionIds) {
        for (const cid of conceptsByQuestion.get(qid) ?? []) targets.add(cid);
      }
    }
    for (const conceptId of targets) {
      signals.push({
        conceptId,
        effectiveTick: row.effectiveTick,
        observedThrough: row.observedThrough,
        probability: row.probability,
        ...(row.crossingAt ? { crossingAt: row.crossingAt } : {}),
        basisRefs: row.basisRefs,
      });
    }
  }
  return signals;
}
