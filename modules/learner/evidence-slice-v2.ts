/**
 * CanonicalEvidenceSliceV2 construction and zero-drift V1/V2 adaptation
 * (Wave A P0-3/F37). All assembly is deterministic: identical inputs produce
 * byte-identical slices, and the Python `cognition@3` deriver must produce
 * byte-identical results for adapted V1 views of equivalent V2 evidence.
 */
import type {
  CanonicalEvidenceSliceV1, CanonicalEvidenceSliceV2, ConceptGraphEdgeV2, ConceptGraphNodeV2,
  CriterionKcLinkV2, CriterionObservationV2, EvidenceCandidateV2, EvidenceEventV1, EvidenceEventV2,
  EvidenceFactRefV2,
} from '@mangekyo/kernel';
import type { AssessmentCriterion } from '@mangekyo/module-content/facts/assessment';
import { eventAttributedKcIds, parseEventRefKey, type SliceOmission } from './evidence-refs.ts';

export type { SliceOmission } from './evidence-refs.ts';

export type EvidenceSliceAuthorizationV2 = CanonicalEvidenceSliceV2['authorization'];

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Map an assessment rubric criterion plus its settled item observation onto the V2 wire. */
export function criterionObservationV2(
  criterion: AssessmentCriterion,
  observation: {
    readonly outcome: CriterionObservationV2['outcome'];
    readonly earned?: number | null;
    readonly scoreNorm?: number;
    readonly errorStage?: CriterionObservationV2['error_stage'];
  },
): CriterionObservationV2 {
  const kcLinks: CriterionKcLinkV2[] = (criterion.kcLinks ?? [])
    .filter(link => link.kcId && Number.isFinite(link.weight))
    .map(link => ({ kc_id: link.kcId, weight: link.weight, role: link.role, source: link.source }))
    .sort((left, right) => compareText(left.kc_id, right.kc_id));
  return {
    criterion_id: criterion.criterionId,
    input_refs: criterion.inputs.map(input => ({ slot_id: input.slotId, path: input.path })),
    earned: observation.earned ?? null,
    maximum: criterion.maximum,
    outcome: observation.outcome,
    ...(observation.scoreNorm !== undefined ? { score_norm: observation.scoreNorm } : {}),
    ...(criterion.interaction ? { interaction: criterion.interaction } : {}),
    kc_links: kcLinks,
    evaluator: criterion.evaluator,
    ...(observation.errorStage ? { error_stage: observation.errorStage } : {}),
  };
}

/** The fact reference an event observes: explicit V2 coordinates or the parsed composite key. */
export function eventFactRef(event: { readonly ref: string; readonly rev: number; readonly fact_ref?: EvidenceFactRefV2 }): EvidenceFactRefV2 {
  if (event.fact_ref) return event.fact_ref;
  return { id: parseEventRefKey(event.ref).baseId, rev: event.rev };
}

export function eventAttributionStatus(event: {
  readonly concept_ids: readonly string[];
  readonly criteria?: readonly CriterionObservationV2[];
}): EvidenceEventV2['attribution_status'] {
  if (eventAttributedKcIds(event) !== null) return 'criterion';
  if (event.concept_ids.length === 1) return 'single_kc_fallback';
  if (event.concept_ids.length > 1) return 'question_fallback';
  return 'unknown';
}

export type CanonicalEvidenceSliceV2Input = Omit<CanonicalEvidenceSliceV2, 'schema_version'>;

function compareEventTime(left: EvidenceEventV2, right: EvidenceEventV2): number {
  return compareText(left.occurred_at, right.occurred_at) || compareText(left.ref, right.ref) ||
    compareText(JSON.stringify(left), JSON.stringify(right));
}

function normalizeEvent(event: EvidenceEventV2): EvidenceEventV2 {
  const factRef = eventFactRef(event);
  const status = event.attribution_status ?? eventAttributionStatus(event);
  return { ...event, fact_ref: factRef, attribution_status: status };
}

function normalizeNode(node: ConceptGraphNodeV2): ConceptGraphNodeV2 {
  return { ...node };
}

function compareEdges(left: ConceptGraphEdgeV2, right: ConceptGraphEdgeV2): number {
  return compareText(left.from_kc_id, right.from_kc_id) || compareText(left.to_kc_id, right.to_kc_id) ||
    compareText(left.kind, right.kind);
}

