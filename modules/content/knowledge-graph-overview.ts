import { FactNotFoundError, factId, type FactId, type FactSnapshot, type LearnerId, type Revision, type Tick } from '@mangekyo/kernel';
import { AssetBasisError, assetType, checkTextbookBasis, parseAsset } from './asset.ts';
import { evolveGraphCommand, parseGraphEvolution } from './graph-evolution.ts';
import {
  createKnowledgeEdgeCommand, KnowledgeEdgeBasisError, knowledgeEdgeType, knowledgeEndpointKind,
  knowledgeUseKey, openKnowledgeWalkEdge, parseEdgeEvidence, parseEdgeWrite, readKnowledgeUse,
  verifyKnowledgeEdge, workspaceEntryType, type KnowledgeEdgeKind, type KnowledgeEndpoint, type KnowledgeSourceUse,
} from './knowledge-edge.ts';
import { openKnowledgeEntity } from './knowledge-entity.ts';
import { parseCreateKnowledgeEntity, parseMergeKnowledgeEntity } from './knowledge-entity-writes.ts';
import { openKnowledgeQuestion, type KnowledgeReadAccess } from './knowledge-reads.ts';
import { record } from './parse.ts';
import { parseTextbookRevision } from './textbook-edits.ts';
import { textbookPageFrom, textbookPageType } from './textbook-page.ts';

export type ContentReadScope = {
  readonly learner: LearnerId;
  query<Row>(sql: string, params: readonly (string | number | null | readonly string[])[]):
    Promise<{ readonly rows: readonly Row[] }>;
};

export type KnowledgeGraphOverviewAccess = KnowledgeReadAccess & {
  readonly preloadFollowing?: (ids: readonly FactId[]) => Promise<void>;
  readonly verifyLegacyBasis?: (id: FactId, fact: FactSnapshot) => Promise<boolean>;
  readonly openNotionSource?: (fact: FactSnapshot) => Promise<FactSnapshot | undefined>;
};

export type KnowledgeGraphNodeCounts = {
  readonly questions: number;
  readonly textbooks: number;
  readonly notes: number;
  readonly notionBlocks: number;
};

export type KnowledgeGraphMastery = {
  readonly status: 'steady' | 'fading' | 'fragile' | 'unknown';
  readonly retrievability: number | null;
  readonly independentCount: number;
  readonly basisRefs: readonly { readonly id: FactId; readonly rev: Revision; readonly type: string }[];
  readonly reason?: 'no-independent-evidence' | 'incomplete-coverage' | 'unavailable';
};

export type KnowledgeGraphNodeDraft = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly factType: 'content.asset' | 'activity.workspaceEntry';
  readonly title: string;
  readonly aliases: readonly string[];
  readonly summary: string | null;
  readonly counts: KnowledgeGraphNodeCounts;
};

export type KnowledgeGraphNode = KnowledgeGraphNodeDraft & {
  readonly mastery: KnowledgeGraphMastery;
};

export type KnowledgeGraphEdge = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly kind: KnowledgeEdgeKind;
  readonly fromId: FactId;
  readonly toId: FactId;
  readonly scope: string;
  readonly verified: boolean;
  readonly verificationMethod: string | null;
  readonly confidence: number | null;
  readonly sourceRefs: readonly KnowledgeSourceUse[];
};

export type KnowledgeGraphProposalAction = {
  readonly method: 'POST';
  readonly path: string;
  readonly body: Record<string, unknown>;
};

export type KnowledgeGraphProposal = {
  readonly proposalId: string;
  readonly commandType: string;
  readonly status: 'pending';
  readonly createdTick: Tick;
  readonly summary: string;
  readonly edgeKind?: KnowledgeEdgeKind;
  readonly scope?: string;
  readonly fromId?: FactId;
  readonly fromTitle?: string;
  readonly toId?: FactId;
  readonly toTitle?: string;
  readonly targetId?: FactId;
  readonly actions?: {
    readonly accept?: KnowledgeGraphProposalAction;
    readonly reject?: KnowledgeGraphProposalAction;
  };
};

export type QuestionConceptLink = {
  readonly questionId: FactId;
  readonly questionRev: Revision;
  readonly conceptId: FactId;
  readonly edgeRef: { readonly id: FactId; readonly rev: Revision; readonly type: string };
};

