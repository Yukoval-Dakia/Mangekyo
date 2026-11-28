import { FactNotFoundError, factId, type Edge, type FactId, type FactSnapshot, type Revision, type Tick } from '@mangekyo/kernel';
import { assetType, checkTextbookBasis, isPurposeWidenedContinuation, openAssetReference, parseAsset, type AssetReadContext } from './asset.ts';
import { pushMapValue } from './content-guard.ts';
import { openKnowledgeEntity } from './knowledge-entity.ts';
import { fields, key, list, pageId, record, revision, text } from './parse.ts';

export const knowledgeEdgeType = 'content.knowledgeEdge';
export const createKnowledgeEdgeCommand = 'content.createKnowledgeEdge';
export const createVerifiedKnowledgeEdgeCommand = 'content.createVerifiedKnowledgeEdge';
export const withdrawKnowledgeEdgeCommand = 'content.withdrawKnowledgeEdge';
export const knowledgeEdgeEvidenceType = 'content.knowledgeEdgeEvidence';
export const workspaceEntryType = 'activity.workspaceEntry';

export const knowledgeEdgeKinds = [
  'prereq_of',
  'part_of',
  'contrasts_with',
  'targets_concept',
  'variant_of',
  'derived_from',
  'explains',
  'addresses_pitfall',
  'supersedes',
  'prerequisite',
  'successor',
  'confusable',
  'transfer',
  'maps_to_chapter',
  'instance_of',
  'references',
  'supports',
  'contradicts',
  'related_to',
] as const;

export type KnowledgeEdgeKind = (typeof knowledgeEdgeKinds)[number];
export const prerequisiteDagEdgeKinds = ['prereq_of', 'prerequisite', 'successor', 'part_of'] as const;
export type PrerequisiteDagEdgeKind = (typeof prerequisiteDagEdgeKinds)[number];
const prerequisiteDagEdgeKindSet: ReadonlySet<string> = new Set(prerequisiteDagEdgeKinds);

export function isPrerequisiteDagEdgeKind(kind: KnowledgeEdgeKind): kind is PrerequisiteDagEdgeKind {
  return prerequisiteDagEdgeKindSet.has(kind);
}

const knowledgeEndpointKinds = ['concept', 'question', 'method', 'archetype', 'note', 'source', 'chapter', 'work', 'claim'] as const;
export type KnowledgeEndpointKind = (typeof knowledgeEndpointKinds)[number];

const endpointKindsByFactType: Readonly<Record<string, KnowledgeEndpointKind>> = {
  'content.textbookPage': 'chapter',
  'capture.source': 'source',
  'activity.intakeDocument': 'source',
  'activity.organizerNote': 'note',
  'activity.workbookAttempt': 'work',
  'activity.retentionPosttestSubmission': 'work',
  'activity.recallSubmission': 'work',
  'activity.studyRecord': 'work',
  'companion.claim': 'claim',
  'companion.memoryAssertion': 'claim',
};

export class KnowledgeEdgeBasisError extends Error {}
export class KnowledgeEdgeEvidenceError extends Error {}
export class KnowledgeEdgeCycleError extends Error {}

export function knowledgeEndpointKind(fact: FactSnapshot): KnowledgeEndpointKind | undefined {
  if (fact.type === workspaceEntryType || fact.type === assetType) {
    const { kind } = record(fact.value);
    switch (kind) {
      case 'concept': case 'question': case 'method': case 'archetype': return kind;
      case 'textbook': return 'chapter';
      case 'capture': case 'discipline': return 'source';
      case 'page': return 'note';
    }
    return undefined;
  }
  if (fact.type === 'capture.source' && record(fact.value).kind === 'notion') return 'note';
  return Object.hasOwn(endpointKindsByFactType, fact.type) ? endpointKindsByFactType[fact.type] : undefined;
}

export type KnowledgeSourceUse = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly accessEpoch: Tick;
};

export type KnowledgeVariant = {
  readonly familyId: string;
  readonly relation?: (typeof variantRelations)[number];
  readonly preserved: readonly string[];
  readonly changed: readonly string[];
  readonly spoilsNext: 'unknown' | 'none' | 'former' | 'latter';
};

