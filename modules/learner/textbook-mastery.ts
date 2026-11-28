import type { BusWitness, CanonicalEvidenceSliceV1, EvidenceEventV1, LearnerId, Tick } from '@mangekyo/kernel';
import { nearFlashCrossing } from './flash-check.ts';
import { isAttemptEvidenceType } from './memory-evidence.ts';
import {
  eventAttributedKcIds, eventHasScoredKcOutcome, eventIsOmitted, eventKcOutcome, omissionMatchesEvent, parseEventRefKey,
  type SliceOmission,
} from './evidence-refs.ts';
import {
  defaultRetentionMethod, readPythonRetentionMethod, type CognitionOutput, type PythonRetentionMethod,
} from './retention.ts';

export type TextbookMasteryScope = {
  readonly learner: LearnerId;
  readonly purpose: string;
  readonly recipientId: string;
  readonly asOf: string;
  readonly clockWatermark: Tick;
};

export type TextbookMasteryBlock = {
  readonly blockId: string;
  readonly page: BusWitness;
  readonly basis?: readonly BusWitness[];
  readonly concepts: readonly {
    readonly conceptId: string;
    readonly edge: BusWitness;
    readonly basis: readonly BusWitness[];
  }[];
};

export type TextbookMasteryRequest = TextbookMasteryScope & {
  readonly blocks: readonly TextbookMasteryBlock[];
};

export type TextbookMasteryEvidenceAnchor = {
  readonly submission: BusWitness;
  readonly question: BusWitness;
  readonly itemId: string;
  readonly href: string;
  readonly recordedAt: Tick;
  readonly expiresAt?: string;
  readonly basis: readonly BusWitness[];
  // The host supplies the reopened workbook backtrace proof for this exact
  // question: two independent correct sittings and the frozen delayed followup.
  readonly priorStable?: {
    readonly conceptIds: readonly string[];
    readonly basis: readonly [BusWitness, ...BusWitness[]];
  };
};

export type TextbookMasteryEvidenceBatch = {
  readonly slice: CanonicalEvidenceSliceV1;
  readonly anchors: readonly TextbookMasteryEvidenceAnchor[];
  // Exact concepts whose authorized evidence inventory is complete, when the
  // gather encounters omissions it cannot attribute on the public slice.
  readonly completeConceptIds?: readonly string[];
};

export type TextbookMasterySources = {
  readonly methodVersion?: string;
  // Gather formal, item-scoped evidence and its complete basis at this watermark.
  // Open the page, concept edges and sources for this recipient and purpose.
  // Return null when authorized coverage of the requested concepts is unverified.
  readEvidence(scope: TextbookMasteryScope, conceptIds: readonly string[]): Promise<TextbookMasteryEvidenceBatch | null>;
  // The host authorizes the exact witnesses for its actual calculation recipient
  // at dispatch time. A denied, failed or unavailable calculation returns null.
  derive(scope: TextbookMasteryScope, method: PythonRetentionMethod, slice: CanonicalEvidenceSliceV1,
    witnesses: readonly BusWitness[]): Promise<CognitionOutput | null>;
  // Reopen these exact witnesses together for the actual display recipient,
  // checking current epochs, revisions, expiry and deletion. Missing means denied.
  reopen(scope: TextbookMasteryScope, witnesses: readonly BusWitness[]): Promise<readonly BusWitness[]>;
  // Optional host hook after candidates and before the evidence snapshot.
  // It may overlap trusted calculator startup with the authorized DB reads.
  prepareEvidence?: (scope: TextbookMasteryScope, conceptIds: readonly string[]) => void;
};

export type TextbookMasteryAnchor = {
  readonly kind: 'recent-error' | 'prior-stable';
  readonly submissionId: string;
  readonly submissionRev: number;
  readonly itemId: string;
  readonly occurredAt: string;
  readonly href: string;
};

export type TextbookMasteryConcept = { readonly conceptId: string } & (
  | { readonly state: 'unknown'; readonly reason: 'no-independent-evidence' | 'unavailable' }
  | { readonly state: 'steady' | 'decaying' | 'fragile'; readonly anchor?: TextbookMasteryAnchor }
);

