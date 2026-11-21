// Read after the caller reopens the frozen forecast and its manifest for this
// learner, purpose and recipient. This label never becomes assessment evidence.
import type { EvidenceEventV1 } from '@mangekyo/kernel';
import type { RetentionForecast, RetentionInput, RetentionObservation } from './retention.ts';

export type FlashCheckPriority = 'high-confidence-error' | 'lucky-guess-check' | 'threshold-crossing';

type FlashCheckSignal =
  | { priority: 'high-confidence-error' | 'lucky-guess-check'; submission: RetentionObservation['submission'] }
  | { priority: 'threshold-crossing' };

export function nearFlashCrossing(crossing: string, now: number) {
  const remaining = Date.parse(crossing) - now;
  return remaining > 0 && remaining <= 86_400_000;
}

export function flashCheckPriority(forecast: RetentionForecast, asOf?: string): FlashCheckPriority | undefined {
  return flashCheckSignal(forecast, asOf)?.priority;
}

export function flashCheckSignal(forecast: RetentionForecast, asOf?: string): FlashCheckSignal | undefined {
  const { input, estimate, method } = forecast;
  const cutoff = Date.parse(input.window.requestedAt);
  const now = asOf === undefined ? cutoff : Date.parse(asOf);
  if (!(cutoff <= now)) return;
  if (!matchingCutoff(input)) return;
  const checkLuckyGuess = method.id === 'cognition' && method.version === '3';
  const answer = confidenceSignal(input, checkLuckyGuess);
  if (answer) return answer;
  if (asOf === undefined || estimate.kind !== 'probabilistic' || !estimate.crossingAt ||
      !(Date.parse(estimate.asOfAt ?? '') <= now && Date.parse(estimate.crossingAt) <= Date.parse(input.window.through))) return;
  return nearFlashCrossing(estimate.crossingAt, now) ? { priority: 'threshold-crossing' } : undefined;
}

function matchingCutoff(input: RetentionInput) {
  const slice = input.canonicalEvidence;
  return !slice || (slice.clock_watermark === input.observedThrough &&
    Date.parse(slice.as_of_at) === Date.parse(input.window.requestedAt));
}

// For the submitted question's feedback. The caller reopens this target's
// paper, submission and evidence manifest for the actual use and recipient.
export function submissionConfidencePriority(input: RetentionInput, submission: RetentionObservation['submission']) {
  if (input.target.condition !== 'same-item' || !input.canonicalEvidence || !matchingCutoff(input)) return;
  return confidenceSignal(input, true, submission)?.priority;
}

function confidenceSignal(input: RetentionInput, checkLuckyGuess: boolean, submission?: RetentionObservation['submission']) {
  const slice = input.canonicalEvidence;
  const cutoff = Date.parse(input.window.requestedAt);
  const key = (id: string, rev: number) => JSON.stringify([id, rev]);
  const omitted = new Set(slice?.omissions?.map(({ref}) => key(ref.id, ref.rev)));
  const same = new Map<string, EvidenceEventV1 | null>();
  for (const event of slice?.events ?? []) {
    if (event.item_novelty !== 'same' || 'exam_pacing' in event || 'exam_pacing_item' in event) continue;
    const id = key(event.ref, event.rev);
    // A submission may contain several items. An unanchored event shared by
    // more than one item cannot attest confidence for the card on display.
    same.set(id, same.has(id) ? null : event);
  }
  let luckyGuess: Extract<FlashCheckSignal, {submission: unknown}> | undefined;
  for (const row of input.observations) {
    if (submission && (submission.id !== row.submission.id || submission.rev !== row.submission.rev)) continue;
    if (row.result === 'unknown' || (row.novelty ?? 'same-item') !== 'same-item' ||
        BigInt(row.admittedAt) > BigInt(input.observedThrough)) continue;
    const time = Date.parse(row.submittedAt), id = key(row.submission.id, row.submission.rev);
    if (!(time <= cutoff) || omitted.has(id)) continue;
    const event = same.get(id);
    // The observation belongs to this frozen target. A submission-level slice
    // alone cannot identify which question supplied a confidence rating.
    const confidence = row.confidence;
    if (confidence === undefined || (slice && !(event?.outcome === row.result &&
        Date.parse(event.occurred_at) === time && event.confidence === confidence))) continue;
    if (row.result === 'incorrect' && confidence >= 0.8 && confidence <= 1) {
      return { priority: 'high-confidence-error' as const, submission: row.submission };
    }
    if (checkLuckyGuess && input.target.condition === 'same-item' && row.result === 'correct' && row.exposure.kind === 'independent' &&
        event?.help_level === 'independent' && confidence >= 0 && confidence <= 0.35) {
      luckyGuess = { priority: 'lucky-guess-check', submission: row.submission };
    }
  }
  return luckyGuess;
}