const variantRelations = ['same_source', 'translation', 'numbers_only', 'single_condition', 'representation_transfer', 'confusable'] as const;
const spoilsNextValues = ['unknown', 'none', 'former', 'latter'] as const;

export type KnowledgeEdge = {
  readonly kind: KnowledgeEdgeKind;
  readonly from: KnowledgeEndpoint;
  readonly to: KnowledgeEndpoint;
  readonly sourceUses: readonly KnowledgeSourceUse[];
  readonly scope: string;
  readonly confidence?: number;
  readonly weight?: number;
  readonly variant?: KnowledgeVariant;
  readonly verification?: KnowledgeSourceUse;
};

export type KnowledgeEndpoint = {
  readonly kind: KnowledgeEndpointKind;
  readonly sourceUse: KnowledgeSourceUse;
  readonly blockId?: string;
};

export function sourceUse(input: unknown): KnowledgeSourceUse {
  const value = record(input);
  fields(value, 'id', 'rev', 'accessEpoch');
  return {
    id: factId(text(value.id, '来源标识')),
    rev: revision(value.rev),
    accessEpoch: tick(value.accessEpoch),
  };
}

function endpointInput(input: unknown): KnowledgeEndpoint {
  const value = record(input);
  fields(value, 'kind', 'sourceUse', 'blockId');
  const kind = knowledgeEndpointKinds.find(kind => kind === value.kind);
  if (!kind) throw new Error('知识边端点体裁无效。');
  return { kind, sourceUse: sourceUse(value.sourceUse),
    ...(value.blockId === undefined ? {} : { blockId: key(value.blockId) }) };

}

function variant(input: unknown): KnowledgeVariant {
  const value = record(input);
  fields(value, 'familyId', 'relation', 'preserved', 'changed', 'spoilsNext');
  const words = (items: unknown) => list(items).map(item => text(item, '变式条件'));
  const preserved = words(value.preserved);
  const changed = words(value.changed);
  const overlap = preserved.some(condition => changed.includes(condition));
  const spoilsNext = spoilsNextValues.find(value_ => value_ === value.spoilsNext);
  const relation = variantRelations.find(kind => value.relation === kind);
  if (!preserved.length || !changed.length || overlap || !spoilsNext ||
      (value.relation !== undefined && !relation) || (relation === 'single_condition' && changed.length !== 1)) {
    throw new Error('变式条件或 spoilsNext 方向无效。');
  }
  return {
    familyId: key(value.familyId),
    ...(relation ? { relation } : {}),
    preserved,
    changed,
    spoilsNext,
  };
}

