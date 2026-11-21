import type { BusWitness, EvidenceEventV1, FactId, Revision } from '@mangekyo/kernel';
import { evidenceTime, isAttemptEvidenceType } from './memory-evidence.ts';
import type { CognitionOutput } from './retention.ts';
import {
  isLocalMasteryWitness, readConceptMastery, type TextbookMasteryEvidenceAnchor,
  type TextbookMasteryEvidenceBatch, type TextbookMasteryScope, type TextbookMasterySources,
} from './textbook-mastery.ts';

export type GraphConceptNodeInput = {
  readonly conceptId: string;
  readonly witness?: BusWitness;
  readonly basis?: readonly BusWitness[];
  /** Direct compatibility with Content's KnowledgeGraphNode.proof witnesses. */
  readonly proof?: readonly BusWitness[];
};

export type GraphConceptMasteryRequest = TextbookMasteryScope & {
  readonly concepts: readonly GraphConceptNodeInput[];
};

export type GraphConceptMasterySources = TextbookMasterySources;

export type GraphConceptEvidenceRef = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly occurredAt: string;
  readonly itemId: string;
  readonly href: string;
};

export type GraphConceptMasteryNode = {
  readonly conceptId: string;
  readonly status: 'solid' | 'fading' | 'weak' | 'unknown';
  readonly retrievability: number | null;
  readonly independentAttempts: number;
  readonly lastEvidenceAt: string | null;
  readonly recentEvidenceRefs: readonly GraphConceptEvidenceRef[];
};

export type GraphConceptMasteryView = {
  readonly asOf: string;
  readonly concepts: readonly GraphConceptMasteryNode[];
};

type ScoredEvent = Exclude<EvidenceEventV1, { readonly help_level: 'unknown' }>;
type Bucket = { dimensions: string; attempts: Map<string, { event: ScoredEvent; anchor: TextbookMasteryEvidenceAnchor }> };

const decimalTick = /^(0|[1-9][0-9]*)$/u;
const statusByState = { steady: 'solid', decaying: 'fading', fragile: 'weak' } as const;

const emptyNode = (conceptId: string): GraphConceptMasteryNode => ({
  conceptId, status: 'unknown', retrievability: null, independentAttempts: 0, lastEvidenceAt: null, recentEvidenceRefs: [],
});

const eventKey = (id: string, rev: number) => JSON.stringify([id, rev]);
const bucketKey = (novelty: string, representation?: string | null, context?: string | null, method?: string | null) =>
  JSON.stringify([novelty, representation ?? null, context ?? null, method ?? null]);

function localWitness(ref: BusWitness, scope: TextbookMasteryScope) {
  return (ref.mode === 'following' || ref.mode === 'pinned') &&
    decimalTick.test(ref.accessEpoch) && isLocalMasteryWitness(ref, scope);
}

function anchorUsable(anchor: TextbookMasteryEvidenceAnchor, scope: TextbookMasteryScope) {
  const cutoff = evidenceTime(scope.asOf);
  return isAttemptEvidenceType(anchor.submission.type) && anchor.itemId.trim().length > 0 &&
    /^\/(?!\/)[^\\\s]*$/u.test(anchor.href) && decimalTick.test(anchor.recordedAt) &&
    BigInt(anchor.recordedAt) <= BigInt(scope.clockWatermark) &&
    (anchor.expiresAt === undefined || cutoff < evidenceTime(anchor.expiresAt)) &&
    [anchor.submission, anchor.question, ...anchor.basis].every(ref => localWitness(ref, scope));
}

