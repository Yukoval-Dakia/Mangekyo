import type { FactId, FactSnapshot, Revision } from '@mangekyo/kernel';
import { assetType, parseAsset, questionPrompt } from './asset.ts';
import { knowledgeEdgeType, parseKnowledgeEdge } from './knowledge-edge.ts';
import { findUnexposedVariantInPool, type VariantPoolCandidate, type VariantPoolEdge } from './variant-pool.ts';
export type { VariantPoolCandidate } from './variant-pool.ts';

/** Collect authorized variant-pool edges from a snapshot map. */
export function snapVariantEdges(snapshots: ReadonlyMap<string, FactSnapshot>): readonly VariantPoolEdge[] {
  const edges: VariantPoolEdge[] = [];
  for (const snapshot of snapshots.values()) {
    if (snapshot.type !== knowledgeEdgeType) continue;
    try { edges.push({ id: snapshot.ref.id as FactId, edge: parseKnowledgeEdge(snapshot.value) }); } catch { continue; }
  }
  return edges;
}

/** One exposure-bounded pool lookup. `isPoolQuestion` must confirm release readiness inside the same boundary. */
export async function findPoolVariant(input: {
  readonly sourceQuestionId: FactId;
  readonly snapshots: ReadonlyMap<string, FactSnapshot>;
  readonly exposed: ReadonlySet<string>;
  readonly isPoolQuestion: (questionId: FactId) => Promise<boolean>;
}): Promise<VariantPoolCandidate | undefined> {
  if (!input.snapshots.has(input.sourceQuestionId)) return undefined;
  return findUnexposedVariantInPool({
    sourceQuestionId: input.sourceQuestionId,
    edges: snapVariantEdges(input.snapshots),
    isExposed: async id => input.exposed.has(id) || !(await input.isPoolQuestion(id as FactId)),
  });
}

/** Confirm the candidate still parses as a question with a non-empty prompt inside the authorized boundary. */
export function poolCandidatePrompt(snapshots: ReadonlyMap<string, FactSnapshot>, questionId: string): {
  readonly id: FactId; readonly rev: Revision; readonly prompt: string;
} | undefined {
  const snapshot = snapshots.get(questionId);
  if (snapshot?.type !== assetType) return undefined;
  try {
    const asset = parseAsset(snapshot.value);
    if (asset.kind !== 'question') return undefined;
    const prompt = questionPrompt(asset).trim();
    return prompt ? { id: snapshot.ref.id as FactId, rev: snapshot.ref.rev, prompt } : undefined;
  } catch { return undefined; }
}

/** Honest fallbacks for the 0-LLM near-miss verification response bodies. */
export const nearMissPoolHit = (hit: { questionId: string }, paperId: string, errorStage: string | undefined) => ({
  source: 'variant_pool' as const, questionId: hit.questionId, paperId,
  paperHref: `/papers/${encodeURIComponent(paperId)}`,
  ...(errorStage !== undefined ? { errorStage } : {}),
});

export const nearMissPoolEmpty = (sourceQuestionId: string | undefined, errorStage: string | undefined) => ({
  source: 'pool_empty' as const,
  ...(errorStage !== undefined ? { errorStage } : {}),
  fallback: {
    action: 'author_mistake_variant' as const,
    ...(sourceQuestionId !== undefined ? { sourceQuestionId } : {}),
    scheduledFollowupHours: 24,
  },
});
