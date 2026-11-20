import { FactNotFoundError, type FactId, type LearnerId, type Revision } from '@mangekyo/kernel';
import { AssetBasisError, assetType, checkTextbookBasis, openAssetReference, questionAsset, type AssetReadContext } from './asset.ts';
import { openKnowledgeEntity } from './knowledge-entity.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEndpointKind, knowledgeUseKey, readKnowledgeUse, walkKnowledgeEdges, workspaceEntryType,
  type KnowledgeEdge, type KnowledgeEndpoint, type KnowledgeSourceUse,
} from './knowledge-edge.ts';

type FrozenQuestionRef = { readonly id: FactId; readonly rev: Revision };
type CapsuleKind = 'notion-block' | 'archetype';
type Trail = readonly { readonly edge: KnowledgeSourceUse; readonly endpoint: KnowledgeEndpoint }[];
export type PaperCapsuleBinding = {
  readonly version: 1;
  readonly learner: LearnerId;
  readonly purpose: string;
  readonly recipient: string;
  readonly question: KnowledgeSourceUse;
  readonly kind: CapsuleKind;
  readonly trail: Trail;
};

/** All reads share one authorized snapshot bound to this learner, purpose and actual recipient. */
export type PaperCapsuleAccess = {
  readonly learner: LearnerId;
  readonly purpose: string;
  readonly recipient: string;
  readonly read: AssetReadContext['read'];
  // Reopen a legacy frozen question and its full provenance under the same snapshot,
  // purpose and recipient. Return the authorized pinned witness only on success.
  readonly reopenLegacyQuestion?: (ref: FrozenQuestionRef) => Promise<KnowledgeSourceUse | undefined>;
  // The host classifies expected authorization and missing-source errors. Other failures remain visible.
  readonly isUnavailable: (error: unknown) => boolean;
  // Use the host's existing opaque authenticated handles. The token exposes none of the binding.
  readonly seal: (binding: PaperCapsuleBinding) => Promise<string>;
  readonly unseal: (ref: string) => Promise<PaperCapsuleBinding | null>;
};

function unavailable(access: PaperCapsuleAccess, error: unknown) {
  return error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError ||
    error instanceof AssetBasisError || access.isUnavailable(error);
}

function acceptedPaperEdge(question: KnowledgeSourceUse, edge: KnowledgeEdge) {
  if (edge.from.blockId !== undefined || edge.to.blockId !== undefined) {
    return edge.kind === 'explains' && edge.from.kind === 'note' &&
      edge.from.blockId !== undefined && edge.to.kind === 'concept' && edge.to.blockId === undefined;
  }
  return edge.from.kind === 'question' && knowledgeUseKey(edge.from.sourceUse) === knowledgeUseKey(question) &&
    ((edge.kind === 'targets_concept' && edge.to.kind === 'concept') ||
      (edge.kind === 'instance_of' && edge.to.kind === 'archetype'));
}

async function fixedEntity(access: PaperCapsuleAccess, endpoint: KnowledgeEndpoint) {
  const use = endpoint.sourceUse;
  const current = await access.read.fact(use.id, { mode: 'following' });
  if (current.type !== assetType || current.ref.learner !== access.learner ||
      current.ref.rev !== use.rev || current.accessEpoch !== use.accessEpoch) return undefined;
  // Open the currently authorized pinned identity. A redirect may change which
  // concept the source explains, so this surface declines to infer a new path.
  const result = await openKnowledgeEntity(access.read, use.id, use.rev);
  return result.entity.kind === endpoint.kind && result.entity.merged_into === null ? result.entity : undefined;
}

function notionBlock(value: unknown, blockId: string) {
  if (!value || typeof value !== 'object' || !('unit' in value) || !('kind' in value) || value.kind !== 'notion') return undefined;
  const unit = value.unit;
  if (!unit || typeof unit !== 'object' || !('blocks' in unit) || !Array.isArray(unit.blocks)) return undefined;
  const block = unit.blocks.find(entry => entry?.id === blockId);
  const body: { kind?: unknown; layer?: unknown; status?: unknown; text?: unknown } | undefined = block?.body;
  return body?.kind === 'capture' && body.layer === 'source' && body.status === 'known' &&
    typeof body.text === 'string' && body.text.trim() ? body.text : undefined;
}