export type AuthorizedKnowledgeGraph = {
  readonly nodes: readonly KnowledgeGraphNodeDraft[];
  readonly edges: readonly KnowledgeGraphEdge[];
  readonly pendingProposals: readonly KnowledgeGraphProposal[];
  readonly questionConceptLinks: readonly QuestionConceptLink[];
};

export type KnowledgeGraphResponse = {
  readonly asOf: string;
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
  readonly pendingProposals: readonly KnowledgeGraphProposal[];
};

const createEntityCommand = 'content.createKnowledgeEntity';
const mergeEntityCommand = 'content.mergeKnowledgeEntity';
export const graphProposalCommands = [
  createKnowledgeEdgeCommand, evolveGraphCommand, createEntityCommand, mergeEntityCommand,
] as const;

const defaultUnknownMastery: KnowledgeGraphMastery = {
  status: 'unknown', retrievability: null, independentCount: 0, basisRefs: [], reason: 'no-independent-evidence',
};

function isUnavailable(access: KnowledgeGraphOverviewAccess, error: unknown) {
  return error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError ||
    error instanceof AssetBasisError || access.isUnavailable(error);
}

function factTitle(fact: FactSnapshot): string {
  try {
    const value = record(fact.value);
    if (typeof value.title === 'string' && value.title.trim()) return value.title.trim();
    if (typeof value.canonicalName === 'string' && value.canonicalName.trim()) return value.canonicalName.trim();
  } catch { /* fall through */ }
  return fact.ref.id;
}

function isNotionFact(fact: FactSnapshot): boolean {
  if (fact.type !== 'capture.source') return false;
  try { return record(fact.value).kind === 'notion'; } catch { return false; }
}

async function verifyNotion(access: KnowledgeGraphOverviewAccess, fact: FactSnapshot) {
  if (!isNotionFact(fact)) return fact;
  if (!access.openNotionSource) return undefined;
  return access.openNotionSource(fact);
}

