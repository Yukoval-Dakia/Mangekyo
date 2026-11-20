import { FactNotFoundError, type FactId, type FactRef, type FactSnapshot, type ReadContext } from '@mangekyo/kernel';
import { AssetBasisError, assetType, type AssetReadContext } from './asset.ts';
import {
  canUseDistinguishingVariant, KnowledgeEdgeBasisError, knowledgeEndpointKind, knowledgeUseKey, walkKnowledgeEdges,
  type KnowledgeEndpoint,
} from './knowledge-edge.ts';
import { openQuestionForRelease } from './question-release.ts';

type QuestionRef = Pick<FactRef, 'id' | 'rev'>;

export type CorrectionMicroVariantAccess = {
  readonly learner: FactRef['learner'];
  readonly purpose: string;
  readonly recipient: string;
  readonly releaseUses: readonly string[];
  /** Authorize and track fact and current slot witnesses for this purpose and recipient.
   * Use the same snapshot for the exposure read. */
  readonly read: Pick<ReadContext, 'fact' | 'slot'>;
  /** Use the Activity exposure reader. Return unexposed only with complete coverage for the
   * candidate identity across revisions and any earlier exposure that could spoil it. */
  readonly readExposure: (query: {
    readonly candidate: FactRef;
    readonly archetype: FactRef;
    readonly familyId: string;
  }) => Promise<{ readonly kind: 'unexposed' | 'exposed' | 'unknown' }>;
  readonly isUnavailable: (error: unknown) => boolean;
};

function matchesQuestion(endpoint: KnowledgeEndpoint, question: KnowledgeEndpoint) {
  return endpoint.kind === 'question' && endpoint.blockId === undefined &&
    knowledgeUseKey(endpoint.sourceUse) === knowledgeUseKey(question.sourceUse);
}

async function readArchetype(
  ctx: AssetReadContext, root: KnowledgeEndpoint, edgeIds: readonly FactId[], unavailable: (error: unknown) => boolean,
) {
  const { paths } = await walkKnowledgeEdges(ctx, {
    root, edgeIds, mode: 'following', hops: 1, direction: 'outbound', unavailable,
    acceptEdge: edge => edge.kind === 'instance_of' && edge.to.blockId === undefined && matchesQuestion(edge.from, root),
  });
  return paths.length === 1 ? paths[0]?.endpoint.sourceUse : undefined;
}

class ReleaseReadFailure extends Error {}

async function releaseCurrent(access: CorrectionMicroVariantAccess, question: QuestionRef) {
  // The release gate uses plain Errors for expected rejections. Keep reader failures distinct.
  const read = async <T>(run: () => Promise<T>) => {
    try { return await run(); }
    catch (cause) { throw new ReleaseReadFailure('题目发放读取失败。', { cause }); }
  };
  try {
    const released = await openQuestionForRelease({
      fact: (id, options) => read(() => access.read.fact(id, options)),
      slot: (ref, options) => read(() => access.read.slot(ref, options)),
    }, question.id, ['teaching', access.purpose, ...access.releaseUses]);
    if (released.ref.learner === access.learner && released.ref.id === question.id && released.ref.rev === question.rev) {
      return question;
    }
    return undefined;
  } catch (error) {
    if (error instanceof ReleaseReadFailure) throw error.cause;
    if (!(error instanceof Error)) throw error;
    return undefined;
  }
}

/** Read one optional check question for a verified correction. The host supplies the corrected
 * item's frozen Asset reference and authorized edge IDs under the actual learner, purpose and recipient.
 * Supply the complete bounded set of relevant archetype mappings so ambiguity can be detected.
 * Keep this reference server-side, and rerun selection before release if the snapshot changes. */
export async function readCorrectionMicroVariant(access: CorrectionMicroVariantAccess, input: {
  readonly source: FactRef;
  readonly variantEdgeIds: readonly FactId[];
  readonly archetypeEdgeIds: readonly FactId[];
}): Promise<QuestionRef | undefined> {
  const { source, variantEdgeIds, archetypeEdgeIds } = input;
  if (source.learner !== access.learner || !access.purpose.trim() || !access.recipient.trim() ||
      !access.releaseUses.length || !variantEdgeIds.length || !archetypeEdgeIds.length) return;
  const unavailable = (error: unknown) => error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError ||
    error instanceof AssetBasisError || access.isUnavailable(error);
  // Edge walks repeatedly open the same endpoint and evidence rows in this snapshot.
  const opened = new Map<string, Promise<FactSnapshot>>();
  const graph: AssetReadContext = { learner: access.learner, read: {
    fact(id, options) {
      const key = `${id}:${options.mode === 'pinned' ? options.rev : 'following'}`;
      const previous = opened.get(key);
      if (previous) return previous;
      const pending = access.read.fact(id, options);
      opened.set(key, pending);
      return pending;
    },
  } };

  try {
    const fact = await graph.read.fact(source.id, { mode: 'pinned', rev: source.rev });
    if (fact.type !== assetType || knowledgeEndpointKind(fact) !== 'question' ||
        fact.ref.learner !== source.learner || fact.ref.id !== source.id || fact.ref.rev !== source.rev) return;
    const root = { kind: 'question' as const, sourceUse: { id: source.id, rev: source.rev, accessEpoch: fact.accessEpoch } };
    const { paths } = await walkKnowledgeEdges(graph, {
      root, edgeIds: variantEdgeIds, mode: 'pinned', hops: 1, uniquePaths: true, unavailable,
      acceptEdge: edge => edge.kind === 'variant_of' && edge.from.blockId === undefined && edge.to.blockId === undefined &&
        (matchesQuestion(edge.from, root) || matchesQuestion(edge.to, root)),
    });
    if (!paths.length) return;
    const archetype = await readArchetype(graph, root, archetypeEdgeIds, unavailable);
    if (!archetype) return;
    const candidates = paths.sort((a, b) => a.endpoint.sourceUse.id.localeCompare(b.endpoint.sourceUse.id) ||
      a.endpoint.sourceUse.rev - b.endpoint.sourceUse.rev);
    for (const { endpoint, edge } of candidates) {
      const { id, rev } = endpoint.sourceUse;
      // The correction can reveal the source solution. Require this edge to be safe in that direction.
      if (id === source.id || !edge.variant || !canUseDistinguishingVariant(edge, source.id, 'solution_seen')) continue;
      try {
        const candidateArchetype = await readArchetype(graph, endpoint, archetypeEdgeIds, unavailable);
        if (!candidateArchetype || knowledgeUseKey(candidateArchetype) !== knowledgeUseKey(archetype)) continue;
        const question = await releaseCurrent(access, { id, rev });
        if (!question) continue;
        const exposure = await access.readExposure({
          candidate: { learner: access.learner, ...question },
          archetype: { learner: access.learner, id: archetype.id, rev: archetype.rev },
          familyId: edge.variant.familyId,
        });
        if (exposure.kind === 'unexposed') return question;
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
  return undefined;
}