export type TextbookMasteryView = {
  readonly asOf: string;
  readonly blocks: readonly {
    readonly page: Pick<BusWitness, 'id' | 'rev' | 'accessEpoch'>;
    readonly blockId: string;
    readonly concepts: readonly TextbookMasteryConcept[];
  }[];
};

type ScoredEvent = Exclude<EvidenceEventV1, { readonly help_level: 'unknown' }>;

type Attempt = {
  readonly event: ScoredEvent;
  readonly anchor: TextbookMasteryEvidenceAnchor;
};

type Bucket = {
  readonly dimensions: string;
  readonly novelty: EvidenceEventV1['item_novelty'];
  readonly contextKey: string;
  readonly attempts: Map<string, Attempt>;
};

type ConceptBuckets = Map<string, Bucket>;

export type VerifiedConceptMasteryDetail = {
  readonly retrievability: number;
  readonly attempts: readonly Attempt[];
};

const decimalTick = /^(0|[1-9][0-9]*)$/u;
const noveltyRank: Readonly<Record<EvidenceEventV1['item_novelty'], number>> = {
  same: 0,
  isomorphic: 1,
  transfer: 2,
};

export function masteryWitnessKey(ref: BusWitness) {
  return JSON.stringify([ref.learner, ref.id, ref.rev, ref.accessEpoch, ref.mode, ref.type]);
}

function eventKey(id: string, rev: number) {
  return JSON.stringify([id, rev]);
}

function contextKey(representation?: string | null, context?: string | null, method?: string | null) {
  return JSON.stringify([representation ?? null, context ?? null, method ?? null]);
}

function bucketKey(novelty: string, representation?: string | null, context?: string | null, method?: string | null) {
  return JSON.stringify([novelty, representation ?? null, context ?? null, method ?? null]);
}

function blockWitnesses(block: TextbookMasteryBlock) {
  return [block.page, ...(block.basis ?? [])];
}

function edgeWitnesses(link: TextbookMasteryBlock['concepts'][number]) {
  return [link.edge, ...link.basis];
}

function attemptWitnesses({ anchor }: Attempt) {
  return [anchor.submission, anchor.question, ...anchor.basis];
}

export function isLocalMasteryWitness(ref: BusWitness, scope: TextbookMasteryScope) {
  return (ref.mode === 'following' || ref.mode === 'pinned') &&
    decimalTick.test(ref.accessEpoch) && decimalTick.test(scope.clockWatermark) &&
    ref.learner === scope.learner && BigInt(ref.accessEpoch) <= BigInt(scope.clockWatermark);
}

function uniqueWitnesses(refs: Iterable<BusWitness>) {
  return [...new Map(Array.from(refs, ref => [masteryWitnessKey(ref), ref])).values()];
}

function validAnchor(anchor: TextbookMasteryEvidenceAnchor, scope: TextbookMasteryScope, cutoff: number) {
  const { submission, question, basis, recordedAt, expiresAt, itemId, href } = anchor;
  return isAttemptEvidenceType(submission.type) && itemId.trim().length > 0 && /^\/(?!\/)[^\\\s]*$/u.test(href)
    && decimalTick.test(recordedAt) && BigInt(recordedAt) <= BigInt(scope.clockWatermark)
    && (expiresAt === undefined || cutoff < Date.parse(expiresAt))
    && [submission, question, ...basis].every(ref => isLocalMasteryWitness(ref, scope));
}