export async function readAuthorizedKnowledgeGraph(
  tx: ContentReadScope,
  access: KnowledgeGraphOverviewAccess,
): Promise<AuthorizedKnowledgeGraph> {
  if (!access.purpose.trim() || !access.recipient.trim()) {
    return { nodes: [], edges: [], pendingProposals: [], questionConceptLinks: [] };
  }

  const conceptRows = await tx.query<{ id: string; type: string }>(`
      SELECT f.id, f.type FROM facts f
      JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.retracted_rev IS NULL
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
        AND ((f.type=$2 AND r.data->>'kind'='concept') OR (f.type=$3 AND r.data->>'kind'='concept'))
      ORDER BY f.id LIMIT 512`, [tx.learner, assetType, workspaceEntryType]);
  const edgeRows = await tx.query<{ id: string; type: string }>(`
      SELECT f.id, f.type FROM facts f
      JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.retracted_rev IS NULL
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
        AND (f.type=$2 OR (f.type=$3 AND r.data->>'kind'='relation'))
      ORDER BY f.id LIMIT 1024`, [tx.learner, knowledgeEdgeType, workspaceEntryType]);
  const legacyLinkRows = await tx.query<{ id: string }>(`
      SELECT f.id FROM facts f
      JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
        AND r.data->>'kind' IN ('question','page')
        AND jsonb_typeof(r.data->'links')='array' AND jsonb_array_length(r.data->'links')>0
      ORDER BY f.id LIMIT 512`, [tx.learner, workspaceEntryType]);
  const proposalRows = await tx.query<{ id: string; type: string; input: unknown; createdTick: Tick }>(`
      SELECT p.command_id AS id, c.type, p.input, p.created_tick::text AS "createdTick"
      FROM proposals p
      JOIN commands c ON (c.learner_id,c.id)=(p.learner_id,p.command_id)
      WHERE p.learner_id=$1 AND p.state='pending' AND c.type=ANY($2::text[])
      ORDER BY p.created_tick DESC, p.command_id LIMIT 128`, [tx.learner, [...graphProposalCommands]]);

  const preloadIds = [
    ...conceptRows.rows.map(row => factId(row.id)),
    ...edgeRows.rows.map(row => factId(row.id)),
    ...legacyLinkRows.rows.map(row => factId(row.id)),
  ];
  if (preloadIds.length) await access.preloadFollowing?.(preloadIds);

  const nodeMap = new Map<FactId, Omit<KnowledgeGraphNodeDraft, 'counts'>>();
  const aliasToCanonical = new Map<FactId, FactId>();
  const countsByConcept = new Map<FactId, {
    questions: Set<string>; textbooks: Set<string>; notes: Set<string>; notionBlocks: Set<string>;
  }>();
  const ensureCounts = (id: FactId) => {
    let bucket = countsByConcept.get(id);
    if (!bucket) {
      bucket = { questions: new Set(), textbooks: new Set(), notes: new Set(), notionBlocks: new Set() };
      countsByConcept.set(id, bucket);
    }
    return bucket;
  };

  for (const row of conceptRows.rows) {
    const id = factId(row.id);
    try {
      if (row.type === assetType) {
        const { snapshot, entity, redirects } = await openKnowledgeEntity(access.read, id);
        if (entity.kind !== 'concept') continue;
        for (const ref of redirects) aliasToCanonical.set(ref.id, snapshot.ref.id);
        if (!nodeMap.has(snapshot.ref.id)) {
          nodeMap.set(snapshot.ref.id, {
            id: snapshot.ref.id, rev: snapshot.ref.rev, factType: assetType,
            title: entity.canonicalName, aliases: [...entity.aliases], summary: null,
          });
          ensureCounts(snapshot.ref.id);
        }
      } else {
        const fact = await access.read.fact(id, { mode: 'following' });
        if (fact.type !== workspaceEntryType) continue;
        if (access.verifyLegacyBasis && !await access.verifyLegacyBasis(id, fact)) continue;
        const value = record(fact.value);
        if (value.kind !== 'concept' || typeof value.title !== 'string') continue;
        const summary = typeof value.body === 'string' && value.body.trim() ? value.body.trim().slice(0, 200) : null;
        if (!nodeMap.has(id)) {
          nodeMap.set(id, { id, rev: fact.ref.rev, factType: workspaceEntryType, title: value.title, aliases: [], summary });
          ensureCounts(id);
        }
      }
    } catch (error) {
      if (!isUnavailable(access, error)) throw error;
    }
  }

  const edges: KnowledgeGraphEdge[] = [];
  const questionConceptLinks: QuestionConceptLink[] = [];
  const variantQuestionLinks: {
    readonly variantId: FactId;
    readonly variantRev: Revision;
    readonly baseId: FactId;
    readonly edgeRef: { readonly id: FactId; readonly rev: Revision; readonly type: string };
  }[] = [];
  const seenEdges = new Set<string>();

  const resolveConceptId = (endpoint: KnowledgeEndpoint): FactId | undefined => {
    if (endpoint.kind !== 'concept' || endpoint.blockId !== undefined) return undefined;
    const mapped = aliasToCanonical.get(endpoint.sourceUse.id) ?? endpoint.sourceUse.id;
    return nodeMap.has(mapped) ? mapped : undefined;
  };

  const recordResourceLink = async (
    conceptId: FactId,
    resource: KnowledgeEndpoint,
    edgeRef: { readonly id: FactId; readonly rev: Revision; readonly type: string },
    edgeKind: KnowledgeEdgeKind,
  ) => {
    const bucket = ensureCounts(conceptId);
    const use = resource.sourceUse;
    if (resource.kind === 'question') {
      const opened = await openKnowledgeQuestion(access, use);
      if (!opened) return;
      bucket.questions.add(opened.ref.id);
      if (edgeKind === 'targets_concept' || edgeKind === 'related_to' || edgeKind === 'addresses_pitfall') {
        questionConceptLinks.push({ questionId: opened.ref.id, questionRev: opened.ref.rev, conceptId, edgeRef });
      }
      return;
    }
    const fact = await readKnowledgeUse(access, use);
    const checkedNotion = await verifyNotion(access, fact);
    if (!checkedNotion) return;
    if (isNotionFact(fact)) {
      bucket.notionBlocks.add(`${fact.ref.id}#${resource.blockId ?? ''}`);
      return;
    }
    if (resource.kind === 'chapter') {
      const current = await access.read.fact(fact.ref.id, { mode: 'following' });
      if (current.type === textbookPageType) {
        const page = textbookPageFrom(current);
        if (page.archived) return;
        await checkTextbookBasis(access.read, page.basis ?? []);
      } else if (current.type === assetType) {
        await checkTextbookBasis(access.read, parseAsset(current.value).basis ?? []);
      }
      bucket.textbooks.add(`${fact.ref.id}#${resource.blockId ?? ''}`);
      return;
    }
    if (resource.kind === 'note') {
      if (fact.type === workspaceEntryType && access.verifyLegacyBasis && !await access.verifyLegacyBasis(fact.ref.id, fact)) return;
      bucket.notes.add(`${fact.ref.id}#${resource.blockId ?? ''}`);
    }
  };

  for (const row of edgeRows.rows) {
    const id = factId(row.id);
    try {
      if (row.type === knowledgeEdgeType) {
        const opened = await openKnowledgeWalkEdge(access, id, { mode: 'following', classifyMalformed: true });
        if (!opened) continue;
        const { fact, original, projected } = opened;
        let notionOk = true;
        for (const use of original.sourceUses) {
          const src = await readKnowledgeUse(access, use);
          if (!await verifyNotion(access, src)) { notionOk = false; break; }
        }
        if (!notionOk) continue;
        let verificationMethod: string | null = null;
        if (original.verification) {
          const proof = await readKnowledgeUse(access, original.verification);
          verificationMethod = parseEdgeEvidence(proof.value).method;
        }
        const fromConcept = resolveConceptId(projected.from);
        const toConcept = resolveConceptId(projected.to);
        if (fromConcept && toConcept) {
          if (!seenEdges.has(fact.ref.id)) {
            seenEdges.add(fact.ref.id);
            edges.push({
              id: fact.ref.id, rev: fact.ref.rev, kind: projected.kind,
              fromId: fromConcept, toId: toConcept, scope: projected.scope,
              verified: Boolean(original.verification), verificationMethod,
              confidence: projected.confidence ?? null, sourceRefs: original.sourceUses,
            });
          }
          continue;
        }
        const edgeRef = { id: fact.ref.id, rev: fact.ref.rev, type: knowledgeEdgeType };
        if (fromConcept && projected.to.kind !== 'concept') {
          await recordResourceLink(fromConcept, projected.to, edgeRef, projected.kind);
        } else if (toConcept && projected.from.kind !== 'concept') {
          await recordResourceLink(toConcept, projected.from, edgeRef, projected.kind);
        } else if (
          projected.kind === 'variant_of' &&
          projected.from.kind === 'question' &&
          projected.to.kind === 'question' &&
          projected.from.blockId === undefined &&
          projected.to.blockId === undefined
        ) {
          const variantOpened = await openKnowledgeQuestion(access, projected.from.sourceUse);
          const baseOpened = variantOpened ? await openKnowledgeQuestion(access, projected.to.sourceUse) : null;
          if (variantOpened && baseOpened && variantOpened.ref.id !== baseOpened.ref.id) {
            variantQuestionLinks.push({
              variantId: variantOpened.ref.id,
              variantRev: variantOpened.ref.rev,
              baseId: baseOpened.ref.id,
              edgeRef,
            });
          }
        }
      } else {
        const fact = await access.read.fact(id, { mode: 'following' });
        if (fact.type !== workspaceEntryType) continue;
        if (access.verifyLegacyBasis && !await access.verifyLegacyBasis(id, fact)) continue;
        const value = record(fact.value);
        const links = Array.isArray(value.links) ? value.links.filter((item): item is string => typeof item === 'string') : [];
        if (value.kind !== 'relation' || links.length !== 2) continue;
        const fromId = aliasToCanonical.get(factId(links[0]!)) ?? factId(links[0]!);
        const toId = aliasToCanonical.get(factId(links[1]!)) ?? factId(links[1]!);
        if (!nodeMap.has(fromId) || !nodeMap.has(toId) || seenEdges.has(fact.ref.id)) continue;
        seenEdges.add(fact.ref.id);
        edges.push({
          id: fact.ref.id, rev: fact.ref.rev, kind: 'related_to',
          fromId, toId, scope: 'workspace', verified: false, verificationMethod: null,
          confidence: null, sourceRefs: [],
        });
      }
    } catch (error) {
      if (!isUnavailable(access, error)) throw error;
    }
  }

  for (const row of legacyLinkRows.rows) {
    const id = factId(row.id);
    try {
      const fact = await access.read.fact(id, { mode: 'following' });
      if (fact.type !== workspaceEntryType) continue;
      if (access.verifyLegacyBasis && !await access.verifyLegacyBasis(id, fact)) continue;
      const value = record(fact.value);
      const kind = value.kind;
      if (kind !== 'question' && kind !== 'page') continue;
      const links = Array.isArray(value.links) ? value.links.filter((item): item is string => typeof item === 'string') : [];
      for (const link of links) {
        const target = aliasToCanonical.get(factId(link)) ?? factId(link);
        if (!nodeMap.has(target)) continue;
        const bucket = ensureCounts(target);
        if (kind === 'question') {
          bucket.questions.add(fact.ref.id);
          questionConceptLinks.push({
            questionId: fact.ref.id, questionRev: fact.ref.rev, conceptId: target,
            edgeRef: { id: fact.ref.id, rev: fact.ref.rev, type: workspaceEntryType },
          });
        } else {
          bucket.notes.add(`${fact.ref.id}#`);
        }
      }
    } catch (error) {
      if (!isUnavailable(access, error)) throw error;
    }
  }

  // One-hop variant_of concept inheritance: a variant question linked via an authorized
  // variant_of edge inherits its base question's direct concept links without chaining
  // further variant hops or duplicating existing direct links.
  if (variantQuestionLinks.length > 0 && questionConceptLinks.length > 0) {
    const directConceptsByQuestion = new Map<FactId, Set<FactId>>();
    const seenQuestionConcept = new Set<string>();
    for (const link of questionConceptLinks) {
      seenQuestionConcept.add(`${link.questionId}:${link.conceptId}`);
      let concepts = directConceptsByQuestion.get(link.questionId);
      if (!concepts) {
        concepts = new Set<FactId>();
        directConceptsByQuestion.set(link.questionId, concepts);
      }
      concepts.add(link.conceptId);
    }
    for (const { variantId, variantRev, baseId, edgeRef } of variantQuestionLinks) {
      const inheritedConcepts = directConceptsByQuestion.get(baseId);
      if (!inheritedConcepts) continue;
      for (const conceptId of inheritedConcepts) {
        const key = `${variantId}:${conceptId}`;
        if (seenQuestionConcept.has(key)) continue;
        seenQuestionConcept.add(key);
        ensureCounts(conceptId).questions.add(variantId);
        questionConceptLinks.push({ questionId: variantId, questionRev: variantRev, conceptId, edgeRef });
      }
    }
  }

  const pendingProposals: KnowledgeGraphProposal[] = [];
  for (const row of proposalRows.rows) {
    try {
      if (row.type === createKnowledgeEdgeCommand) {
        const { edge } = parseEdgeWrite(row.input);
        const opened = await verifyKnowledgeEdge(access, edge);
        let notionOk = true;
        for (const fact of opened) {
          if (!await verifyNotion(access, fact)) { notionOk = false; break; }
        }
        if (!notionOk) continue;
        const byKey = new Map(opened.map(fact => [knowledgeUseKey({
          id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch,
        }), fact]));
        const fromFact = byKey.get(knowledgeUseKey(edge.from.sourceUse));
        const toFact = byKey.get(knowledgeUseKey(edge.to.sourceUse));
        if (!fromFact || !toFact || knowledgeEndpointKind(fromFact) !== edge.from.kind || knowledgeEndpointKind(toFact) !== edge.to.kind) continue;
        const fromId = aliasToCanonical.get(fromFact.ref.id) ?? fromFact.ref.id;
        const toId = aliasToCanonical.get(toFact.ref.id) ?? toFact.ref.id;
        const fromTitle = factTitle(fromFact);
        const toTitle = factTitle(toFact);
        pendingProposals.push({
          proposalId: row.id, commandType: row.type, status: 'pending', createdTick: row.createdTick,
          edgeKind: edge.kind, scope: edge.scope, fromId, fromTitle, toId, toTitle,
          summary: `${fromTitle} --(${edge.kind})--> ${toTitle}`,
          actions: {
            accept: { method: 'POST', path: `/api/workspace/relations/proposals/${row.id}`, body: { decision: 'accept' } },
            reject: { method: 'POST', path: `/api/workspace/relations/proposals/${row.id}`, body: { decision: 'reject' } },
          },
        });
      } else if (row.type === evolveGraphCommand) {
        const evolution = parseGraphEvolution(row.input);
        if (evolution.action === 'merge') {
          const [from, to] = await Promise.all([
            openKnowledgeEntity(access.read, evolution.id),
            openKnowledgeEntity(access.read, evolution.into),
          ]);
          pendingProposals.push({
            proposalId: row.id, commandType: row.type, status: 'pending', createdTick: row.createdTick,
            fromId: from.snapshot.ref.id, fromTitle: from.entity.canonicalName,
            toId: to.snapshot.ref.id, toTitle: to.entity.canonicalName,
            summary: `合并概念：${from.entity.canonicalName} → ${to.entity.canonicalName}`,
          });
        } else {
          const target = await openKnowledgeEntity(access.read, evolution.id);
          for (const child of evolution.children) {
            for (const use of child.sources) await readKnowledgeUse(access, use);
          }
          pendingProposals.push({
            proposalId: row.id, commandType: row.type, status: 'pending', createdTick: row.createdTick,
            targetId: target.snapshot.ref.id,
            summary: `拆分概念：${target.entity.canonicalName} → ${evolution.children.map(c => c.entity.canonicalName).join('、')}`,
          });
        }
      } else if (row.type === createEntityCommand) {
        const parsed = parseCreateKnowledgeEntity(row.input);
        for (const use of parsed.sources) {
          const src = await readKnowledgeUse(access, use);
          if (!await verifyNotion(access, src)) throw new KnowledgeEdgeBasisError('Notion 依据不可用。');
        }
        pendingProposals.push({
          proposalId: row.id, commandType: row.type, status: 'pending', createdTick: row.createdTick,
          targetId: parsed.id, summary: `新建概念：${parsed.entity.canonicalName}`,
        });
      } else if (row.type === mergeEntityCommand) {
        const parsed = parseMergeKnowledgeEntity(row.input);
        const [from, to] = await Promise.all([
          openKnowledgeEntity(access.read, parsed.id),
          openKnowledgeEntity(access.read, parsed.into),
        ]);
        pendingProposals.push({
          proposalId: row.id, commandType: row.type, status: 'pending', createdTick: row.createdTick,
          fromId: from.snapshot.ref.id, fromTitle: from.entity.canonicalName,
          toId: to.snapshot.ref.id, toTitle: to.entity.canonicalName,
          summary: `合并概念：${from.entity.canonicalName} → ${to.entity.canonicalName}`,
        });
      }
    } catch (error) {
      if (!isUnavailable(access, error)) {
        if (error instanceof Error && /无效|缺少|冲突|合并|拆分/.test(error.message)) continue;
        throw error;
      }
    }
  }

  const nodes = [...nodeMap.values()]
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    .map(node => {
      const bucket = ensureCounts(node.id);
      return {
        ...node,
        counts: {
          questions: bucket.questions.size,
          textbooks: bucket.textbooks.size,
          notes: bucket.notes.size,
          notionBlocks: bucket.notionBlocks.size,
        },
      };
    });

  edges.sort((left, right) => left.id.localeCompare(right.id));
  return { nodes, edges, pendingProposals, questionConceptLinks };
}