function blockedConcepts(batch: TextbookMasteryEvidenceBatch, scope: TextbookMasteryScope, concepts: ReadonlySet<string>) {
  const blocked = new Set<string>();
  if (batch.slice.as_of_at !== scope.asOf || batch.slice.clock_watermark !== scope.clockWatermark ||
      Number.isNaN(evidenceTime(batch.slice.as_of_at))) return new Set(concepts);
  const complete = batch.completeConceptIds && new Set(batch.completeConceptIds);
  if (complete) for (const concept of concepts) if (!complete.has(concept)) blocked.add(concept);
  else if ((batch.slice.omissions ?? []).some(({ ref }) =>
      !batch.slice.events.some(event => eventKey(event.ref, event.rev) === eventKey(ref.id, ref.rev) && event.concept_ids.length)))
    for (const concept of concepts) blocked.add(concept);

  const cutoff = evidenceTime(scope.asOf);
  const omitted = new Set((batch.slice.omissions ?? []).map(({ ref }) => eventKey(ref.id, ref.rev)));
  for (const event of batch.slice.events) {
    if (!(evidenceTime(event.occurred_at) <= cutoff)) continue;
    for (const concept of event.concept_ids)
      if (concepts.has(concept) && (omitted.has(eventKey(event.ref, event.rev)) ||
          (event.help_level === 'independent' && event.outcome === 'unknown'))) blocked.add(concept);
  }
  return blocked;
}

function conceptBucket(batch: TextbookMasteryEvidenceBatch, scope: TextbookMasteryScope, conceptId: string) {
  const cutoff = evidenceTime(scope.asOf);
  const omitted = new Set((batch.slice.omissions ?? []).map(({ ref }) => eventKey(ref.id, ref.rev)));
  const anchors = new Map<string, TextbookMasteryEvidenceAnchor | null>();
  for (const anchor of batch.anchors) {
    const key = eventKey(anchor.submission.id, anchor.submission.rev);
    anchors.set(key, anchors.has(key) || !anchorUsable(anchor, scope) ? null : anchor);
  }
  const seen = new Map<string, EvidenceEventV1>();
  for (const event of batch.slice.events) {
    const key = eventKey(event.ref, event.rev);
    const prior = seen.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) anchors.set(key, null);
    else seen.set(key, event);
  }
  let bucket: Bucket | null = null;
  for (const event of batch.slice.events) {
    const key = eventKey(event.ref, event.rev);
    if (!(evidenceTime(event.occurred_at) <= cutoff) || omitted.has(key) || event.help_level !== 'independent' ||
        event.outcome === 'unknown' || event.exam_pacing || event.exam_pacing_item || !event.concept_ids.includes(conceptId))
      continue;
    const anchor = anchors.get(key);
    if (!anchor) return null;
    const dimensions = bucketKey(event.item_novelty, event.representation, event.context, event.method);
    if (!bucket) bucket = { dimensions, attempts: new Map() };
    if (bucket.dimensions !== dimensions ||
        (bucket.attempts.has(event.ref) && JSON.stringify(bucket.attempts.get(event.ref)!.event) !== JSON.stringify(event)))
      return null;
    bucket.attempts.set(event.ref, { event: event as ScoredEvent, anchor });
  }
  return bucket;
}

function rowVerified(row: CognitionOutput['state_vector'][number] | undefined, bucket: Bucket | null) {
  if (!row || !bucket || row.state !== 'known' || row.uncertainty.kind !== 'interval' ||
      bucketKey(row.item_novelty, row.representation, row.context, row.method) !== bucket.dimensions ||
      row.evidence_refs.length !== bucket.attempts.size || new Set(row.evidence_refs.map(ref => ref.ref)).size !== bucket.attempts.size)
    return false;
  const refs = new Map(row.evidence_refs.map(ref => [ref.ref, ref.rev]));
  return [...bucket.attempts].every(([ref, { event }]) => refs.get(ref) === event.rev);
}