function evidenceBuckets(batch: TextbookMasteryEvidenceBatch, scope: TextbookMasteryScope, concepts: ReadonlySet<string>) {
  const buckets = new Map<string, ConceptBuckets | null>();
  const { slice } = batch;
  const cutoff = Date.parse(scope.asOf);
  if (slice.as_of_at !== scope.asOf || slice.clock_watermark !== scope.clockWatermark ||
      !Number.isFinite(cutoff) || !decimalTick.test(scope.clockWatermark)) return null;

  const omissions = (slice.omissions ?? []) as readonly SliceOmission[];
  const anchorsByKey = new Map<string, TextbookMasteryEvidenceAnchor[] | null>();
  for (const anchor of batch.anchors) {
    const key = eventKey(anchor.submission.id, anchor.submission.rev);
    if (!validAnchor(anchor, scope, cutoff)) {
      anchorsByKey.set(key, null);
      continue;
    }
    const held = anchorsByKey.get(key);
    if (held === null) continue;
    // Duplicate anchors for the exact same (submission, rev, itemId) are ambiguous.
    if (held?.some(prior => prior.itemId === anchor.itemId)) {
      anchorsByKey.set(key, null);
      continue;
    }
    anchorsByKey.set(key, held ? [...held, anchor] : [anchor]);
  }

  const eventCoords = new Map<EvidenceEventV1, { baseId: string; rev: number; itemId: string | null }>();
  for (const event of slice.events) {
    const parsed = parseEventRefKey(event.ref);
    const v2ref = (event as { fact_ref?: { id?: unknown; rev?: unknown } }).fact_ref;
    const explicitItem = (event as { item_id?: unknown }).item_id;
    const baseId = v2ref && typeof v2ref.id === 'string' ? v2ref.id : parsed.baseId;
    const rev = v2ref && typeof v2ref.rev === 'number' ? v2ref.rev : event.rev;
    const itemId = typeof explicitItem === 'string' && explicitItem.length > 0 ? explicitItem : parsed.itemId;
    eventCoords.set(event, { baseId, rev, itemId });
  }
  const eventsByKey = new Map<string, EvidenceEventV1[]>();
  for (const event of slice.events) {
    const coords = eventCoords.get(event)!;
    const key = eventKey(coords.baseId, coords.rev);
    const list = eventsByKey.get(key);
    if (list) list.push(event);
    else eventsByKey.set(key, [event]);
  }
  const pairing = new Map<EvidenceEventV1, TextbookMasteryEvidenceAnchor | null>();
  const sortedEvents = (list: readonly EvidenceEventV1[]) => [...list].sort((a, b) => {
    const ta = Date.parse(a.occurred_at);
    const tb = Date.parse(b.occurred_at);
    if (ta !== tb) return ta - tb;
    if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa === sb ? 0 : sa < sb ? -1 : 1;
  });
  for (const [key, list] of eventsByKey) {
    const anchors = anchorsByKey.get(key);
    if (anchors === undefined || anchors === null) {
      for (const event of list) pairing.set(event, null);
      continue;
    }
    const byItem = new Map<string, TextbookMasteryEvidenceAnchor>();
    for (const anchor of anchors) byItem.set(anchor.itemId, anchor);
    const keyed: EvidenceEventV1[] = [];
    const unkeyed: EvidenceEventV1[] = [];
    for (const event of list) (eventCoords.get(event)!.itemId ? keyed : unkeyed).push(event);
    if (keyed.length > 0) {
      for (const event of keyed) pairing.set(event, byItem.get(eventCoords.get(event)!.itemId!) ?? null);
      // Legacy positional identity is unrecoverable once keyed events reorder the group.
      for (const event of unkeyed) pairing.set(event, null);
      continue;
    }
    if (anchors.length === 1) {
      const anchor = anchors[0]!;
      const first = JSON.stringify(sortedEvents(list)[0]);
      const consistent = list.every(ev => JSON.stringify(ev) === first);
      for (const event of list) pairing.set(event, consistent ? anchor : null);
      continue;
    }
    // Legacy unkeyed multi-item batches (e.g. graph-mastery-evidence) emit events
    // and anchors in matching positional order; preserve that pairing verbatim
    // instead of guessing via sort order, and fail closed on length mismatch.
    if (list.length === anchors.length) {
      list.forEach((event, index) => pairing.set(event, anchors[index] ?? null));
    } else {
      for (const event of list) pairing.set(event, null);
    }
  }

  const omissionAssigned = (omission: SliceOmission) =>
    slice.events.some(event => (eventAttributedKcIds(event) ?? event.concept_ids).length > 0 && omissionMatchesEvent(event, omission));
  const unassignedOmission = omissions.some(omission => !omissionAssigned(omission));
  const complete = batch.completeConceptIds && new Set(batch.completeConceptIds);
  for (const concept of concepts) {
    if (complete ? !complete.has(concept) : unassignedOmission) buckets.set(concept, null);
  }
  const conceptRefs = new Map<string, Map<string, string>>();
  // Deterministic iteration: input permutation never changes the bucket content
  // or the calculation event order (P0-2).
  for (const event of sortedEvents(slice.events)) {
    const anchor = pairing.get(event) ?? null;
    if (!(Date.parse(event.occurred_at) <= cutoff)) continue;
    const attributed = eventAttributedKcIds(event) ?? event.concept_ids;
    if (eventIsOmitted(event, omissions)) {
      for (const concept of attributed) if (concepts.has(concept)) buckets.set(concept, null);
      continue;
    }
    if (event.help_level !== 'independent' || event.exam_pacing || event.exam_pacing_item) continue;
    const coords = eventCoords.get(event)!;
    const compositeKey = coords.itemId !== null || (anchorsByKey.get(eventKey(coords.baseId, coords.rev))?.length ?? 0) > 1;
    const calcEvent: ScoredEvent = anchor && compositeKey
      ? { ...event, ref: JSON.stringify([anchor.submission.id, anchor.itemId]) }
      : event;
    const dimension = bucketKey(calcEvent.item_novelty, calcEvent.representation, calcEvent.context, calcEvent.method);
    const ctxKey = contextKey(calcEvent.representation, calcEvent.context, calcEvent.method);
    for (const concept of attributed) {
      if (!concepts.has(concept)) continue;
      if (!eventHasScoredKcOutcome(event, concept)) {
        buckets.set(concept, null);
        continue;
      }
      let byDimension = buckets.get(concept);
      if (byDimension === null) continue;
      if (!anchor) {
        buckets.set(concept, null);
        continue;
      }
      if (!byDimension) {
        byDimension = new Map();
        buckets.set(concept, byDimension);
      }
      let refs = conceptRefs.get(concept);
      if (!refs) {
        refs = new Map();
        conceptRefs.set(concept, refs);
      }
      const priorDim = refs.get(calcEvent.ref);
      if (priorDim !== undefined && priorDim !== dimension) {
        buckets.set(concept, null);
        continue;
      }
      let bucket = byDimension.get(dimension);
      if (!bucket) {
        bucket = { dimensions: dimension, novelty: calcEvent.item_novelty, contextKey: ctxKey, attempts: new Map() };
        byDimension.set(dimension, bucket);
      }
      const prior = bucket.attempts.get(calcEvent.ref);
      if (prior && JSON.stringify(prior.event) !== JSON.stringify(calcEvent)) {
        buckets.set(concept, null);
        continue;
      }
      refs.set(calcEvent.ref, dimension);
      bucket.attempts.set(calcEvent.ref, { event: calcEvent, anchor });
    }
  }
  return buckets;
}