async function discover(access: PaperCapsuleAccess, sourceQuestionRef: FrozenQuestionRef, edgeIds: readonly FactId[], only?: CapsuleKind) {
  if (!access.purpose.trim() || !access.recipient.trim() || edgeIds.length === 0) return [];
  try {
    const { id, rev } = sourceQuestionRef;
    const root = await access.read.fact(id, { mode: 'pinned', rev });
    if (root.ref.id !== id || root.ref.rev !== rev || root.ref.learner !== access.learner ||
        knowledgeEndpointKind(root) !== 'question') return [];
    const question = { id, rev, accessEpoch: root.accessEpoch };
    if (root.type === assetType) {
      await checkTextbookBasis(access.read, questionAsset(root.value).basis ?? []);
    } else if (root.type === workspaceEntryType) {
      const witness = await access.reopenLegacyQuestion?.({ id, rev });
      if (!witness || knowledgeUseKey(witness) !== knowledgeUseKey(question)) return [];
    } else {
      return [];
    }
    const graph = await walkKnowledgeEdges(access, {
      root: { kind: 'question', sourceUse: question }, edgeIds, mode: 'pinned', hops: 2,
      acceptEdge: edge => acceptedPaperEdge(question, edge) && (only === undefined ||
        (edge.kind === 'instance_of') === (only === 'archetype')), uniquePaths: true,
      unavailable: error => unavailable(access, error),
    });
    const context = { version: 1 as const, learner: access.learner, purpose: access.purpose, recipient: access.recipient, question };
    const matches: {
      binding: PaperCapsuleBinding;
      content: { kind: 'notion-block'; text: string } | { kind: 'archetype'; title: string };
    }[] = [];
    for (const { hop, endpoint, trail } of graph.paths) {
      try {
        if (hop === 1 && endpoint.kind === 'archetype') {
          const entity = await fixedEntity(access, endpoint);
          if (entity) matches.push({ binding: { ...context, kind: 'archetype', trail },
            content: { kind: 'archetype', title: entity.canonicalName } });
        }
        const bridge = trail[0]?.endpoint;
        const blockId = endpoint.blockId;
        if (hop !== 2 || !bridge || bridge.kind !== 'concept' || endpoint.kind !== 'note' || !blockId ||
            !await fixedEntity(access, bridge)) continue;
        const fact = await readKnowledgeUse(access, endpoint.sourceUse);
        if (fact.type !== 'capture.source') continue;
        await openAssetReference(access.read, { fact: fact.ref, type: fact.type, anchor: { kind: 'block', blockId } });
        const text = notionBlock(fact.value, blockId);
        if (text) matches.push({ binding: { ...context, kind: 'notion-block', trail }, content: { kind: 'notion-block', text } });
      } catch (error) {
        if (!unavailable(access, error)) throw error;
      }
    }
    return matches.filter(({ binding }) => matches.filter(match => match.binding.kind === binding.kind).length === 1);
  } catch (error) {
    if (unavailable(access, error)) return [];
    throw error;
  }
}

/** Candidate IDs come from the host's authorized graph query. Only opaque handles leave discovery. */
export async function listPaperCapsules(access: PaperCapsuleAccess, sourceQuestionRef: FrozenQuestionRef, edgeIds: readonly FactId[], only?: CapsuleKind) {
  return Promise.all((await discover(access, sourceQuestionRef, edgeIds, only)).map(async ({ binding }) => ({
    kind: binding.kind, ref: await access.seal(binding),
  })));
}

function sameTrail(left: Trail, right: Trail) {
  return left.length === right.length && left.every((step, index) => {
    const other = right[index];
    return other && knowledgeUseKey(step.edge) === knowledgeUseKey(other.edge) &&
      step.endpoint.kind === other.endpoint.kind && step.endpoint.blockId === other.endpoint.blockId &&
      knowledgeUseKey(step.endpoint.sourceUse) === knowledgeUseKey(other.endpoint.sourceUse);
  });
}

/** The host reopens the current issuance and supplies its frozen item ref and freshly authorized edge IDs. */
export async function openPaperCapsule(
  access: PaperCapsuleAccess, ref: string, edgeIds: readonly FactId[], expectedQuestionRef: FrozenQuestionRef,
) {
  const binding = await access.unseal(ref);
  if (!binding || !expectedQuestionRef || binding.version !== 1 || binding.learner !== access.learner ||
      binding.purpose !== access.purpose || binding.recipient !== access.recipient ||
      binding.question.id !== expectedQuestionRef.id || binding.question.rev !== expectedQuestionRef.rev) return;
  const matches = await discover(access, binding.question, edgeIds);
  return matches.find(match => match.binding.kind === binding.kind &&
    knowledgeUseKey(match.binding.question) === knowledgeUseKey(binding.question) &&
    sameTrail(match.binding.trail, binding.trail))?.content;
}
