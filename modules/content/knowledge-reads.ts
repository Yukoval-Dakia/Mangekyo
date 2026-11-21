import { FactNotFoundError, type FactId } from '@mangekyo/kernel';
import { assessmentRelease, type AssessmentRelease, type AssessmentRevisionRef } from './assessment-values.ts';
import { AssetBasisError, assetType, checkQuestionTeachingSources, checkTextbookBasis, questionAsset, type AssetReadContext } from './asset.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEndpointKind, knowledgeUseKey, openKnowledgeEdgeRevision, readKnowledgeUse,
  walkKnowledgeEdges, workspaceEntryType, type KnowledgeEdge, type KnowledgeSourceUse,
} from './knowledge-edge.ts';
import { record } from './parse.ts';
import { projectQuestionPrompt } from './question-verification.ts';

/** The host binds read to one snapshot, the actual recipient, and the requested purpose.
 * It reopens transitive provenance and selection permissions before returning a fact.
 */
export type KnowledgeReadAccess = AssetReadContext & {
  readonly purpose: string;
  readonly recipient: string;
  /** Classify expected denied, missing or stale source reads. Operational errors propagate. */
  readonly isUnavailable: (error: unknown) => boolean;
  /** Open all of a legacy question's provenance under the same authorization. */
  readonly reopenLegacyQuestion?: (use: KnowledgeSourceUse) => Promise<boolean>;
};

type CandidateSet = { readonly edgeIds: readonly FactId[]; readonly complete: boolean };
type Mode = 'following' | 'pinned';

function bound(access: KnowledgeReadAccess) {
  return Boolean(access.purpose.trim() && access.recipient.trim());
}

function unavailable(access: KnowledgeReadAccess, error: unknown) {
  return error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError ||
    error instanceof AssetBasisError || access.isUnavailable(error);
}

async function openQuestion(access: KnowledgeReadAccess, use: KnowledgeSourceUse) {
  const fact = await readKnowledgeUse(access, use);
  if (knowledgeEndpointKind(fact) !== 'question') return undefined;
  if (fact.type === assetType) {
    await checkTextbookBasis(access.read, questionAsset(fact.value).basis ?? []);
    return fact;
  }
  if (fact.type === workspaceEntryType && await access.reopenLegacyQuestion?.(use)) return fact;
  return undefined;
}

const whole = (edge: KnowledgeEdge) => edge.from.blockId === undefined && edge.to.blockId === undefined;

/** Pass authorized, witness-tracking reads for the actual recipient in one snapshot.
 * Both candidate sets must be complete for this scope. The origin reader reopens the
 * original paper/item and its provenance, and returns a stable item identity across copies
 * and revisions. Use undefined for an unverifiable origin and non-paper only when proven.
 */
export async function readArchetypeCoverage(
  access: KnowledgeReadAccess,
  input: {
    readonly archetype: KnowledgeSourceUse;
    readonly scope: string;
    readonly memberships: CandidateSet;
    readonly variants: CandidateSet;
  },
  readOrigin: (question: KnowledgeSourceUse) =>
    Promise<{ readonly kind: 'original'; readonly key: string } | { readonly kind: 'non-paper' } | undefined>,
) {
  const { archetype, scope, memberships, variants } = input;
  if (!bound(access) || !scope.trim() || !memberships.complete || !variants.complete ||
      memberships.edgeIds.length > 128 || variants.edgeIds.length > 128) return;
  try {
    if ((await readKnowledgeUse(access, archetype)).type !== assetType) return;
    const graph = await walkKnowledgeEdges(access, {
      root: { kind: 'archetype', sourceUse: archetype }, edgeIds: memberships.edgeIds,
      mode: 'following', direction: 'inbound', hops: 1,
      acceptEdge: edge => edge.kind === 'instance_of' && edge.scope === scope && whole(edge),
    });
    const originals = new Map<string, string>();
    for (const { endpoint } of graph.paths) {
      const use = endpoint.sourceUse;
      if (!await openQuestion(access, use)) return;
      const origin = await readOrigin(use);
      if (!origin || (origin.kind === 'original' && !origin.key.trim())) return;
      if (origin.kind === 'original') originals.set(knowledgeUseKey(use), origin.key);
    }
    const dimensions = new Map<string, KnowledgeSourceUse>();
    for (const id of new Set(variants.edgeIds)) {
      const { edge, snapshot } = await openKnowledgeEdgeRevision(access, id, { mode: 'following' });
      if (edge.kind !== 'variant_of' || edge.scope !== scope || !edge.variant || !whole(edge)) continue;
      const from = originals.get(knowledgeUseKey(edge.from.sourceUse));
      const to = originals.get(knowledgeUseKey(edge.to.sourceUse));
      if (!from || !to || from === to) continue;
      for (const dimension of edge.variant.changed) {
        const name = dimension.trim();
        if (!dimensions.has(name)) dimensions.set(name, { id: snapshot.ref.id, rev: snapshot.ref.rev, accessEpoch: snapshot.accessEpoch });
      }
    }
    return { archetype: graph.root.sourceUse, coveredQuestionCount: new Set(originals.values()).size,
      variationDimensions: [...dimensions].map(([dimension, evidence]) => ({ dimension, evidence })),
    };
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return undefined;
  }
}

export type NotionGraphBlock = KnowledgeSourceUse & { readonly blockId: string };
type NotionQuestionRoot =
  | { readonly kind: 'question'; readonly sourceUse: KnowledgeSourceUse }
  | { readonly kind: 'note'; readonly sourceUse: KnowledgeSourceUse; readonly blockId: string };