type VerifiedBucketRow = {
  readonly bucket: Bucket;
  readonly row: CognitionOutput['state_vector'][number];
};

function verifiedRows(result: CognitionOutput | null, version: string, buckets: ReadonlyMap<string, ConceptBuckets | null>) {
  const matched = new Map<string, Map<string, VerifiedBucketRow> | null>();
  if (result?.method_version !== version) return new Map<string, readonly VerifiedBucketRow[]>();
  for (const row of result.state_vector) {
    const byDimension = buckets.get(row.concept_id);
    if (!byDimension) continue;
    const held = matched.get(row.concept_id);
    if (held === null) continue;
    const dimensions = bucketKey(row.item_novelty, row.representation, row.context, row.method);
    const bucket = byDimension.get(dimensions);
    const refs = new Map(row.evidence_refs.map(ref => [ref.ref, ref.rev]));
    const ok = !!bucket && row.state === 'known' && row.uncertainty.kind === 'interval'
      && row.evidence_refs.length === bucket.attempts.size && refs.size === bucket.attempts.size
      && [...bucket.attempts].every(([ref, { event }]) => refs.get(ref) === event.rev);
    if (!ok || held?.has(dimensions)) {
      matched.set(row.concept_id, null);
      continue;
    }
    const next = held ?? new Map<string, VerifiedBucketRow>();
    next.set(dimensions, { bucket, row });
    matched.set(row.concept_id, next);
  }
  const verified = new Map<string, readonly VerifiedBucketRow[]>();
  for (const [concept, byDimension] of buckets) {
    if (!byDimension || !byDimension.size) continue;
    const rows = matched.get(concept);
    if (!rows || rows.size !== byDimension.size) continue;
    verified.set(concept, [...rows.values()]);
  }
  return verified;
}

