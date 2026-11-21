// Read after the caller reopens the frozen forecast and its manifest for this
// learner, purpose and recipient. This label never becomes assessment evidence.
import type { RetentionForecast } from './retention.ts';

export type FlashCheckPriority = 'high-confidence-error' | 'threshold-crossing';

export function nearFlashCrossing(crossing: string, now: number) {
  const remaining = Date.parse(crossing) - now;
  return remaining > 0 && remaining <= 86_400_000;
}

export function flashCheckPriority(forecast: RetentionForecast, asOf?: string): FlashCheckPriority | undefined {
  const { input, estimate } = forecast;
  const cutoff = Date.parse(input.window.requestedAt);
  const now = asOf === undefined ? cutoff : Date.parse(asOf);
  if (!(cutoff <= now)) return;
  const slice = input.canonicalEvidence;
  if (slice && (slice.clock_watermark !== input.observedThrough || Date.parse(slice.as_of_at) !== cutoff)) return;
  const key = (id: string, rev: number) => JSON.stringify([id, rev]);
  const omitted = new Set(slice?.omissions?.map(({ref}) => key(ref.id, ref.rev)));
  const same = new Map<string, {confidence: number | undefined; time: number; incorrect: boolean} | null>();
  for (const event of slice?.events ?? []) {
    if (event.item_novelty !== 'same' || 'exam_pacing' in event || 'exam_pacing_item' in event) continue;
    const id = key(event.ref, event.rev);
    // A submission may contain several items. An unanchored event shared by
    // more than one item cannot attest confidence for the card on display.
    same.set(id, same.has(id) ? null : {confidence: event.confidence,
      time: Date.parse(event.occurred_at), incorrect: event.outcome === 'incorrect'});
  }
  for (const row of input.observations) {
    if (row.result !== 'incorrect' || (row.novelty ?? 'same-item') !== 'same-item' ||
        BigInt(row.admittedAt) > BigInt(input.observedThrough)) continue;
    const time = Date.parse(row.submittedAt), id = key(row.submission.id, row.submission.rev);
    if (!(time <= cutoff) || omitted.has(id)) continue;
    const event = same.get(id);
    // The observation belongs to this frozen target. A submission-level slice
    // alone cannot identify which question supplied a confidence rating.
    const confidence = row.confidence;
    if (slice && !(event?.incorrect && event.time === time && event.confidence === confidence)) continue;
    if (confidence !== undefined && confidence >= 0.8 && confidence <= 1) return 'high-confidence-error';
  }
  if (asOf === undefined || estimate.kind !== 'probabilistic' || !estimate.crossingAt ||
      !(Date.parse(estimate.asOfAt ?? '') <= now && Date.parse(estimate.crossingAt) <= Date.parse(input.window.through))) return;
  return nearFlashCrossing(estimate.crossingAt, now) ? 'threshold-crossing' : undefined;
}