/** Batch-decorates knowledge graph concept nodes with authorized read-time mastery. */
export async function projectGraphConceptMastery(
  request: GraphConceptMasteryRequest,
  sources: GraphConceptMasterySources,
): Promise<GraphConceptMasteryView> {
  const { concepts: input, ...scope } = request;
  const nodes = new Map<string, BusWitness[]>();
  for (const node of input) {
    if (typeof node.conceptId !== 'string' || !node.conceptId.trim() || node.conceptId.includes('\0')) continue;
    const witnesses = [node.witness, ...(node.basis ?? []), ...(node.proof ?? [])].filter(Boolean) as BusWitness[];
    if (witnesses.length) nodes.set(node.conceptId, [...(nodes.get(node.conceptId) ?? []), ...witnesses]);
    else if (!nodes.has(node.conceptId)) nodes.set(node.conceptId, []);
  }
  const ids = [...nodes.keys()];
  const empty = { asOf: scope.asOf, concepts: ids.map(emptyNode) };
  if (!ids.length || !scope.purpose.trim() || !scope.recipientId.trim() ||
      !Number.isFinite(evidenceTime(scope.asOf)) || !decimalTick.test(scope.clockWatermark)) return empty;

  const localNodes = new Map([...nodes].map(([conceptId, witnesses]) =>
    [conceptId, witnesses.every(ref => localWitness(ref, scope)) ? witnesses : null] as const));
  const validIds = ids.filter(conceptId => localNodes.get(conceptId) !== null);
  if (!validIds.length) return empty;
  const validSet = new Set(validIds);
  const displayWitnesses = validIds.flatMap(conceptId => localNodes.get(conceptId) ?? []);
  const batches = new Map<string, TextbookMasteryEvidenceBatch | null>();
  const results = new Map<string, CognitionOutput | null>();
  const pipeline: TextbookMasterySources = {
    ...sources,
    readEvidence: async (readScope, conceptIds) => {
      const batch = await sources.readEvidence(readScope, conceptIds);
      for (const conceptId of conceptIds) if (!batches.has(conceptId)) batches.set(conceptId, batch);
      return batch;
    },
    derive: async (deriveScope, method, slice, witnesses) => {
      const result = await sources.derive(deriveScope, method, slice, witnesses);
      for (const event of slice.events) for (const conceptId of event.concept_ids)
        if (!results.has(conceptId)) results.set(conceptId, result);
      return result;
    },
  };
  const read = await readConceptMastery(scope, validSet, displayWitnesses, pipeline);
  const blockedByBatch = new Map<TextbookMasteryEvidenceBatch, ReadonlySet<string>>();
  const isBlocked = (batch: TextbookMasteryEvidenceBatch, conceptId: string) => {
    let blocked = blockedByBatch.get(batch);
    if (!blocked) {
      blocked = blockedConcepts(batch, scope, validSet);
      blockedByBatch.set(batch, blocked);
    }
    return blocked.has(conceptId);
  };
  return { asOf: scope.asOf, concepts: ids.map(conceptId => {
    const witnesses = localNodes.get(conceptId);
    const batch = batches.get(conceptId) ?? null;
    if (!witnesses?.every(read.allowed) || !batch) return emptyNode(conceptId);
    const projection = read.concept(conceptId);
    if (projection.state === 'unknown' || isBlocked(batch, conceptId)) return emptyNode(conceptId);
    const bucket = conceptBucket(batch, scope, conceptId);
    const rows = results.get(conceptId)?.state_vector.filter(row => row.concept_id === conceptId) ?? [];
    const row = rows.length === 1 ? rows[0] : undefined;
    const allowedAttempts = bucket && [...bucket.attempts.values()].every(({ anchor }) =>
      [anchor.submission, anchor.question, ...anchor.basis].every(read.allowed));
    if (!bucket || !allowedAttempts || !rowVerified(row, bucket) ||
        !(row!.r_now !== undefined && row!.r_now >= 0 && row!.r_now <= 1)) return emptyNode(conceptId);
    const attempts = [...bucket.attempts.values()].sort((left, right) =>
      evidenceTime(right.event.occurred_at) - evidenceTime(left.event.occurred_at) ||
      left.event.ref.localeCompare(right.event.ref));
    return {
      conceptId, status: statusByState[projection.state], retrievability: row!.r_now!,
      independentAttempts: attempts.length,
      lastEvidenceAt: attempts[0]?.event.occurred_at ?? null,
      recentEvidenceRefs: attempts.slice(0, 3).map(({ event, anchor }) => ({
        id: anchor.submission.id, rev: anchor.submission.rev, occurredAt: event.occurred_at,
        itemId: anchor.itemId, href: anchor.href,
      })),
    };
  }) };
}