/** The graph stores question → concept and Notion block → concept. Read either way
 * by following one edge into the concept and reversing the other edge.
 * The scoped fact reader authorizes every edge basis, including any Notion sources.
 * Reopen blocks with Capture's selected-source reader for this purpose and recipient.
 */
export async function readQuestionNotionLinks(
  access: KnowledgeReadAccess,
  input: { readonly root: NotionQuestionRoot; readonly mode: Mode; readonly edgeIds: readonly FactId[] },
  reopenNotionBlock: (ref: NotionGraphBlock, mode: Mode) => Promise<{ readonly text: string } | undefined>,
) {
  const { root, mode, edgeIds } = input;
  if (!bound(access) || edgeIds.length > 128) return [];
  try {
    if (root.kind === 'question') {
      if (!await openQuestion(access, root.sourceUse)) return [];
    } else if ((await readKnowledgeUse(access, root.sourceUse)).type !== 'capture.source' ||
        !(await reopenNotionBlock({ ...root.sourceUse, blockId: root.blockId }, mode))?.text.trim()) return [];

    const { paths } = await walkKnowledgeEdges(access, {
      root, edgeIds, mode, hops: 2, unavailable: error => unavailable(access, error),
      acceptEdge: ({ kind, from, to }) => to.kind === 'concept' && to.blockId === undefined &&
        ((kind === 'targets_concept' && from.kind === 'question' && from.blockId === undefined) ||
          (kind === 'explains' && from.kind === 'note' && from.blockId !== undefined)),
    });
    const links = [];
    for (const { endpoint, trail, hop } of paths) {
      const concept = trail[0]?.endpoint.sourceUse;
      if (hop !== 2 || !concept || endpoint.kind === root.kind) continue;
      try {
        if (endpoint.kind === 'question' && await openQuestion(access, endpoint.sourceUse)) {
          links.push({ kind: 'question' as const, question: endpoint.sourceUse, concept, trail });
        } else if (endpoint.kind === 'note' && endpoint.blockId &&
            (await readKnowledgeUse(access, endpoint.sourceUse)).type === 'capture.source') {
          const block = { ...endpoint.sourceUse, blockId: endpoint.blockId };
          const opened = await reopenNotionBlock(block, mode);
          if (opened?.text.trim()) links.push({ kind: 'notion-block' as const, block, text: opened.text, concept, trail });
        }
      } catch (error) {
        if (!unavailable(access, error)) throw error;
      }
    }
    return links;
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return [];
  }
}

/** The host determines weakness and unexposed inventory against the actual recipient's
 * authorized learner model and release/exposure witnesses. Undefined denotes incomplete evidence.
 */
export async function readRemediationContent(
  access: KnowledgeReadAccess,
  input: { readonly concept: KnowledgeSourceUse; readonly prerequisites: CandidateSet },
  isWeakPrerequisite: (concept: KnowledgeSourceUse) => Promise<boolean | undefined>,
  readUnexposedQuestionCount: (concept: KnowledgeSourceUse) => Promise<number | undefined>,
) {
  if (!bound(access) || !input.prerequisites.complete || input.prerequisites.edgeIds.length > 128) return;
  try {
    const { paths, root } = await walkKnowledgeEdges(access, {
      root: { kind: 'concept', sourceUse: input.concept }, edgeIds: input.prerequisites.edgeIds,
      direction: 'inbound', mode: 'following', hops: 2,
      acceptEdge: edge => edge.kind === 'prereq_of' && edge.from.kind === 'concept' && edge.to.kind === 'concept' && whole(edge),
    });
    const weakPrerequisites = [];
    for (const { endpoint, hop, trail } of paths) {
      const weak = await isWeakPrerequisite(endpoint.sourceUse);
      if (weak === undefined) return;
      if (!weak) continue;
      const { value } = await readKnowledgeUse(access, endpoint.sourceUse);
      const { title } = record(value);
      if (typeof title !== 'string' || !title.trim()) return;
      weakPrerequisites.push({ concept: endpoint.sourceUse, title, hop, trail });
    }
    const count = await readUnexposedQuestionCount(root.sourceUse);
    return { weakPrerequisites,
      ...(count !== undefined && Number.isSafeInteger(count) && count >= 0 ? { unexposedQuestionCount: count } : {}),
    };
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return undefined;
  }
}

/** Only pass the reader authorized to supply frozen rubric data to the actual grader.
 * The host opens the published release by its exact revision and reauthorizes its full
 * rubric provenance. Submission authorization and original answers belong to Activity.
 */
export async function readFrozenGradeQuestion(
  access: KnowledgeReadAccess,
  input: { readonly question: KnowledgeSourceUse; readonly release: AssessmentRevisionRef; readonly itemId: string },
  reopenPublishedRelease: (ref: AssessmentRevisionRef) => Promise<AssessmentRelease | undefined>,
) {
  if (!bound(access)) return;
  try {
    const published = await reopenPublishedRelease(input.release);
    if (!published) return;
    const { releaseRef, items } = assessmentRelease(published);
    if (releaseRef.id !== input.release.id || releaseRef.rev !== input.release.rev) return;
    const item = items.find(({ itemId }) => itemId === input.itemId);
    if (item?.promptRef?.id !== input.question.id || item.promptRef.rev !== input.question.rev) return;
    const question = await readKnowledgeUse(access, input.question, 'teaching');
    if (question.type !== assetType || knowledgeEndpointKind(question) !== 'question') return;
    const asset = questionAsset(question.value);
    await checkQuestionTeachingSources(access.read, asset);
    const prompt = await projectQuestionPrompt(access.read, asset, item.slots);
    if (prompt.kind !== 'ready') return;
    return { question: input.question, prompt: prompt.content, releaseRef, item };
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return undefined;
  }
}
