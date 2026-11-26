import { isRecord, readArray, readNumber } from '../shared/safe-values.ts';
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphPendingProposal,
  KnowledgeGraphResponse,
  MasteryStatus,
} from './types.ts';

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asRefArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const MASTERY_MAP: Readonly<Record<string, MasteryStatus>> = {
  steady: 'steady',
  solid: 'steady',
  fading: 'fading',
  due: 'fading',
  fragile: 'fragile',
  weak: 'fragile',
  unknown: 'unknown',
};

function normalizeNode(raw: unknown): KnowledgeGraphNode | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const mastery = isRecord(raw.mastery) ? raw.mastery : {};
  const counts = isRecord(raw.counts) ? raw.counts : {};
  return {
    id,
    rev: readNumber(raw.rev) ?? 0,
    title: asString(raw.title) ?? asString(raw.name) ?? '未命名概念',
    kind: 'concept',
    mastery: {
      status: MASTERY_MAP[asString(mastery.status) ?? ''] ?? 'unknown',
      retrievability: typeof mastery.retrievability === 'number' ? mastery.retrievability : null,
      independentCount: readNumber(mastery.independentCount) ?? 0,
      basisRefs: asRefArray(mastery.basisRefs ?? mastery.sourceRefs),
    },
    counts: {
      questions: readNumber(counts.questions) ?? 0,
      textbooks: readNumber(counts.textbooks) ?? 0,
      notes: readNumber(counts.notes) ?? 0,
      notionBlocks: readNumber(counts.notionBlocks) ?? 0,
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
    rev: readNumber(raw.rev) ?? 0,
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
  return {
    id,
    kind: asString(raw.edgeKind) ?? asString(raw.kind) ?? asString(raw.commandType) ?? 'related_to',
    from: asString(raw.fromId) ?? asString(raw.from) ?? '',
    to: asString(raw.toId) ?? asString(raw.to) ?? '',
    summary: asString(raw.summary) ?? '',
    basisRefs: asRefArray(raw.basisRefs ?? raw.sourceRefs),
  };
}

export function normalizeKnowledgeGraphResponse(raw: unknown): KnowledgeGraphResponse {
  const source = isRecord(raw) ? raw : {};
  const nodes = readArray(source.nodes, normalizeNode);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = readArray(source.edges, normalizeEdge).filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
  );
  const pendingProposals = readArray(source.pendingProposals, normalizeProposal).filter(
    (proposal) =>
      proposal.from === '' || proposal.to === '' || nodeIds.has(proposal.from) || nodeIds.has(proposal.to),
  );
  return {
    asOf: asString(source.asOf) ?? new Date().toISOString(),
    nodes,
    edges,
    pendingProposals,
  };
}
