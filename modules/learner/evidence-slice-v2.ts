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
import { eventAttributedKcIds, eventSourceKey, parseEventRefKey, type SliceOmission } from './evidence-refs.ts';

export { eventAttributedKcIds, eventKcOutcome, type SliceOmission } from './evidence-refs.ts';

export type EvidenceSliceAuthorizationV2 = CanonicalEvidenceSliceV2['authorization'];

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const validErrorStages = new Set(['reading', 'modeling', 'strategy', 'execution', 'expression']);

export type FormalCriterionOutcomeLike = {
  readonly criterionId: string;
  readonly state?: string;
  readonly outcome?: string;
  readonly earned?: number | null;
  readonly maximum?: number | null;
  readonly errorStage?: string;
  readonly evaluator?: { readonly id: string; readonly version: string };
  readonly inputs?: readonly { readonly slotId: string; readonly path: string }[];
  readonly kcLinks?: readonly {
    readonly kcId: string;
    readonly weight: number;
    readonly role: CriterionKcLinkV2['role'];
    readonly source: CriterionKcLinkV2['source'];
  }[];
  readonly interaction?: CriterionObservationV2['interaction'];
};

export type FormalItemAssessmentProjection = {
  readonly criteria: readonly CriterionObservationV2[];
  readonly outcome: 'correct' | 'incorrect' | 'partial' | 'unknown';
  readonly scoreNorm: number | null;
  readonly errorStage?: NonNullable<CriterionObservationV2['error_stage']>;
};

/**
 * Project settled formal-assessment criterion outcomes paired with their
 * frozen `AssessmentRelease` criteria into canonical V2 criterion observations
 * plus item-level outcome, score proportion and error stage.
 */
export type FormalReleaseCriterionLike = {
  readonly criterionId: string;
  readonly maximum: number | null;
  readonly inputs: readonly { readonly slotId: string; readonly path: string }[];
  readonly evaluator: { readonly id: string; readonly version: string };
  readonly kcLinks?: readonly {
    readonly kcId: string;
    readonly weight: number;
    readonly role: CriterionKcLinkV2['role'];
    readonly source: CriterionKcLinkV2['source'];
  }[];
  readonly interaction?: CriterionObservationV2['interaction'];
};

export function formalItemCriteriaV2(
  outcomes: readonly FormalCriterionOutcomeLike[],
  releaseCriteria?: readonly FormalReleaseCriterionLike[],
): FormalItemAssessmentProjection {
  const byId = new Map((releaseCriteria ?? []).map(criterion => [criterion.criterionId, criterion]));
  const criteria: CriterionObservationV2[] = [];
  const scoredIds = new Set<string>();
  let totalEarned = 0;
  let totalMaximum = 0;
  let hasIncompleteOutcome = false;
  const stages = new Set<NonNullable<CriterionObservationV2['error_stage']>>();
  for (const entry of outcomes) {
    if (!entry.criterionId) continue;
    const rel = byId.get(entry.criterionId);
    const maxRaw = rel?.maximum ?? entry.maximum ?? null;
    const maximum = typeof maxRaw === 'number' && Number.isFinite(maxRaw) ? maxRaw : null;
    const earned = typeof entry.earned === 'number' && Number.isFinite(entry.earned) ? entry.earned : null;
    const state = entry.state ?? entry.outcome;
    let critOutcome: CriterionObservationV2['outcome'] = 'unknown';
    let scoreNorm: number | undefined;
    if (state === 'scored' && maximum !== null && maximum > 0 && earned !== null) {
      scoreNorm = Math.min(1, Math.max(0, earned / maximum));
      critOutcome = earned >= maximum ? 'correct' : earned > 0 ? 'partial' : 'incorrect';
      totalEarned += Math.min(maximum, Math.max(0, earned));
      totalMaximum += maximum;
      scoredIds.add(entry.criterionId);
    } else if (state === 'correct' || state === 'incorrect') {
      critOutcome = state;
    } else if (state !== 'qualitative') {
      // Unsettled assessment states (including evaluation-state `partial`,
      // `pending`, `unsubmitted`, `blocked`, `failed`) have no settled score.
      hasIncompleteOutcome = true;
    }
    const rawLinks = rel?.kcLinks ?? entry.kcLinks ?? [];
    const kcLinks: CriterionKcLinkV2[] = rawLinks
      .filter(link => link.kcId && Number.isFinite(link.weight) && link.weight >= 0 && link.weight <= 1)
      .map(link => ({ kc_id: link.kcId, weight: link.weight, role: link.role, source: link.source }))
      .sort((left, right) => compareText(left.kc_id, right.kc_id));
    const inputRefs = (rel?.inputs ?? entry.inputs ?? []).map(input => ({ slot_id: input.slotId, path: input.path }));
    const evaluator = rel?.evaluator ?? entry.evaluator ?? { id: 'workbook-formal-assessment', version: '1' };
    const interaction = rel?.interaction ?? entry.interaction;
    const stage = (critOutcome === 'incorrect' || critOutcome === 'partial') &&
      entry.errorStage && validErrorStages.has(entry.errorStage)
      ? entry.errorStage as NonNullable<CriterionObservationV2['error_stage']>
      : undefined;
    if (stage) stages.add(stage);
    criteria.push({
      criterion_id: entry.criterionId,
      input_refs: inputRefs,
      earned,
      maximum,
      outcome: critOutcome,
      ...(scoreNorm !== undefined ? { score_norm: scoreNorm } : {}),
      ...(interaction === 'conjunctive' || interaction === 'compensatory' ? { interaction } : {}),
      kc_links: kcLinks,
      evaluator,
      ...(stage ? { error_stage: stage } : {}),
    });
  }
  const expectedScored = (releaseCriteria ?? []).filter(criterion => criterion.maximum !== null && criterion.maximum > 0);
  const allScoredComplete = !hasIncompleteOutcome && totalMaximum > 0 && (
    releaseCriteria?.length
      ? expectedScored.length > 0 && expectedScored.every(criterion => scoredIds.has(criterion.criterionId))
      : scoredIds.size > 0
  );
  let outcome: FormalItemAssessmentProjection['outcome'] = 'unknown';
  let scoreNorm: number | null = null;
  if (allScoredComplete) {
    scoreNorm = Math.min(1, Math.max(0, totalEarned / totalMaximum));
    outcome = totalEarned >= totalMaximum ? 'correct' : totalEarned > 0 ? 'partial' : 'incorrect';
  } else if (!hasIncompleteOutcome && !expectedScored.length) {
    if (criteria.some(c => c.outcome === 'incorrect')) outcome = 'incorrect';
    else if (criteria.some(c => c.outcome === 'correct')) outcome = 'correct';
  }
  const errorStage = (outcome === 'incorrect' || outcome === 'partial') && stages.size === 1
    ? [...stages][0]
    : undefined;
  return { criteria, outcome, scoreNorm, ...(errorStage ? { errorStage } : {}) };
}

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
  const lt = Date.parse(left.occurred_at);
  const rt = Date.parse(right.occurred_at);
  if (Number.isFinite(lt) && Number.isFinite(rt) && lt !== rt) return lt - rt;
  return compareText(left.occurred_at, right.occurred_at) ||
    compareText(eventSourceKey(left), eventSourceKey(right)) ||
    compareText(left.ref, right.ref) ||
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
