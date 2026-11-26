import type { FactId, FactSnapshot } from '@mangekyo/kernel';
import { parseAsset } from './asset.ts';
import { parseKnowledgeEdge } from './knowledge-edge.ts';
import type { ArchetypeClusterArchetypeInput, ArchetypeClusterEdgeInput, ArchetypeClusterQuestionInput } from './archetype-folding.ts';

/** Fold inputs from an authorized fact snapshot map: same visibility boundary as the caller's question list. */
export function foldingInputsFromSnapshots(snapshots: ReadonlyMap<string, FactSnapshot>): {
  readonly questions: readonly ArchetypeClusterQuestionInput[];
  readonly archetypes: readonly ArchetypeClusterArchetypeInput[];
  readonly edges: readonly ArchetypeClusterEdgeInput[];
} {
  const questions: ArchetypeClusterQuestionInput[] = [];
  const archetypes: ArchetypeClusterArchetypeInput[] = [];
  const edges: ArchetypeClusterEdgeInput[] = [];
  for (const snapshot of snapshots.values()) {
    if (snapshot.type === 'content.asset') {
      try {
        const asset = parseAsset(snapshot.value);
        if (asset.kind === 'question')
          questions.push({ id: snapshot.ref.id as FactId, title: asset.title, purpose: snapshot.purpose });
        else if (asset.kind === 'archetype')
          archetypes.push({ id: snapshot.ref.id as FactId, title: asset.title, purpose: snapshot.purpose });
      } catch { continue; }
    } else if (snapshot.type === 'content.knowledgeEdge') {
      try {
        const edge = parseKnowledgeEdge(snapshot.value);
        // 'canonical_archetype' does not exist in today's edge vocabulary but stays wired for forward compatibility.
        const kind = edge.kind as string;
        if (!['instance_of', 'canonical_archetype', 'variant_of', 'targets_concept'].includes(kind)) continue;
        edges.push({
          id: snapshot.ref.id as FactId, kind: kind as ArchetypeClusterEdgeInput['kind'],
          fromId: edge.from.sourceUse.id as FactId, toId: edge.to.sourceUse.id as FactId,
          ...(edge.variant?.changed !== undefined ? { changed: edge.variant.changed } : {}),
          ...(edge.variant?.familyId !== undefined ? { familyId: edge.variant.familyId } : {}),
        });
      } catch { continue; }
    }
  }
  return { questions, archetypes, edges };
}
