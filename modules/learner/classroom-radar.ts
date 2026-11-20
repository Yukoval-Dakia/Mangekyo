import type { Outcome } from '@mangekyo/kernel';
import type { RetentionEstimate } from './retention.ts';

type Forecast = Extract<RetentionEstimate, {kind: 'probabilistic'}>;
type KeySet = readonly string[];

// Host-only projection inputs. Each supplied collection covers the authorized
// scope at the same snapshot. Omit a collection when the reader was partial.
export type ClassroomRadarSources = {
  forecasts?: readonly Forecast[];
  highConfidenceWrong?: KeySet;
  unassessedExamConcepts?: KeySet;
  exhaustedVariantFamilies?: KeySet;
  pendingWarmBackfills?: KeySet;
  gardeningCandidates?: KeySet;
  inFlightWork?: KeySet;
  readyInventory?: KeySet;
};

const missing = {kind: 'unknown', reason: '缺少当前范围内完整且获准的依据。'} as const;
function count(ids?: KeySet): Outcome<number> {
  return ids === undefined ? missing : {kind: 'value', value: new Set(ids).size};
}

// Per-call display values only. The caller keeps the manifests used to read
// these collections and revalidates them for the actual recipient before send.
export function projectClassroomRadar(asOf: string, sources: ClassroomRadarSources) {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== asOf) throw new Error('雷达需要规范 UTC 时刻。');
  const end = now + 86_400_000;
  const weaknesses = new Map<string, number>();
  const crossing = new Set<string>();
  const measured = sources.forecasts?.filter(row => !row.bucket.kcId.startsWith('frozen-item/'));
  for (const forecast of measured ?? []) {
    // A predicted future posttest cannot measure mastery at the reading clock.
    if (forecast.asOfAt !== asOf) continue;
    const { kcId } = forecast.bucket;
    if (forecast.masteryProb !== undefined) {
      const previous = weaknesses.get(kcId);
      weaknesses.set(kcId, Math.min(previous ?? 1, forecast.masteryProb));
    }
    const at = Date.parse(forecast.crossingAt ?? '');
    if (now < at && at <= end) crossing.add(kcId);
  }
  const top = [...weaknesses].sort(([a, x], [b, y]) => x - y || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, 3).map(([kcId, mastery]) => ({kcId, mastery}));
  const aligned = measured?.length && measured.every(row => row.asOfAt === asOf);
  const empty = sources.forecasts?.length === 0;
  return {
    weakTop3: empty || (aligned && top.length) ? {kind: 'value' as const, value: top} : missing,
    forgetting24h: empty || aligned ? count([...crossing]) : missing,
    highConfidenceWrong: count(sources.highConfidenceWrong),
    examGaps: count(sources.unassessedExamConcepts),
    exhaustedFamilies: count(sources.exhaustedVariantFamilies),
    warmBackfills: count(sources.pendingWarmBackfills),
    gardening: count(sources.gardeningCandidates),
    workAndInventory: {inFlight: count(sources.inFlightWork), ready: count(sources.readyInventory)},
  };
}
