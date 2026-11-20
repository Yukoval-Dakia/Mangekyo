import { factId, type Edge, type FactId, type FactSnapshot, type Revision, type Tick } from '@mangekyo/kernel';
import { assetType, checkTextbookBasis, openAssetReference, parseAsset, type AssetReadContext } from './asset.ts';
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

export function knowledgeEndpointKind(fact: FactSnapshot): KnowledgeEndpointKind | undefined {
  if (fact.type === workspaceEntryType || fact.type === assetType) {
    const { kind } = record(fact.value);
    switch (kind) {
      case 'concept': case 'question': case 'method': case 'archetype': return kind;
      case 'textbook': return 'chapter';
      case 'capture': return 'source';
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

export function parseKnowledgeEdge(input: unknown): KnowledgeEdge {
  const value = record(input);
  fields(value, 'kind', 'from', 'to', 'sourceUses', 'scope', 'variant', 'verification', 'confidence');
  const kind = knowledgeEdgeKinds.find(candidate => candidate === value.kind);
  if (!kind) throw new Error('知识边类型无效。');
  const from = endpointInput(value.from);
  const to = endpointInput(value.to);
  const sourceUses = list(value.sourceUses).map(sourceUse);
  const scope = text(value.scope, '适用范围').trim();
  if (!sourceUses.length || sourceUses.length > 32 || scope.length > 1000) throw new Error('知识边的来源或适用范围无效。');
  const seen = new Set(sourceUses.map(knowledgeUseKey));
  if (seen.size !== sourceUses.length) throw new Error('来源使用见证不能重复。');
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
  const confidence = value.confidence;
  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error('知识边置信度须在 0–1 之间。');
  }
  return {
    kind,
    from,
    to,
    sourceUses,
    scope,
    ...(confidence === undefined ? {} : { confidence }),
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

export async function readKnowledgeUse(ctx: AssetReadContext, use: KnowledgeSourceUse): Promise<FactSnapshot> {
  const fact = await ctx.read.fact(use.id, { mode: 'pinned', rev: use.rev });
  if (fact.ref.learner !== ctx.learner || fact.accessEpoch !== use.accessEpoch) {
    throw new KnowledgeEdgeBasisError('来源访问代次已经变化。');
  }
  return fact;
}

export function parseEdgeClaim(value: unknown): KnowledgeEdge {
  const edge = parseKnowledgeEdge(value);
  if (edge.verification) throw new Error('边的核验证明由确认命令填写。');
  return edge;
}

export function parseEdgeWrite(input: unknown): { id: FactId; purpose: 'storage' | 'teaching'; edge: KnowledgeEdge } {
  const value = record(input);
  const purpose = value.purpose ?? 'storage';
  if (purpose !== 'storage' && purpose !== 'teaching') throw new Error('知识边用途无效。');
  return { id: pageId(value.id), purpose, edge: parseEdgeClaim(value.edge) };
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

/** Opens only the edge candidates enumerated by the authorized bus query. */
export async function walkKnowledgeEdges(ctx: AssetReadContext, input: {
  readonly root: KnowledgeEndpoint;
  readonly edgeIds: readonly FactId[];
  readonly mode: 'following' | 'pinned';
  readonly hops: 1 | 2;
  readonly direction?: 'inbound' | 'outbound' | 'both';
  readonly acceptEdge?: (edge: KnowledgeEdge) => boolean;
  readonly uniquePaths?: boolean;
  readonly unavailable?: (error: unknown) => boolean;
}) {
  if (input.edgeIds.length > 128 || (input.hops !== 1 && input.hops !== 2)) throw new Error('图谱展开超过上限。');
  const root = await readKnowledgeUse(ctx, input.root.sourceUse);
  if (knowledgeEndpointKind(root) !== input.root.kind) throw new KnowledgeEdgeBasisError('图谱起点类型不符。');
  async function project(endpoint: KnowledgeEndpoint, fact: FactSnapshot) {
    if (endpoint.blockId) await openAssetReference(ctx.read, {
      fact: fact.ref, type: fact.type, anchor: { kind: 'block', blockId: endpoint.blockId },
    });
    if (fact.type === assetType) await checkTextbookBasis(ctx.read, parseAsset(fact.value).basis ?? []);
    if (input.mode !== 'following' || fact.type !== assetType ||
        (endpoint.kind !== 'concept' && endpoint.kind !== 'method' && endpoint.kind !== 'archetype')) return endpoint;
    const canonical = await openKnowledgeEntity(ctx.read, fact.ref.id);
    return { ...endpoint, sourceUse: {
      id: canonical.snapshot.ref.id, rev: canonical.snapshot.ref.rev, accessEpoch: canonical.snapshot.accessEpoch,
    } };
  }
  const projectedRoot = await project(input.root, root);
  const nodeKey = (endpoint: KnowledgeEndpoint) => JSON.stringify([endpoint.sourceUse.id, endpoint.sourceUse.rev, endpoint.blockId ?? null]);
  async function openEdge(id: FactId) {
    try {
      const fact = await ctx.read.fact(id, { mode: 'following' });
      if (fact.type !== knowledgeEdgeType) throw new KnowledgeEdgeBasisError('图谱边类型不符。');
      let edge;
      try {
        edge = parseKnowledgeEdge(fact.value);
      } catch (error) {
        if (!input.unavailable) throw error;
        throw new KnowledgeEdgeBasisError('候选知识边不符合关系契约。', { cause: error });
      }
      if (input.acceptEdge && !input.acceptEdge(edge)) return undefined;
      const basis = await verifyKnowledgeEdge(ctx, edge);
      if (edge.verification) {
        const { verification, ...claim } = edge;
        const proof = await readKnowledgeUse(ctx, verification);
        if (!matchingKnowledgeEdgeEvidence(proof, claim)) throw new KnowledgeEdgeBasisError('图谱核验证据失效。');
      }
      const snapshots = new Map(basis.map(source => [knowledgeUseKey({
        id: source.ref.id, rev: source.ref.rev, accessEpoch: source.accessEpoch,
      }), source]));
      const endpoint = (end: KnowledgeEndpoint) => {
        const snapshot = snapshots.get(knowledgeUseKey(end.sourceUse));
        if (!snapshot) throw new KnowledgeEdgeBasisError('图谱端点依据缺失。');
        return project(end, snapshot);
      };
      return { ref: fact.ref, accessEpoch: fact.accessEpoch, edge, from: await endpoint(edge.from), to: await endpoint(edge.to) };
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
  const facts = await verifyKnowledgeEdge(ctx, edge);
  const basis = facts.map(({ ref, type, accessEpoch }) => ({ ...ref, type, accessEpoch, mode: 'pinned' as const }));
  if (edge.verification) {
    const { verification, ...claim } = edge;
    const proof = await readKnowledgeUse(ctx, verification);
    if (!matchingKnowledgeEdgeEvidence(proof, claim)) throw new KnowledgeEdgeBasisError('图谱核验证据失效。');
    basis.push({ ...proof.ref, type: proof.type, accessEpoch: proof.accessEpoch, mode: 'pinned' });
  }
  return { ...revision, from_ref: edge.from, to_ref: edge.to, kind: edge.kind, basis, confidence: edge.confidence ?? null };
}

/** Direction names refer to the original from/to endpoints. Unknown exposure is ineligible. */
export function canUseDistinguishingVariant(edge: KnowledgeEdge, previous: FactId, exposure: 'unseen' | 'solution_seen' | 'unknown') {
  const relation = edge.variant;
  if (edge.kind !== 'variant_of' || relation?.relation !== 'single_condition' || exposure === 'unknown') return false;
  if (edge.from.sourceUse.id !== previous && edge.to.sourceUse.id !== previous) return false;
  if (exposure === 'unseen') return true;
  const nextIsFormer = edge.to.sourceUse.id === previous;
  return relation.spoilsNext === 'none' || (nextIsFormer ? relation.spoilsNext === 'latter' : relation.spoilsNext === 'former');
}
