import type { FactId } from '@mangekyo/kernel';
import { compareText } from './content-guard.ts';
import type { KnowledgeEdge } from './knowledge-edge.ts';

export type VariantPoolEdge = { readonly id: FactId; readonly edge: KnowledgeEdge };
export type VariantPoolRelation = 'single_condition' | 'representation_transfer' | 'numbers_only';
export type VariantPoolCandidate = {
  readonly questionId: FactId; readonly edgeId: FactId; readonly relation: VariantPoolRelation; readonly familyId: string;
  readonly hop: 1 | 2;
};

const relationPriority: readonly VariantPoolRelation[] = ['single_condition', 'representation_transfer', 'numbers_only'];

function eligibleRelation(edge: KnowledgeEdge): VariantPoolRelation | undefined {
  return relationPriority.find(relation => relation === edge.variant?.relation);
}

function wholeVariantEdge(entry: VariantPoolEdge) {
  const { edge } = entry;
  return edge.kind === 'variant_of' && edge.variant !== undefined &&
    edge.from.kind === 'question' && edge.to.kind === 'question' &&
    edge.from.blockId === undefined && edge.to.blockId === undefined;
}

function endpointsTouching(edge: KnowledgeEdge, questionId: FactId): { other: FactId; sourceIsFrom: boolean } | undefined {
  if (edge.from.sourceUse.id === questionId) return { other: edge.to.sourceUse.id, sourceIsFrom: true };
  if (edge.to.sourceUse.id === questionId) return { other: edge.from.sourceUse.id, sourceIsFrom: false };
  return undefined;
}

function safeFromSource(edge: KnowledgeEdge, sourceQuestionId: FactId) {
  const touching = endpointsTouching(edge, sourceQuestionId);
  if (!touching) return false;
  const spoilsNext = edge.variant?.spoilsNext;
  return spoilsNext === 'none' || spoilsNext === (touching.sourceIsFrom ? 'former' : 'latter');
}

function priority(left: VariantPoolCandidate, right: VariantPoolCandidate) {
  return left.hop - right.hop || relationPriority.indexOf(left.relation) - relationPriority.indexOf(right.relation) ||
    compareText(left.questionId, right.questionId) || compareText(left.edgeId, right.edgeId);
}

/** Explicit same-source, translation, or directional spoiler edges blacklist the far question regardless of other edges. */
function spoiledBySource(edges: readonly VariantPoolEdge[], sourceQuestionId: FactId): ReadonlySet<FactId> {
  const spoiled = new Set<FactId>();
  for (const entry of edges) {
    if (!wholeVariantEdge(entry)) continue;
    const touching = endpointsTouching(entry.edge, sourceQuestionId);
    if (!touching) continue;
    const { relation, spoilsNext } = entry.edge.variant!;
    if (relation === 'same_source' || relation === 'translation' ||
        (touching.sourceIsFrom && spoilsNext === 'latter') || (!touching.sourceIsFrom && spoilsNext === 'former')) {
      spoiled.add(touching.other);
    }
  }
  return spoiled;
}

/** Pure selection over an authorized edge snapshot; the host owns exposure evidence and authorization. */
export async function findUnexposedVariantInPool(input: {
  readonly sourceQuestionId: FactId; readonly edges: readonly VariantPoolEdge[];
  readonly isExposed: (questionId: FactId) => Promise<boolean> | boolean; readonly excludeIds?: ReadonlySet<string>;
}): Promise<VariantPoolCandidate | undefined> {
  const excluded = input.excludeIds ?? new Set<string>();
  const spoiled = spoiledBySource(input.edges, input.sourceQuestionId);
  const candidates = new Map<FactId, VariantPoolCandidate>();
  const familyIds = new Set<string>();
  const add = (candidate: VariantPoolCandidate) => {
    if (candidate.questionId === input.sourceQuestionId || excluded.has(candidate.questionId) ||
        spoiled.has(candidate.questionId)) return;
    const previous = candidates.get(candidate.questionId);
    if (!previous || priority(candidate, previous) < 0) candidates.set(candidate.questionId, candidate);
  };

  const wholeEdges = input.edges.filter(wholeVariantEdge);
  for (const entry of wholeEdges) {
    const relation = eligibleRelation(entry.edge);
    const touching = endpointsTouching(entry.edge, input.sourceQuestionId);
    if (!relation || !touching || !safeFromSource(entry.edge, input.sourceQuestionId)) continue;
    familyIds.add(entry.edge.variant!.familyId);
    add({ questionId: touching.other, edgeId: entry.id, relation, familyId: entry.edge.variant!.familyId, hop: 1 });
  }
  for (const entry of wholeEdges) {
    const relation = eligibleRelation(entry.edge);
    const variant = entry.edge.variant!;
    if (!relation || !familyIds.has(variant.familyId) || variant.spoilsNext !== 'none') continue;
    // Hop-2 expansion never passes through an explicitly spoiled endpoint.
    if (spoiled.has(entry.edge.from.sourceUse.id) || spoiled.has(entry.edge.to.sourceUse.id)) continue;
    for (const questionId of [entry.edge.from.sourceUse.id, entry.edge.to.sourceUse.id])
      add({ questionId, edgeId: entry.id, relation, familyId: variant.familyId, hop: 2 });
  }

  for (const candidate of [...candidates.values()].sort(priority))
    if (!await input.isExposed(candidate.questionId)) return candidate;
  return undefined;
}