// The registered Python retention methods report crossings at this boundary.
// This view assigns labels to a worker result without estimating retention.
const crossingProbability = 0.60;

function newer(attempt: Attempt, latest: Attempt | undefined, conceptId: string) {
  if (!latest) return true;
  const elapsed = Date.parse(attempt.event.occurred_at) - Date.parse(latest.event.occurred_at);
  if (elapsed !== 0) return elapsed > 0;
  const tickDiff = BigInt(attempt.anchor.recordedAt) - BigInt(latest.anchor.recordedAt);
  if (tickDiff !== 0n) return tickDiff > 0n;
  const aOutcome = eventKcOutcome(attempt.event, conceptId);
  const lOutcome = eventKcOutcome(latest.event, conceptId);
  if (aOutcome !== lOutcome) return aOutcome === 'incorrect';
  return attempt.anchor.itemId.localeCompare(latest.anchor.itemId) > 0;
}

function selectEffectiveBucket(
  conceptId: string,
  entries: readonly VerifiedBucketRow[],
  latest: Attempt,
  latestBucket: Bucket,
): VerifiedBucketRow {
  if (entries.length === 1) return entries[0]!;
  if (eventKcOutcome(latest.event, conceptId) === 'incorrect') {
    return entries.find(entry => entry.bucket.dimensions === latestBucket.dimensions) ?? entries[0]!;
  }
  // Within each (representation, context, method) group, higher novelty
  // (transfer > isomorphic > same) supersedes earlier lower-novelty buckets.
  const byContext = new Map<string, VerifiedBucketRow>();
  for (const entry of entries) {
    const held = byContext.get(entry.bucket.contextKey);
    if (!held || noveltyRank[entry.bucket.novelty] > noveltyRank[held.bucket.novelty]) {
      byContext.set(entry.bucket.contextKey, entry);
    }
  }
  // Across distinct (representation, context, method) groups, stay conservative
  // by surfacing the weakest verified retrievability so gaps are not masked.
  return [...byContext.values()].reduce((weakest, entry) =>
    (entry.row.r_now ?? 1) < (weakest.row.r_now ?? 1) ? entry : weakest);
}

