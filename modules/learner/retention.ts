import { type CanonicalEvidenceSliceV1, type EvidenceEventV1, type FactId, type Revision, type Tick } from '@mangekyo/kernel';

export const forecastType = 'predict.forecast';
export const reconciliationType = 'predict.reconciliation';

export type RetentionDimensions = {
  kcId?: string; representation?: string; context?: string; method?: string;
};

export type RetentionTarget = {
  activity: 'frozen-workbook-item';
  paper: { id: FactId; rev: Revision };
  itemId: string;
  condition: 'same-item' | 'variant' | 'fresh-context';
  gradingVersion: string;
  dimensions?: RetentionDimensions;
};

export type RetentionObservation = {
  submission: { id: FactId; rev: Revision };
  submittedAt: string;
  admittedAt: Tick;
  result: 'correct' | 'incorrect' | 'unknown';
  novelty?: 'same-item' | 'variant' | 'fresh-context';
  scoreNorm?: number;
  effectiveDurationMs?: number;
  polarity?: 'support' | 'counterevidence';
  dimensions?: RetentionDimensions;
  exposure:
    | { kind: 'independent' }
    | { kind: 'exposed'; level?: Exclude<EvidenceEventV1['help_level'], 'independent' | 'unknown'>; refs: readonly { id: FactId; rev: Revision }[] }
    | { kind: 'unknown'; reason: string };
};

export type RetentionInput = {
  target: RetentionTarget;
  window: { requestedAt: string; scheduledAt?: string; through: string };
  observedThrough: Tick;
  observations: readonly RetentionObservation[];
  canonicalEvidence?: CanonicalEvidenceSliceV1;
};

export type RetentionEstimate =
  | { kind: 'unknown'; reason: string; needed?: string }
  | { kind: 'categorical'; expected: 'correct' | 'incorrect'; basis: RetentionObservation['submission'] }
  | {
      kind: 'probabilistic';
      expected?: 'correct' | 'incorrect';
      asOfAt?: string;
      crossingAt?: string;
      stabilityDays?: number;
      probability: number;
      interval: readonly [number, number];
      uncertainty: number;
      effectiveEvidence: number;
      masteryProb?: number;
      difficulty?: number;
      intervalDays?: readonly number[];
      evidenceRefs?: readonly { ref: string; rev: number }[];
      bucket: { kcId: string; representation: string; context: string; method: string };
      basis: RetentionObservation['submission'] | null;
    };

export type RetentionMethod = {
  id: string;
  version: string;
  predict(input: RetentionInput): RetentionEstimate;
};