/**
 * Assemble a deterministic `CanonicalEvidenceSliceV2`. Event fact references
 * and attribution statuses are completed when producers leave them implicit;
 * concept-graph nodes and edges are deduplicated and canonically ordered.
 */
export function buildCanonicalEvidenceSliceV2(input: CanonicalEvidenceSliceV2Input): CanonicalEvidenceSliceV2 {
  const events = input.events.map(normalizeEvent).sort(compareEventTime);
  let conceptGraph: CanonicalEvidenceSliceV2['concept_graph'];
  if (input.concept_graph) {
    const nodesById = new Map<string, ConceptGraphNodeV2>();
    for (const node of input.concept_graph.nodes) {
      if (!nodesById.has(node.kc_id)) nodesById.set(node.kc_id, normalizeNode(node));
    }
    const edgeKeys = new Set<string>();
    const edges: ConceptGraphEdgeV2[] = [];
    for (const edge of [...input.concept_graph.edges].sort(compareEdges)) {
      const key = JSON.stringify([edge.from_kc_id, edge.to_kc_id, edge.kind]);
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(edge);
    }
    const nodes = [...nodesById.values()].sort((left, right) => compareText(left.kc_id, right.kc_id));
    conceptGraph = { nodes, edges };
  }
  return {
    schema_version: 'v2',
    clock_watermark: input.clock_watermark,
    as_of_at: input.as_of_at,
    authorization: input.authorization,
    ...(conceptGraph ? { concept_graph: conceptGraph } : {}),
    events,
    ...(input.omissions?.length ? { omissions: input.omissions } : {}),
    constraints: input.constraints,
    candidate_pool: input.candidate_pool,
  };
}

/** Strip V2-only fields while keeping the canonical fact/item identity the
 * Python deriver uses for omission shielding and item pairing. */
function adaptEventV2ToV1(event: EvidenceEventV2): EvidenceEventV1 {
  const clone: Record<string, unknown> = { ...event };
  delete clone.attribution_status;
  delete clone.item_model;
  return clone as unknown as EvidenceEventV1;
}

function adaptCandidateV2ToV1(candidate: EvidenceCandidateV2): CanonicalEvidenceSliceV1['candidate_pool'][number] {
  const clone: Record<string, unknown> = { ...candidate };
  delete clone.item_model;
  return clone as unknown as CanonicalEvidenceSliceV1['candidate_pool'][number];
}

/** F37 adapter: reduce a V2 slice to the V1-shaped payload cognition@3 consumes. */
export function adaptV2SliceToV1(slice: CanonicalEvidenceSliceV2): CanonicalEvidenceSliceV1 {
  const omissions = slice.omissions as readonly SliceOmission[] | undefined;
  return {
    clock_watermark: slice.clock_watermark,
    as_of_at: slice.as_of_at,
    events: slice.events.map(adaptEventV2ToV1),
    ...(omissions?.length ? { omissions: omissions as unknown as NonNullable<CanonicalEvidenceSliceV1['omissions']> } : {}),
    constraints: slice.constraints,
    candidate_pool: slice.candidate_pool.map(adaptCandidateV2ToV1),
  };
}

function liftEventV1ToV2(event: EvidenceEventV1): EvidenceEventV2 {
  const clone = { ...(event as EvidenceEventV1 & {
    readonly fact_ref?: EvidenceFactRefV2;
    readonly item_id?: string;
    readonly criteria?: readonly CriterionObservationV2[];
    readonly attribution_status?: EvidenceEventV2['attribution_status'];
  }) };
  const factRef = eventFactRef(clone);
  const status = clone.attribution_status ?? eventAttributionStatus(clone);
  return { ...clone, fact_ref: factRef, attribution_status: status } as EvidenceEventV2;
}

/** Lift a legacy V1 slice into V2 without inventing criteria: attribution
 * statuses stay at their single/question fallback, which cognition@3 reads
 * identically to the legacy path. */
export function adaptV1SliceToV2(
  slice: CanonicalEvidenceSliceV1,
  authorization: EvidenceSliceAuthorizationV2,
): CanonicalEvidenceSliceV2 {
  return buildCanonicalEvidenceSliceV2({
    clock_watermark: slice.clock_watermark,
    as_of_at: slice.as_of_at,
    authorization,
    events: slice.events.map(liftEventV1ToV2),
    ...(slice.omissions?.length ? { omissions: slice.omissions as readonly SliceOmission[] } : {}),
    constraints: slice.constraints,
    candidate_pool: slice.candidate_pool,
  });
}