function projectConcept(conceptId: string, entries: readonly VerifiedBucketRow[],
  scope: TextbookMasteryScope, allowed: (ref: BusWitness) => boolean):
  { concept: TextbookMasteryConcept; detail: VerifiedConceptMasteryDetail } | null {
  const now = Date.parse(scope.asOf);
  for (const { row } of entries) {
    if (row.state !== 'known' || row.r_now === undefined || !(row.r_now >= 0 && row.r_now <= 1)
      || (row.crossing_at !== undefined && !(Date.parse(row.crossing_at) >= now))) return null;
  }
  let latest: Attempt | undefined;
  let latestBucket: Bucket | undefined;
  const allAttempts: Attempt[] = [];
  const latestByQuestion = new Map<string, Attempt>();
  for (const { bucket } of entries) {
    for (const attempt of bucket.attempts.values()) {
      allAttempts.push(attempt);
      if (newer(attempt, latest, conceptId)) {
        latest = attempt;
        latestBucket = bucket;
      }
      const questionId = attempt.anchor.question.id;
      if (newer(attempt, latestByQuestion.get(questionId), conceptId)) latestByQuestion.set(questionId, attempt);
    }
  }
  if (!latest || !latestBucket) return null;
  const { row } = selectEffectiveBucket(conceptId, entries, latest, latestBucket);
  let error: Attempt | undefined;
  let stable: Attempt | undefined;
  for (const attempt of latestByQuestion.values()) {
    if (eventKcOutcome(attempt.event, conceptId) === 'incorrect') {
      if (newer(attempt, error, conceptId)) error = attempt;
      continue;
    }
    const { priorStable, question, submission } = attempt.anchor;
    if (!priorStable?.conceptIds.includes(conceptId) || !newer(attempt, stable, conceptId)) continue;
    const { basis } = priorStable;
    if (basis.some(ref => masteryWitnessKey(ref) === masteryWitnessKey(question))
      && basis.some(ref => masteryWitnessKey(ref) === masteryWitnessKey(submission))
      && basis.some(ref => ref.id === conceptId)
      && basis.some(ref => ref.type === 'activity.retentionPosttest')
      && new Set(basis.filter(ref => isAttemptEvidenceType(ref.type)).map(ref => ref.id)).size >= 2
      && basis.every(ref => isLocalMasteryWitness(ref, scope) && allowed(ref))) stable = attempt;
  }
  const decaying = row.r_now! <= crossingProbability || (row.crossing_at !== undefined && nearFlashCrossing(row.crossing_at, now));
  const state = eventKcOutcome(latest.event, conceptId) === 'incorrect' ? 'fragile' : decaying ? 'decaying' : 'steady';
  const selected = state === 'fragile' ? error : stable ?? error;
  const concept: TextbookMasteryConcept = selected
    ? {
        conceptId, state,
        anchor: {
          kind: eventKcOutcome(selected.event, conceptId) === 'incorrect' ? 'recent-error' : 'prior-stable',
          submissionId: selected.anchor.submission.id, submissionRev: selected.anchor.submission.rev,
          occurredAt: selected.event.occurred_at, itemId: selected.anchor.itemId, href: selected.anchor.href,
        },
      }
    : { conceptId, state };
  return { concept, detail: { retrievability: row.r_now!, attempts: allAttempts } };
}

