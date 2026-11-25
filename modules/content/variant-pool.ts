import type { FactId } from '@mangekyo/kernel';
import type { KnowledgeEdge } from './knowledge-edge.ts';

export type VariantPoolEdge = { readonly id: FactId; readonly edge: KnowledgeEdge };
export type VariantPoolRelation = 'single_condition' | 'representation_transfer' | 'numbers_only';
export type VariantPoolCandidate = {
  readonly questionId: FactId;
  readonly edgeId: FactId;
  readonly relation: VariantPoolRelation;
  readonly familyId: string;
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

function safeFromSource(edge: KnowledgeEdge, sourceQuestionId: FactId) {
  const spoilsNext = edge.variant?.spoilsNext;
  if (edge.from.sourceUse.id === sourceQuestionId) return spoilsNext === 'none' || spoilsNext === 'former';
  if (edge.to.sourceUse.id === sourceQuestionId) return spoilsNext === 'none' || spoilsNext === 'latter';
  return false;
}

function otherQuestion(edge: KnowledgeEdge, questionId: FactId): FactId | undefined {
  if (edge.from.sourceUse.id === questionId) return edge.to.sourceUse.id;
  if (edge.to.sourceUse.id === questionId) return edge.from.sourceUse.id;
  return undefined;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function priority(left: VariantPoolCandidate, right: VariantPoolCandidate) {
  return relationPriority.indexOf(left.relation) - relationPriority.indexOf(right.relation) ||
    left.hop - right.hop || compareText(left.questionId, right.questionId) || compareText(left.edgeId, right.edgeId);
}

/** Pure selection over an authorized edge snapshot; the host owns exposure evidence and authorization. */
export async function findUnexposedVariantInPool(input: {
  readonly sourceQuestionId: FactId;
  readonly edges: readonly VariantPoolEdge[];
  readonly isExposed: (questionId: FactId) => Promise<boolean> | boolean;
  readonly excludeIds?: ReadonlySet<string>;
}): Promise<VariantPoolCandidate | undefined> {
  const excluded = input.excludeIds ?? new Set<string>();
  const candidates = new Map<FactId, VariantPoolCandidate>();
  const familyIds = new Set<string>();
  const add = (candidate: VariantPoolCandidate): undefined => {
    if (candidate.questionId === input.sourceQuestionId || excluded.has(candidate.questionId)) return undefined;
    const previous = candidates.get(candidate.questionId);
    if (!previous || priority(candidate, previous) < 0) candidates.set(candidate.questionId, candidate);
    return undefined;
  };

  for (const entry of input.edges) {
    if (!wholeVariantEdge(entry)) continue;
    const relation = eligibleRelation(entry.edge);
    if (!relation || !safeFromSource(entry.edge, input.sourceQuestionId)) continue;
    const questionId = otherQuestion(entry.edge, input.sourceQuestionId);
    if (questionId === undefined) continue;
    familyIds.add(entry.edge.variant!.familyId);
    add({ questionId, edgeId: entry.id, relation, familyId: entry.edge.variant!.familyId, hop: 1 });
  }
  for (const entry of input.edges) {
    if (!wholeVariantEdge(entry)) continue;
    const relation = eligibleRelation(entry.edge);
    const variant = entry.edge.variant!;
    if (!relation || !familyIds.has(variant.familyId) || variant.spoilsNext !== 'none') continue;
    for (const questionId of [entry.edge.from.sourceUse.id, entry.edge.to.sourceUse.id])
      add({ questionId, edgeId: entry.id, relation, familyId: variant.familyId, hop: 2 });
  }

  for (const candidate of [...candidates.values()].sort(priority))
    if (!await input.isExposed(candidate.questionId)) return candidate;
  return undefined;
}