function unitInterval(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label}须在 0–1 之间。`);
  }
  return value;
}

export function parseKnowledgeEdge(input: unknown): KnowledgeEdge {
  const value = record(input);
  fields(value, 'kind', 'from', 'to', 'sourceUses', 'scope', 'variant', 'verification', 'confidence', 'weight');
  // The relation tool's canonical_archetype name uses the existing question → archetype edge.
  const kind = value.kind === 'canonical_archetype' ? 'instance_of' : knowledgeEdgeKinds.find(candidate => candidate === value.kind);
  if (!kind) throw new Error('知识边类型无效。');
  const from = endpointInput(value.from);
  const to = endpointInput(value.to);
  const sourceUses = list(value.sourceUses).map(sourceUse);
  const scope = text(value.scope, '适用范围').trim();
  if (!sourceUses.length || sourceUses.length > 32 || scope.length > 1000) throw new Error('知识边的来源或适用范围无效。');
  const seen = new Set(sourceUses.map(knowledgeUseKey));
  if (seen.size !== sourceUses.length) throw new Error('来源使用见证不能重复。');
  if (isPrerequisiteDagEdgeKind(kind) && from.sourceUse.id === to.sourceUse.id) {
    throw new KnowledgeEdgeCycleError('知识边不能指向自身：先修有向边禁止自环。');
  }
  if (from.sourceUse.id === to.sourceUse.id && from.blockId === to.blockId) throw new Error('知识边不能指向自身。');
  if (!seen.has(knowledgeUseKey(from.sourceUse)) || !seen.has(knowledgeUseKey(to.sourceUse))) {
    throw new Error('每个端点必须来自实际来源使用见证。');
  }
  if (kind === 'variant_of') {
    if (from.kind !== 'question' || to.kind !== 'question' || value.variant === undefined) {
      throw new Error('变式边需要两道题及变式条件。');
    }
  } else if (value.variant !== undefined) {
    throw new Error('只有变式边可以保存变式条件。');
  }
  if (kind === 'targets_concept' && (from.kind !== 'question' || to.kind !== 'concept')) {
    throw new Error('考查关系由题目指向概念。');
  }
  if (kind === 'maps_to_chapter' && to.kind !== 'chapter') throw new Error('教材映射须指向固定章节版本。');
  if (kind === 'instance_of' && (from.kind !== 'question' || to.kind !== 'archetype')) {
    throw new Error('母题边由题目指向母题。');
  }
  const confidence = unitInterval(value.confidence, '知识边置信度');
  const weight = unitInterval(value.weight, '知识边权重');
  return {
    kind,
    from,
    to,
    sourceUses,
    scope,
    ...(confidence === undefined ? {} : { confidence }),
    ...(weight === undefined ? {} : { weight }),
    ...(value.variant === undefined ? {} : { variant: variant(value.variant) }),
    ...(value.verification === undefined ? {} : { verification: sourceUse(value.verification) }),
  };
}

function tick(value: unknown): Tick {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value) as Tick;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n) {
    return value as Tick;
  }
  throw new Error('来源访问代次无效。');
}

export async function verifyKnowledgeEdge(
  ctx: AssetReadContext,
  edge: KnowledgeEdge,
): Promise<readonly FactSnapshot[]> {
  const facts = new Map<string, FactSnapshot>();
  for (const use of edge.sourceUses) {
    facts.set(knowledgeUseKey(use), await readKnowledgeUse(ctx, use));
  }
  for (const value of [edge.from, edge.to]) {
    const fact = facts.get(knowledgeUseKey(value.sourceUse));
    if (!fact || knowledgeEndpointKind(fact) !== value.kind) {
      throw new KnowledgeEdgeBasisError('关系端点类型不符。');
    }
    if (fact.type === assetType) {
      await checkTextbookBasis(ctx.read, parseAsset(fact.value).basis ?? []);
    }
    if (value.blockId !== undefined) {
      await openAssetReference(ctx.read, {
        fact: fact.ref, type: fact.type, anchor: { kind: 'block', blockId: value.blockId },
      });
    }
  }
  return [...facts.values()];
}

export function knowledgeUseKey(use: KnowledgeSourceUse): string {
  return `${use.id}:${use.rev}:${use.accessEpoch}`;
}

export async function readKnowledgeUse(ctx: AssetReadContext, use: KnowledgeSourceUse, requirePurpose?: string): Promise<FactSnapshot> {
  const fact = await ctx.read.fact(use.id, { mode: 'pinned', rev: use.rev,
    ...(requirePurpose === undefined ? {} : { requirePurpose }) });
  if (fact.ref.learner !== ctx.learner || fact.ref.id !== use.id || fact.ref.rev !== use.rev) {
    throw new KnowledgeEdgeBasisError('来源访问代次已经变化。');
  }
  if (fact.accessEpoch !== use.accessEpoch) {
    // A pure monotone purpose widening (set_purpose) bumps rev and accessEpoch
    // together while keeping the data identical; follow the chain and reopen
    // the latest revision so downstream projections see the current endpoint.
    const widened = await isPurposeWidenedContinuation(ctx.read, fact, use.accessEpoch);
    if (!widened || (requirePurpose !== undefined && !widened.purpose.includes(requirePurpose) && !widened.purpose.includes('all'))) {
      throw new KnowledgeEdgeBasisError('来源访问代次已经变化。');
    }
    return widened;
  }
  return fact;
}

export function parseEdgeClaim(value: unknown): KnowledgeEdge {
  const edge = parseKnowledgeEdge(value);
  if (edge.verification) throw new Error('边的核验证明由确认命令填写。');
  return edge;
}

export type PrerequisiteDagEdgeInput =
  | Pick<KnowledgeEdge, 'kind' | 'from' | 'to'>
  | { readonly kind: KnowledgeEdgeKind; readonly fromId: FactId; readonly toId: FactId };

/** Enforce strict acyclicity (no self-loops or directed cycles) on the prerequisite DAG subgraph. */
export function assertPrerequisiteDag(
  edges: readonly PrerequisiteDagEdgeInput[],
  candidate?: PrerequisiteDagEdgeInput,
): void {
  const adjacency = new Map<FactId, FactId[]>();
  for (const entry of candidate ? [...edges, candidate] : edges) {
    if (!isPrerequisiteDagEdgeKind(entry.kind)) continue;
    const fromId = 'fromId' in entry ? entry.fromId : entry.from.sourceUse.id;
    const toId = 'toId' in entry ? entry.toId : entry.to.sourceUse.id;
    if (fromId === toId) throw new KnowledgeEdgeCycleError(`先修子图存在自环：${fromId}。`);
    pushMapValue(adjacency, fromId, toId);
  }
  const state = new Map<FactId, 1 | 2>();
  const stack: FactId[] = [];
  const stackPos = new Map<FactId, number>();
  const visit = (node: FactId) => {
    state.set(node, 1);
    stackPos.set(node, stack.length);
    stack.push(node);
    for (const target of adjacency.get(node) ?? []) {
      const targetState = state.get(target);
      if (targetState === 1) {
        throw new KnowledgeEdgeCycleError(`先修子图存在环路：${[...stack.slice(stackPos.get(target)!), target].join(' -> ')}。`);
      }
      if (targetState === undefined) visit(target);
    }
    stack.pop();
    stackPos.delete(node);
    state.set(node, 2);
  };
  for (const node of adjacency.keys()) if (state.get(node) === undefined) visit(node);
}

async function canonicalDagNodeId(ctx: AssetReadContext, endpoint: KnowledgeEndpoint): Promise<FactId> {
  if (endpoint.kind !== 'concept' && endpoint.kind !== 'method' && endpoint.kind !== 'archetype') return endpoint.sourceUse.id;
  try {
    const current = await ctx.read.fact(endpoint.sourceUse.id, { mode: 'following' });
    return current.type === assetType ? (await openKnowledgeEntity(ctx.read, current.ref.id)).snapshot.ref.id : endpoint.sourceUse.id;
  } catch (error) {
    if (error instanceof FactNotFoundError) return endpoint.sourceUse.id;
    throw error;
  }
}

/** Verify that persisting a prerequisite edge cannot create a direct, redirected, or multi-hop cycle. */
export async function verifyPrerequisiteEdgeDag(
  ctx: AssetReadContext, candidate: KnowledgeEdge, existingEdgeIds: readonly FactId[] = [],
): Promise<void> {
  if (!isPrerequisiteDagEdgeKind(candidate.kind)) return;
  const projected: PrerequisiteDagEdgeInput = {
    kind: candidate.kind,
    fromId: await canonicalDagNodeId(ctx, candidate.from),
    toId: await canonicalDagNodeId(ctx, candidate.to),
  };
  const candidateIds = new Set<FactId>(existingEdgeIds);
  for (const use of candidate.sourceUses) {
    if (use.id === candidate.from.sourceUse.id || use.id === candidate.to.sourceUse.id) continue;
    try {
      if ((await ctx.read.fact(use.id, { mode: 'pinned', rev: use.rev })).type === knowledgeEdgeType) candidateIds.add(use.id);
    } catch (error) {
      if (!(error instanceof FactNotFoundError)) throw error;
    }
  }
  const existing: PrerequisiteDagEdgeInput[] = [];
  for (const edgeId of candidateIds) {
    try {
      const { edge } = await openKnowledgeEdgeRevision(ctx, edgeId, { mode: 'following' });
      if (isPrerequisiteDagEdgeKind(edge.kind)) existing.push(edge);
    } catch (error) {
      if (!(error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError)) throw error;
    }
  }
  assertPrerequisiteDag(existing, projected);
}

export function parseEdgeWrite(input: unknown): {
  id: FactId; purpose: 'storage' | 'teaching'; edge: KnowledgeEdge; existingPrerequisiteEdgeIds?: readonly FactId[];
} {
  const value = record(input);
  const purpose = value.purpose ?? 'storage';
  if (purpose !== 'storage' && purpose !== 'teaching') throw new Error('知识边用途无效。');
  const existingPrerequisiteEdgeIds = value.existingPrerequisiteEdgeIds === undefined
    ? undefined : list(value.existingPrerequisiteEdgeIds).map(pageId);
  if (existingPrerequisiteEdgeIds && existingPrerequisiteEdgeIds.length > 128) throw new Error('已有先修边校验集合超过上限。');
  return {
    id: pageId(value.id), purpose, edge: parseEdgeClaim(value.edge),
    ...(existingPrerequisiteEdgeIds === undefined ? {} : { existingPrerequisiteEdgeIds }),
  };
}

export function parseEdgeEvidence(input: unknown) {
  const value = record(input);
  fields(value, 'method', 'edge');
  if (value.method !== 'trusted_source' && value.method !== 'independent_check') throw new Error('核验方式无效。');
  return { method: value.method, edge: parseEdgeClaim(value.edge) };
}

export function matchingKnowledgeEdgeEvidence(proof: FactSnapshot, claim: KnowledgeEdge) {
  if (proof.type !== knowledgeEdgeEvidenceType) return undefined;
  const evidence = parseEdgeEvidence(proof.value);
  const normalize = (value: KnowledgeEdge) => ({
    ...value, sourceUses: value.sourceUses.map(knowledgeUseKey).sort(),
  });
  return JSON.stringify(normalize(evidence.edge)) === JSON.stringify(normalize(claim)) ? evidence : undefined;
}

export function edgePurposes(purpose: 'storage' | 'teaching', sources: readonly FactSnapshot[]): string[] {
  if (purpose === 'storage') return ['storage'];
  if (!sources.every(source => source.purpose.includes('teaching') || source.purpose.includes('all'))) {
    throw new Error('知识边的来源未授权教学用途。');
  }
  return ['storage', 'teaching'];
}

async function verifiedEdgeBasis(ctx: AssetReadContext, edge: KnowledgeEdge) {
  const facts = await verifyKnowledgeEdge(ctx, edge);
  if (!edge.verification) return facts;
  const { verification, ...claim } = edge;
  const proof = await readKnowledgeUse(ctx, verification);
  if (!matchingKnowledgeEdgeEvidence(proof, claim)) throw new KnowledgeEdgeBasisError('图谱核验证据失效。');
  return [...facts, proof];
}

async function projectKnowledgeEndpoint(ctx: AssetReadContext, endpoint: KnowledgeEndpoint, fact: FactSnapshot) {
  if (fact.type !== assetType ||
      (endpoint.kind !== 'concept' && endpoint.kind !== 'method' && endpoint.kind !== 'archetype')) return endpoint;
  const { snapshot, entity } = await openKnowledgeEntity(ctx.read, fact.ref.id);
  if (entity.kind !== endpoint.kind || snapshot.ref.learner !== ctx.learner ||
      (endpoint.blockId !== undefined && (snapshot.ref.id !== fact.ref.id || snapshot.ref.rev !== fact.ref.rev))) {
    throw new KnowledgeEdgeBasisError('图谱端点重定向后类型或锚点不再有效。');
  }
  return { ...endpoint, sourceUse: { id: snapshot.ref.id, rev: snapshot.ref.rev, accessEpoch: snapshot.accessEpoch } };
}

async function projectKnowledgeEdge(ctx: AssetReadContext, edge: KnowledgeEdge, basis: readonly FactSnapshot[]) {
  const project = (endpoint: KnowledgeEndpoint) => projectKnowledgeEndpoint(ctx, endpoint,
    basis.find(fact => fact.ref.id === endpoint.sourceUse.id && fact.ref.rev === endpoint.sourceUse.rev) ??
    basis.find(fact => fact.ref.id === endpoint.sourceUse.id && fact.ref.rev > endpoint.sourceUse.rev)!);
  return { ...edge, from: await project(edge.from), to: await project(edge.to) };
}

export async function openKnowledgeWalkRoot(ctx: AssetReadContext, endpoint: KnowledgeEndpoint, mode: 'following' | 'pinned') {
  const root = await readKnowledgeUse(ctx, endpoint.sourceUse);
  if (knowledgeEndpointKind(root) !== endpoint.kind) throw new KnowledgeEdgeBasisError('图谱起点类型不符。');
  if (endpoint.blockId) await openAssetReference(ctx.read, {
    fact: root.ref, type: root.type, anchor: { kind: 'block', blockId: endpoint.blockId },
  });
  if (root.type === assetType) await checkTextbookBasis(ctx.read, parseAsset(root.value).basis ?? []);
  return mode === 'following' ? projectKnowledgeEndpoint(ctx, endpoint, root) : endpoint;
}

export async function openKnowledgeWalkEdge(ctx: AssetReadContext, id: FactId, input: {
  readonly mode: 'following' | 'pinned';
  readonly acceptEdge?: (edge: KnowledgeEdge) => boolean;
  readonly classifyMalformed?: boolean;
}) {
  const fact = await ctx.read.fact(id, { mode: 'following' });
  if (fact.type !== knowledgeEdgeType) throw new KnowledgeEdgeBasisError('图谱边类型不符。');
  let edge;
  try {
    edge = parseKnowledgeEdge(fact.value);
  } catch (error) {
    if (!input.classifyMalformed) throw error;
    throw new KnowledgeEdgeBasisError('候选知识边不符合关系契约。', { cause: error });
  }
  if (input.acceptEdge && !input.acceptEdge(edge)) return undefined;
  const basis = await verifiedEdgeBasis(ctx, edge);
  return { fact, original: edge, projected: input.mode === 'following' ? await projectKnowledgeEdge(ctx, edge, basis) : edge };
}

/** Opens only the edge candidates enumerated by the authorized bus query. */
export async function walkKnowledgeEdges(ctx: AssetReadContext, input: {
  readonly root: KnowledgeEndpoint;
  readonly edgeIds: readonly FactId[];
  readonly mode: 'following' | 'pinned';
  readonly hops: 1 | 2;
  readonly direction?: 'inbound' | 'outbound' | 'both';
  readonly acceptEdge?: (edge: KnowledgeEdge) => boolean;
  /** Match an authorized pinned endpoint to the current root after checking continuity. */
  readonly reopenFollowingRootAlias?: (endpoint: KnowledgeEndpoint) => Promise<boolean>;
  readonly uniquePaths?: boolean;
  readonly unavailable?: (error: unknown) => boolean;
}) {
  if (input.edgeIds.length > 128 || (input.hops !== 1 && input.hops !== 2)) throw new Error('图谱展开超过上限。');
  const projectedRoot = await openKnowledgeWalkRoot(ctx, input.root, input.mode);
  const following = input.mode === 'following';
  const nodeKey = (endpoint: KnowledgeEndpoint) => JSON.stringify([endpoint.sourceUse.id, endpoint.sourceUse.rev, endpoint.blockId ?? null]);
  async function openEdge(id: FactId) {
    try {
      const opened = await openKnowledgeWalkEdge(ctx, id, {
        mode: input.mode, classifyMalformed: Boolean(input.unavailable),
        ...(input.acceptEdge ? { acceptEdge: input.acceptEdge } : {}),
      });
      if (!opened) return undefined;
      const { fact, original, projected } = opened;
      const from = following && await input.reopenFollowingRootAlias?.(original.from) ? projectedRoot : projected.from;
      const to = following && await input.reopenFollowingRootAlias?.(original.to) ? projectedRoot : projected.to;
      return { ref: fact.ref, accessEpoch: fact.accessEpoch, edge: { ...projected, from, to }, from, to };
    } catch (error) {
      if (input.unavailable?.(error)) return undefined;
      throw error;
    }
  }
  const rows = [];
  for (const id of new Set(input.edgeIds)) {
    const row = await openEdge(id);
    if (row) rows.push(row);
  }
  type Step = {
    endpoint: KnowledgeEndpoint; hop: number; via: FactSnapshot['ref']; edge: KnowledgeEdge;
    trail: readonly { readonly edge: KnowledgeSourceUse; readonly endpoint: KnowledgeEndpoint }[];
  };
  const start = nodeKey(projectedRoot);
  const visited = new Set([start]);
  let frontier = new Map<string, Step['trail']>([[start, []]]);
  const paths: Step[] = [];
  for (let hop = 1; hop <= input.hops && frontier.size; hop++) {
    const matches = new Map<string, Step | null>();
    for (const row of rows) {
      const forward = input.direction !== 'inbound' ? frontier.get(nodeKey(row.from)) : undefined;
      const reverse = input.direction !== 'outbound' ? frontier.get(nodeKey(row.to)) : undefined;
      const edgeUse = { id: row.ref.id, rev: row.ref.rev, accessEpoch: row.accessEpoch };
      const steps = [
        ...(forward ? [{ endpoint: row.to, prior: forward }] : []),
        ...(reverse ? [{ endpoint: row.from, prior: reverse }] : []),
      ];
      for (const { endpoint, prior } of steps) {
        const key = nodeKey(endpoint);
        if (visited.has(key)) continue;
        if (matches.has(key)) {
          if (input.uniquePaths) matches.set(key, null);
          continue;
        }
        matches.set(key, {
          endpoint, hop, via: row.ref, edge: row.edge, trail: [...prior, { edge: edgeUse, endpoint }],
        });
      }
    }
    frontier = new Map();
    for (const [key, step] of matches) {
      visited.add(key);
      if (!step) continue;
      paths.push(step);
      frontier.set(key, step.trail);
    }
  }
  return { root: projectedRoot, paths };
}

/** Adapt the existing row to the unified bus shape without persisting a second edge. */
export async function openBusKnowledgeEdge(
  ctx: AssetReadContext, edge: KnowledgeEdge,
  revision: Pick<Edge<KnowledgeEndpoint, KnowledgeEdgeKind>, 'author' | 'sticky'>,
): Promise<Edge<KnowledgeEndpoint, KnowledgeEdgeKind>> {
  const facts = await verifiedEdgeBasis(ctx, edge);
  const basis = facts.map(({ ref, type, accessEpoch }) => ({ ...ref, type, accessEpoch, mode: 'pinned' as const }));
  return { ...revision, from_ref: edge.from, to_ref: edge.to, kind: edge.kind, basis, confidence: edge.confidence ?? null };
}

/** Following projects canonical endpoints. The snapshot and evidence keep their recorded identities. */
export async function openKnowledgeEdgeRevision(
  ctx: AssetReadContext, id: FactId, options: Parameters<AssetReadContext['read']['fact']>[1],
) {
  const snapshot = await ctx.read.fact(id, options);
  if (snapshot.type !== knowledgeEdgeType) throw new KnowledgeEdgeBasisError('图谱边类型不符。');
  const edge = parseKnowledgeEdge(snapshot.value);
  const basis = await verifiedEdgeBasis(ctx, edge);
  const projected = options.mode === 'following' ? await projectKnowledgeEdge(ctx, edge, basis) : edge;
  if (projected.from.sourceUse.id === projected.to.sourceUse.id && projected.from.blockId === projected.to.blockId) {
    throw new KnowledgeEdgeBasisError('图谱边的两端已合并为同一实体。');
  }
  return { snapshot, edge: projected };
}

/** Direction names refer to the original from/to endpoints. Unknown exposure is ineligible. */
export function canUseDistinguishingVariant(edge: KnowledgeEdge, previous: FactId, exposure: 'unseen' | 'solution_seen' | 'unknown',
  requiredRelation: 'single_condition' | 'numbers_only' = 'single_condition') {
  const relation = edge.variant;
  if (edge.kind !== 'variant_of' || relation?.relation !== requiredRelation || exposure === 'unknown') return false;
  if (edge.from.sourceUse.id !== previous && edge.to.sourceUse.id !== previous) return false;
  if (exposure === 'unseen') return true;
  const nextIsFormer = edge.to.sourceUse.id === previous;
  return relation.spoilsNext === 'none' || (nextIsFormer ? relation.spoilsNext === 'latter' : relation.spoilsNext === 'former');
}