export async function readConceptMastery(scope: TextbookMasteryScope, conceptIds: ReadonlySet<string>,
  displayWitnesses: readonly BusWitness[], sources: TextbookMasterySources) {
  const version = sources.methodVersion ?? defaultRetentionMethod;
  const method = readPythonRetentionMethod(version);
  if (method && conceptIds.size) sources.prepareEvidence?.(scope, [...conceptIds]);
  const batch = method && conceptIds.size ? await sources.readEvidence(scope, [...conceptIds]) : null;
  const coveredBuckets = batch ? evidenceBuckets(batch, scope, conceptIds) : null;
  const buckets = coveredBuckets ?? new Map<string, ConceptBuckets | null>();
  const eventConcepts = new Map<ScoredEvent, string[]>();
  const usedWitnesses: BusWitness[] = [];
  const stabilityWitnesses: BusWitness[] = [];
  for (const [concept, byDimension] of buckets) {
    if (!byDimension) continue;
    for (const bucket of byDimension.values()) {
      for (const attempt of bucket.attempts.values()) {
        const selected = eventConcepts.get(attempt.event);
        if (selected) selected.push(concept);
        else {
          eventConcepts.set(attempt.event, [concept]);
          usedWitnesses.push(...attemptWitnesses(attempt));
          stabilityWitnesses.push(...(attempt.anchor.priorStable?.basis.filter(ref => isLocalMasteryWitness(ref, scope)) ?? []));
        }
      }
    }
  }
  const events = [...eventConcepts].map(([event, concept_ids]) => {
    const originalCount = new Set(event.concept_ids).size;
    if (eventAttributedKcIds(event) !== null || originalCount <= 1 || concept_ids.length >= originalCount) {
      return { ...event, concept_ids };
    }
    // Preserve the original multi-KC denominator when narrowing concept_ids to
    // the displayed page subset, so posterior weights do not drift with view scope.
    const share = 1 / originalCount;
    const fallbackCriterion = {
      criterion_id: 'question_fallback',
      input_refs: [],
      earned: null,
      maximum: 1,
      outcome: event.outcome,
      ...(event.score_norm !== undefined ? { score_norm: event.score_norm } : {}),
      ...(event.error_stage !== undefined ? { error_stage: event.error_stage } : {}),
      kc_links: concept_ids.map(kc_id => ({ kc_id, weight: share, role: 'target' as const, source: 'question_fallback' as const })),
      evaluator: { id: 'question-fallback', version: '1' },
    };
    return { ...event, concept_ids, criteria: [fallbackCriterion] };
  });
  // Only activity evidence goes to the calculator. The display recipient
  // reopens its own page or graph context with the exact calculation evidence.
  const calculationWitnesses = uniqueWitnesses(usedWitnesses);
  const result = batch && method && events.length ? await sources.derive(scope, method, {
    as_of_at: scope.asOf, clock_watermark: scope.clockWatermark, events,
    constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [],
  }, calculationWitnesses) : null;
  const witnesses = uniqueWitnesses([...displayWitnesses, ...calculationWitnesses, ...stabilityWitnesses]);
  const reopened = witnesses.length ? await sources.reopen(scope, witnesses) : [];
  const current = new Set(reopened.map(masteryWitnessKey));
  const allowed = (ref: BusWitness) => current.has(masteryWitnessKey(ref));
  const projections = new Map<string, TextbookMasteryConcept>();
  const details = new Map<string, VerifiedConceptMasteryDetail>();
  for (const [concept, entries] of verifiedRows(result, version, buckets)) {
    const allAllowed = entries.every(({ bucket }) =>
      [...bucket.attempts.values()].every(attempt => attemptWitnesses(attempt).every(allowed)));
    if (!allAllowed) continue;
    const projected = projectConcept(concept, entries, scope, allowed);
    if (!projected) continue;
    projections.set(concept, projected.concept);
    details.set(concept, projected.detail);
  }
  return {
    allowed,
    detail: (conceptId: string): VerifiedConceptMasteryDetail | undefined => details.get(conceptId),
    concept: (conceptId: string): TextbookMasteryConcept =>
      projections.get(conceptId) ?? { conceptId, state: 'unknown',
        reason: coveredBuckets && !coveredBuckets.has(conceptId) &&
          (!batch?.slice.omissions?.length || batch.completeConceptIds?.includes(conceptId))
          ? 'no-independent-evidence' : 'unavailable' },
  };
}

export async function projectTextbookMastery(request: TextbookMasteryRequest, sources: TextbookMasterySources): Promise<TextbookMasteryView> {
  const { blocks, ...scope } = request;
  const local = (ref: BusWitness) => isLocalMasteryWitness(ref, scope);
  const visibleBlocks = blocks.filter(block => blockWitnesses(block).every(local)).map(block => ({
    ...block, concepts: block.concepts.filter(link =>
      link.basis.some(ref => ref.id === link.conceptId) && edgeWitnesses(link).every(local)),
  }));
  const conceptIds = new Set(visibleBlocks.flatMap(block => block.concepts.map(link => link.conceptId)));
  const pageAndEdgeWitnesses = visibleBlocks.flatMap(block => [...blockWitnesses(block), ...block.concepts.flatMap(edgeWitnesses)]);
  const { allowed, concept } = await readConceptMastery(scope, conceptIds, pageAndEdgeWitnesses, sources);
  return { asOf: scope.asOf, blocks: visibleBlocks.flatMap(block => {
    if (!blockWitnesses(block).every(allowed)) return [];
    const concepts = new Set(block.concepts.filter(link => edgeWitnesses(link).every(allowed)).map(link => link.conceptId));
    const { id, rev, accessEpoch } = block.page;
    return [{
      page: { id, rev, accessEpoch },
      blockId: block.blockId,
      concepts: [...concepts].map(concept),
    }];
  }) };
}