export function composeKnowledgeGraphResponse(
  asOf: string,
  graph: Pick<AuthorizedKnowledgeGraph, 'nodes' | 'edges' | 'pendingProposals'>,
  masteryByConcept: ReadonlyMap<FactId, KnowledgeGraphMastery>,
): KnowledgeGraphResponse {
  return {
    asOf,
    nodes: graph.nodes.map(node => ({
      ...node,
      mastery: masteryByConcept.get(node.id) ?? defaultUnknownMastery,
    })),
    edges: graph.edges,
    pendingProposals: graph.pendingProposals,
  };
}

export async function openPendingTextbookProposal(
  read: KnowledgeReadAccess['read'],
  input: unknown,
  isUnavailableError: (error: unknown) => boolean,
) {
  try {
    const edit = parseTextbookRevision(input);
    const pageFact = await read.fact(edit.id, { mode: 'following' });
    if (pageFact.type !== textbookPageType) return undefined;
    const page = textbookPageFrom(pageFact);
    if (page.archived) return undefined;
    await checkTextbookBasis(read, page.basis ?? []);
    return { pageId: pageFact.ref.id, title: page.title, blockCount: edit.edits.length };
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof AssetBasisError || isUnavailableError(error)) return undefined;
    if (error instanceof Error && /无效|缺少|冲突|版本/.test(error.message)) return undefined;
    throw error;
  }
}
