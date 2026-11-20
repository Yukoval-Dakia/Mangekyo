import { factId, type CommandContext, type FactId, type FactSnapshot, type Revision, type Tick } from '@mangekyo/kernel';
import { fields, key, list, pageId, record, revision, text } from './parse.ts';

export const knowledgeEdgeType = 'content.knowledgeEdge';
export const createKnowledgeEdgeCommand = 'content.createKnowledgeEdge';
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
] as const;

export type KnowledgeEdgeKind = (typeof knowledgeEdgeKinds)[number];

export type KnowledgeEndpointKind = 'concept' | 'question';

export type KnowledgeSourceUse = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly accessEpoch: Tick;
};

export type KnowledgeVariant = {
  readonly familyId: string;
  readonly preserved: readonly string[];
  readonly changed: readonly string[];
  readonly spoilsNext: 'unknown' | 'none' | 'former' | 'latter';
};

const spoilsNextValues = ['unknown', 'none', 'former', 'latter'] as const;

export type KnowledgeEdge = {
  readonly kind: KnowledgeEdgeKind;
  readonly from: KnowledgeEndpoint;
  readonly to: KnowledgeEndpoint;
  readonly sourceUses: readonly KnowledgeSourceUse[];
  readonly scope: string;
  readonly variant?: KnowledgeVariant;
  readonly verification?: KnowledgeSourceUse;
};

export type KnowledgeEndpoint = {
  readonly kind: KnowledgeEndpointKind;
  readonly sourceUse: KnowledgeSourceUse;
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
  fields(value, 'kind', 'sourceUse');
  if (value.kind !== 'concept' && value.kind !== 'question') throw new Error('知识边端点体裁无效。');
  const kind = value.kind;
  return { kind, sourceUse: sourceUse(value.sourceUse) };
}

function variant(input: unknown): KnowledgeVariant {
  const value = record(input);
  fields(value, 'familyId', 'preserved', 'changed', 'spoilsNext');
  const words = (items: unknown) => list(items).map(item => text(item, '变式条件'));
  const preserved = words(value.preserved);
  const changed = words(value.changed);
  const overlap = preserved.some(condition => changed.includes(condition));
  const spoilsNext = spoilsNextValues.find(value_ => value_ === value.spoilsNext);
  if (!preserved.length || !changed.length || overlap || !spoilsNext) {
    throw new Error('变式条件或 spoilsNext 方向无效。');
  }
  return {
    familyId: key(value.familyId),
    preserved,
    changed,
    spoilsNext,
  };
}

export function parseKnowledgeEdge(input: unknown): KnowledgeEdge {
  const value = record(input);
  fields(value, 'kind', 'from', 'to', 'sourceUses', 'scope', 'variant', 'verification');
  const kind = knowledgeEdgeKinds.find(candidate => candidate === value.kind);
  if (!kind) throw new Error('知识边类型无效。');
  const from = endpointInput(value.from);
  const to = endpointInput(value.to);
  const sourceUses = list(value.sourceUses).map(sourceUse);
  const scope = text(value.scope, '适用范围').trim();
  if (!sourceUses.length || sourceUses.length > 32 || scope.length > 1000) throw new Error('知识边的来源或适用范围无效。');
  const seen = new Set(sourceUses.map(knowledgeUseKey));
  if (seen.size !== sourceUses.length) throw new Error('来源使用见证不能重复。');
  if (from.sourceUse.id === to.sourceUse.id) throw new Error('知识边不能指向自身。');
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
  return {
    kind,
    from,
    to,
    sourceUses,
    scope,
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
  ctx: CommandContext,
  edge: KnowledgeEdge,
): Promise<readonly FactSnapshot[]> {
  const facts = new Map<string, FactSnapshot>();
  for (const use of edge.sourceUses) {
    facts.set(knowledgeUseKey(use), await readKnowledgeUse(ctx, use));
  }
  for (const value of [edge.from, edge.to]) {
    const fact = facts.get(knowledgeUseKey(value.sourceUse));
    if (fact?.type !== workspaceEntryType || record(fact.value).kind !== value.kind) {
      throw new Error('概念或题目端点类型不符。');
    }
  }
  return [...facts.values()];
}

export function knowledgeUseKey(use: KnowledgeSourceUse): string {
  return `${use.id}:${use.rev}:${use.accessEpoch}`;
}

export async function readKnowledgeUse(ctx: CommandContext, use: KnowledgeSourceUse): Promise<FactSnapshot> {
  const fact = await ctx.read.fact(use.id, { mode: 'pinned', rev: use.rev });
  if (fact.ref.learner !== ctx.learner || fact.accessEpoch !== use.accessEpoch) {
    throw new Error('来源访问代次已经变化。');
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

export function edgePurposes(purpose: 'storage' | 'teaching', sources: readonly FactSnapshot[]): string[] {
  if (purpose === 'storage') return ['storage'];
  if (!sources.every(source => source.purpose.includes('teaching') || source.purpose.includes('all'))) {
    throw new Error('知识边的来源未授权教学用途。');
  }
  return ['storage', 'teaching'];
}
