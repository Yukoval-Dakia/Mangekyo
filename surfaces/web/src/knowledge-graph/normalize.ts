import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphPendingProposal,
  KnowledgeGraphResponse,
  MasteryStatus,
} from './types.ts';

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asRefArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

function normalizeMasteryStatus(raw: unknown): MasteryStatus {
  const value = asString(raw);
  switch (value) {
    case 'steady':
    case 'fading':
    case 'fragile':
    case 'unknown':
      return value;
    case 'solid':
      return 'steady';
    case 'weak':
      return 'fragile';
    case 'due':
      return 'fading';
    default:
      return 'unknown';
  }
}

function normalizeNode(raw: unknown): KnowledgeGraphNode | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const mastery = isRecord(raw.mastery) ? raw.mastery : {};
  const counts = isRecord(raw.counts) ? raw.counts : {};
  return {
    id,
    rev: asNumber(raw.rev) ?? 0,
    title: asString(raw.title) ?? asString(raw.name) ?? '未命名概念',
    kind: 'concept',
    mastery: {
      status: normalizeMasteryStatus(mastery.status),
      retrievability: typeof mastery.retrievability === 'number' ? mastery.retrievability : null,
      independentCount: asNumber(mastery.independentCount) ?? 0,
      basisRefs: asRefArray(mastery.basisRefs ?? mastery.sourceRefs),
    },
    counts: {
      questions: asNumber(counts.questions) ?? 0,
      textbooks: asNumber(counts.textbooks) ?? 0,
      notes: asNumber(counts.notes) ?? 0,
      notionBlocks: asNumber(counts.notionBlocks) ?? 0,
    },
  };
}

function normalizeEdge(raw: unknown): KnowledgeGraphEdge | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const from = asString(raw.fromId) ?? asString(raw.from);
  const to = asString(raw.toId) ?? asString(raw.to);
  if (!id || !from || !to) return null;
  return {
    id,
    rev: asNumber(raw.rev) ?? 0,
    kind: asString(raw.kind) ?? 'related_to',
    from,
    to,
    status: 'verified',
    basisRefs: asRefArray(raw.basisRefs ?? raw.sourceRefs),
  };
}

function normalizeProposal(raw: unknown): KnowledgeGraphPendingProposal | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.proposalId) ?? asString(raw.id);
  if (!id) return null;
  const from = asString(raw.fromId) ?? asString(raw.from) ?? '';
  const to = asString(raw.toId) ?? asString(raw.to) ?? '';
  return {
    id,
    kind: asString(raw.edgeKind) ?? asString(raw.kind) ?? asString(raw.commandType) ?? 'related_to',
    from,
    to,
    summary: asString(raw.summary) ?? '',
    basisRefs: asRefArray(raw.basisRefs ?? raw.sourceRefs),
  };
}

export function normalizeKnowledgeGraphResponse(raw: unknown): KnowledgeGraphResponse {
  const source = isRecord(raw) ? raw : {};
  const nodes = (Array.isArray(source.nodes) ? source.nodes : [])
    .map(normalizeNode)
    .filter((node): node is KnowledgeGraphNode => node !== null);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = (Array.isArray(source.edges) ? source.edges : [])
    .map(normalizeEdge)
    .filter((edge): edge is KnowledgeGraphEdge => edge !== null)
    .filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const pendingProposals = (Array.isArray(source.pendingProposals) ? source.pendingProposals : [])
    .map(normalizeProposal)
    .filter((proposal): proposal is KnowledgeGraphPendingProposal => proposal !== null)
    .filter(proposal => proposal.from === '' || proposal.to === '' || nodeIds.has(proposal.from) || nodeIds.has(proposal.to));
  return {
    asOf: asString(source.asOf) ?? new Date().toISOString(),
    nodes,
    edges,
    pendingProposals,
  };
}