// A method whose derive runs in the out-of-process Python worker. The host
// resolves `engine` and never lets this declaration pretend to be in-process.
export type PythonRetentionMethod = {
  id: string;
  version: string;
  engine: 'python';
  deriver: string;
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
const pythonRetentionMethods: PythonRetentionMethod[] = [
  { id: 'cognition', version: '1', engine: 'python', deriver: 'learner/cognition@1' },
  { id: 'dimensioned-retention', version: '1', engine: 'python', deriver: 'learner/retention-forecast@1' },
];
export const defaultRetentionMethod = 'cognition@1';

export function readRetentionMethod(ref: string) {
  return retentionMethods.find(method => method.id + '@' + method.version === ref);
}

export function readPythonRetentionMethod(ref: string) {
  return pythonRetentionMethods.find(method => method.id + '@' + method.version === ref);
}

export function readAnyRetentionMethod(ref: string): RetentionMethod | PythonRetentionMethod | undefined {
  return readRetentionMethod(ref) ?? readPythonRetentionMethod(ref);
}

export function evaluateRetention(method: RetentionMethod | PythonRetentionMethod, input: RetentionInput,
  estimate?: RetentionEstimate) {
  const resolved = 'predict' in method ? method.predict(input) : estimate;
  if (!resolved) throw new Error('A Python retention forecast requires the worker result');
  return { method: { id: method.id, version: method.version }, estimate: resolved, input };
}

/** A shadow caller can run evaluateRetention on this same frozen input. It has no write capability. */
export type RetentionForecast = ReturnType<typeof evaluateRetention>;

export function reconcileRetention(forecast: RetentionForecast, observation: RetentionObservation) {
  let status: 'contaminated' | 'awaiting-independent' | 'observed' | 'matched' | 'missed';
  if (BigInt(observation.admittedAt) <= BigInt(forecast.input.observedThrough) ||
      Date.parse(observation.submittedAt) < Date.parse(forecast.input.window.scheduledAt ?? forecast.input.window.requestedAt) ||
      Date.parse(observation.submittedAt) > Date.parse(forecast.input.window.through) ||
      forecast.input.observations.some(prior => prior.submission.id === observation.submission.id) ||
      forecast.input.canonicalEvidence?.events.some(event => event.ref === observation.submission.id) ||
      !comparableObservation(forecast.input, observation)) status = 'awaiting-independent';
  else if (observation.exposure.kind === 'exposed') status = 'contaminated';
  else if (observation.exposure.kind === 'unknown' || observation.result === 'unknown') status = 'awaiting-independent';
  else if (forecast.estimate.kind === 'unknown') status = 'observed';
  else {
    const expected = forecast.estimate.kind === 'categorical' ? forecast.estimate.expected
      : forecast.estimate.probability >= 0.5 ? 'correct' : 'incorrect';
    status = expected === observation.result ? 'matched' : 'missed';
  }
  return { status, observation };
}

const novelty = { 'same-item': 'same', variant: 'isomorphic', 'fresh-context': 'transfer' } as const;
const axes = ['kcId', 'representation', 'context', 'method'] as const;

export function comparableObservation(input: RetentionInput, observation: RetentionObservation) {
  return (observation.novelty ?? 'same-item') === input.target.condition &&
    axes.every(key => input.target.dimensions?.[key] === observation.dimensions?.[key]);
}

export function retentionBucketId(input: RetentionInput) {
  // Unclassified legacy questions remain local to one frozen item revision.
  const { paper, itemId } = input.target;
  return 'frozen-item/' + paper.id + '/' + paper.rev + '/' + itemId;
}

export function retentionSlice(input: RetentionInput): CanonicalEvidenceSliceV1 {
  if (input.canonicalEvidence) {
    const slice = input.canonicalEvidence;
    if (slice.clock_watermark !== input.observedThrough ||
        Date.parse(slice.as_of_at) !== Date.parse(input.window.requestedAt) ||
        slice.events.some(e => Date.parse(e.occurred_at) > Date.parse(slice.as_of_at)))
      throw new Error('Canonical evidence does not match the frozen forecast cutoff');
    if (input.target.dimensions?.kcId || input.target.condition !== 'same-item') return slice;
    // Activity has already matched these frozen submissions to this exact paper
    // revision and item. Scope only their same-item events to the forecast;
    // the canonical slice persisted in input keeps the real knowledge links.
    const localBucket = retentionBucketId(input);
    const scoped = new Map<string, RetentionObservation>();
    for (const observation of input.observations) {
      if (comparableObservation(input, observation) && BigInt(observation.admittedAt) <= BigInt(input.observedThrough) &&
          Date.parse(observation.submittedAt) <= Date.parse(slice.as_of_at)) {
        scoped.set(observation.submission.id + '/' + observation.submission.rev, observation);
      }
    }
    if (!scoped.size) return slice;
    // A whole-paper submission can have several scored items at the same revision.
    // Without an item anchor the correct row cannot be recovered from that reference.
    const counts = new Map<string, number>();
    for (const event of slice.events) {
      if (event.item_novelty !== 'same') continue;
      const key = event.ref + '/' + event.rev;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return { ...slice, events: slice.events.map(event => {
      const key = event.ref + '/' + event.rev;
      const observation = scoped.get(key);
      if (counts.get(key) !== 1 || !observation || event.item_novelty !== 'same' ||
          event.outcome !== observation.result || Date.parse(event.occurred_at) !== Date.parse(observation.submittedAt) ||
          (observation.exposure.kind === 'independent' ? 'independent' :
            observation.exposure.kind === 'exposed' ? observation.exposure.level : undefined) !== event.help_level ||
          event.concept_ids.includes(localBucket)) return event;
      return { ...event, concept_ids: [...event.concept_ids, localBucket] };
    }) };
  }
  const events = input.observations.flatMap<EvidenceEventV1>(observation => {
    const { exposure, dimensions = {} } = observation;
    const help = exposure.kind === 'independent' ? 'independent' : exposure.kind === 'exposed' ? exposure.level : undefined;
    if (!help || BigInt(observation.admittedAt) > BigInt(input.observedThrough) ||
        Date.parse(observation.submittedAt) > Date.parse(input.window.requestedAt)) return [];
    const { kcId, ...otherAxes } = dimensions;
    return [{
      ref: observation.submission.id, rev: observation.submission.rev, occurred_at: observation.submittedAt,
      concept_ids: [kcId ?? retentionBucketId(input)], item_novelty: novelty[observation.novelty ?? 'same-item'],
      ...otherAxes, help_level: help, outcome: observation.result, claim_ids: [],
      ...(observation.scoreNorm === undefined ? {} : { score_norm: observation.scoreNorm }),
      ...(observation.effectiveDurationMs === undefined ? {} : { effective_duration_ms: observation.effectiveDurationMs }),
    }];
  });
  return {
    clock_watermark: input.observedThrough, as_of_at: input.window.requestedAt,
    events, constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [],
  };
}

// Structural projection of fields used by this slot. The executor validates the
// full wire schema before presenting a result to this pure adapter.
type CognitionRow = {
  state: 'known' | 'unknown'; concept_id: string; item_novelty: string;
  representation: string | null; context: string | null; method: string | null;
  uncertainty: { kind: 'interval'; low: number; high: number } | { kind: 'unknown'; reason: string; needed: string };
  evidence_refs: readonly { ref: string; rev: number }[];
  mastery_prob?: number; difficulty?: number; interval_days?: readonly number[];
  r_now?: number; crossing_at?: string; stability_days?: number; effective_evidence?: number;
};

export type CognitionOutput = { method_version: string; state_vector: readonly CognitionRow[] };

export function freezeCognition(input: RetentionInput, output: CognitionOutput): RetentionForecast {
  const method = readPythonRetentionMethod(output.method_version);
  if (!method) throw new Error('Unknown Python retention method');
  const { kcId = retentionBucketId(input), representation, context, method: strategy } = input.target.dimensions ?? {};
  const row = output.state_vector.find(r => r.concept_id === kcId && r.item_novelty === novelty[input.target.condition] &&
    r.representation === (representation ?? null) && r.context === (context ?? null) && r.method === (strategy ?? null));
  if (!row || row.state === 'unknown') return evaluateRetention(method, input, { kind: 'unknown',
    reason: row?.uncertainty.kind === 'unknown' ? row.uncertainty.reason : 'missing-independent-scored-evidence',
    needed: 'independent-scored-attempt-in-target-dimension' });
  if (row.uncertainty.kind !== 'interval' || row.r_now === undefined || row.effective_evidence === undefined)
    throw new Error('Incomplete known retention output');
  const slice = retentionSlice(input);
  const independent = new Set(slice.events.filter(e => e.help_level === 'independent' && e.outcome !== 'unknown' &&
    e.concept_ids.includes(kcId) && e.item_novelty === novelty[input.target.condition] &&
    e.representation === representation && e.context === context && e.method === strategy).map(e => e.ref + '/' + e.rev));
  const source = row.evidence_refs.findLast(r => independent.has(r.ref + '/' + r.rev));
  const basis = source && input.observations.find(item => item.submission.id === source.ref && item.submission.rev === source.rev);
  if (!source) throw new Error('Missing independent basis for known forecast');
  return evaluateRetention(method, input, {
    kind: 'probabilistic', probability: row.r_now, expected: row.r_now >= 0.5 ? 'correct' : 'incorrect',
    interval: [row.uncertainty.low, row.uncertainty.high], uncertainty: 1 / (1 + row.effective_evidence),
    effectiveEvidence: row.effective_evidence, basis: basis?.submission ?? null,
    evidenceRefs: row.evidence_refs,
    ...(row.mastery_prob !== undefined ? { masteryProb: row.mastery_prob } : {}),
    ...(row.interval_days ? { intervalDays: row.interval_days } : {}),
    ...(row.difficulty !== undefined ? { difficulty: row.difficulty } : {}),
    asOfAt: input.window.scheduledAt ?? slice.as_of_at,
    ...(row.stability_days === undefined ? {} : { stabilityDays: row.stability_days }),
    ...(row.crossing_at ? { crossingAt: row.crossing_at } : {}),
    bucket: { kcId, representation: representation ?? 'unscoped', context: context ?? 'unscoped', method: strategy ?? 'unscoped' },
  });
}

export async function evaluateFrozenRetention(method: RetentionMethod | PythonRetentionMethod, input: RetentionInput,
  derive: (slice: ReturnType<typeof retentionSlice>, version: string) => Promise<CognitionOutput>) {
  if ('predict' in method) return evaluateRetention(method, input);
  const version = method.id + '@' + method.version;
  const slice = retentionSlice(input);
  // A scheduled posttest projects the same evidence forward. Its evidence cutoff
  // and snapshot watermark remain frozen in input.canonicalEvidence.
  const projected = input.window.scheduledAt ? { ...slice, as_of_at: input.window.scheduledAt } : slice;
  const result = await derive(projected, version);
  if (result.method_version !== version) throw new Error('Retention worker returned a different method');
  return freezeCognition(input, result);
}
