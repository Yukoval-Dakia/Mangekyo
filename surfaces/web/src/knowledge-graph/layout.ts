import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphPendingProposal,
  MasteryFilter,
  MasteryStatus,
} from './types.ts';

export const masteryOrder: Record<MasteryStatus, number> = {
  fragile: 0,
  fading: 1,
  unknown: 2,
  steady: 3,
};

export function masteryLabel(status: MasteryStatus): string {
  switch (status) {
    case 'steady': return '已稳';
    case 'fading': return '待固';
    case 'fragile': return '薄弱';
    case 'unknown': return '尚待核对';
  }
}

export function masteryHint(status: MasteryStatus): string {
  switch (status) {
    case 'steady': return '已有稳定独立作答记录';
    case 'fading': return '曾独立做到，近期保持待巩固';
    case 'fragile': return '当前证据显示掌握薄弱';
    case 'unknown': return '尚无足够独立证据';
  }
}

export function edgeKindLabel(kind: string): string {
  switch (kind) {
    case 'prereq_of': case 'prerequisite': return '先修';
    case 'successor': return '后继';
    case 'part_of': return '属于';
    case 'contrasts_with': case 'confusable': return '易混';
    case 'targets_concept': return '指向';
    case 'variant_of': return '变式';
    case 'derived_from': return '派生';
    case 'explains': return '解释';
    case 'addresses_pitfall': return '针对易错';
    case 'supersedes': return '取代';
    case 'transfer': return '迁移';
    case 'maps_to_chapter': return '章节映射';
    case 'instance_of': return '实例';
    case 'references': return '引用';
    case 'supports': return '支持';
    case 'contradicts': return '冲突';
    case 'related_to': return '相关';
    default: return '关联';
  }
}

export function matchesFilter(node: KnowledgeGraphNode, filter: MasteryFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'steady': return node.mastery.status === 'steady';
    case 'needs-work': return node.mastery.status === 'fading' || node.mastery.status === 'fragile';
    case 'unknown': return node.mastery.status === 'unknown';
  }
}

export function masterySummary(node: KnowledgeGraphNode): string {
  const {status, independentCount} = node.mastery;
  if (status === 'unknown') return '尚待核对 · 尚未独立验证';
  const base = masteryLabel(status);
  return independentCount > 0 ? `${base} · 独立作答 ${independentCount} 次` : `${base} · 尚无独立作答`;
}

export function basisDescription(refs: readonly unknown[]): string {
  const count = refs.length;
  if (count === 0) return '暂无依据记录';
  return `依据 ${count} 条`;
}

export function nodeIdOfEdgeEndpoint(edge: KnowledgeGraphEdge, side: 'from' | 'to'): string {
  return edge[side];
}

export function nodeIdOfProposalEndpoint(proposal: KnowledgeGraphPendingProposal, side: 'from' | 'to'): string {
  return proposal[side];
}

const HIERARCHY_KINDS = new Set(['prereq_of', 'prerequisite', 'successor', 'part_of', 'maps_to_chapter']);

export function isHierarchyKind(kind: string): boolean {
  return HIERARCHY_KINDS.has(kind);
}

export function edgePointsToConcept(edge: KnowledgeGraphEdge, fromId: string, toId: string): {from: string; to: string} {
  if (edge.kind === 'successor') return {from: toId, to: fromId};
  return {from: fromId, to: toId};
}

export type LayoutNode = {
  node: KnowledgeGraphNode;
  x: number;
  y: number;
  layer: number;
};

export type LayoutEdge = {
  id: string;
  kind: string;
  pending: boolean;
  summary?: string;
  fromId: string;
  toId: string;
};

export type GraphLayout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
};

const LAYER_GAP = 148;
const ROW_GAP = 96;
const PAD_X = 72;
const PAD_Y = 56;

export function buildGraphLayout(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
  pending: readonly KnowledgeGraphPendingProposal[],
): GraphLayout {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const hierarchyEdges: LayoutEdge[] = [];
  const looseEdges: LayoutEdge[] = [];

  for (const edge of edges) {
    const fromId = nodeIdOfEdgeEndpoint(edge, 'from');
    const toId = nodeIdOfEdgeEndpoint(edge, 'to');
    if (!byId.has(fromId) || !byId.has(toId)) continue;
    const pointed = edgePointsToConcept(edge, fromId, toId);
    const item: LayoutEdge = {id: edge.id, kind: edge.kind, pending: false, fromId: pointed.from, toId: pointed.to};
    if (isHierarchyKind(edge.kind)) hierarchyEdges.push(item);
    else looseEdges.push(item);
  }

  const pendingEdges: LayoutEdge[] = [];
  for (const proposal of pending) {
    const fromId = nodeIdOfProposalEndpoint(proposal, 'from');
    const toId = nodeIdOfProposalEndpoint(proposal, 'to');
    if (!byId.has(fromId) || !byId.has(toId)) continue;
    pendingEdges.push({id: proposal.id, kind: proposal.kind, pending: true, summary: proposal.summary, fromId, toId});
  }

  // layer = longest chain of prerequisites below the node.
  // Leaves (deepest dependents) sit on lower layers rendered further down.
  const depth = new Map<string, number>();
  const upstreamOf = new Map<string, string[]>();
  for (const edge of hierarchyEdges) {
    const list = upstreamOf.get(edge.toId) ?? [];
    list.push(edge.fromId);
    upstreamOf.set(edge.toId, list);
  }
  const visiting = new Set<string>();
  const resolveDepth = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const prerequisite of upstreamOf.get(id) ?? []) {
      best = Math.max(best, resolveDepth(prerequisite) + 1);
    }
    visiting.delete(id);
    depth.set(id, best);
    return best;
  };

  for (const node of nodes) resolveDepth(node.id);

  const layers = new Map<number, KnowledgeGraphNode[]>();
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 0;
    const list = layers.get(level) ?? [];
    list.push(node);
    layers.set(level, list);
  }

  const sortNodes = (list: KnowledgeGraphNode[]) =>
    [...list].sort((a, b) =>
      masteryOrder[a.mastery.status] - masteryOrder[b.mastery.status] ||
      a.title.localeCompare(b.title, 'zh-Hans-CN'),
    );

  const layoutNodes: LayoutNode[] = [];
  const sortedLevels = [...layers.keys()].sort((a, b) => b - a);
  const positionOf = new Map<string, {x: number; y: number; layer: number}>();

  const width = Math.max(
    640,
    PAD_X * 2 + Math.max(...sortedLevels.map(level => (layers.get(level)?.length ?? 0)), 1) * 220,
  );
  const height = PAD_Y * 2 + (sortedLevels.length > 0 ? sortedLevels.length - 1 : 0) * LAYER_GAP + 120;

  for (const level of sortedLevels) {
    const list = sortNodes(layers.get(level) ?? []);
    const rowY = PAD_Y + (sortedLevels.indexOf(level)) * LAYER_GAP;
    const spacing = Math.min(240, (width - PAD_X * 2) / Math.max(list.length, 1));
    const startX = width / 2 - ((list.length - 1) * spacing) / 2;
    list.forEach((node, index) => {
      positionOf.set(node.id, {x: startX + index * spacing, y: rowY, layer: level});
    });
  }

  for (const node of nodes) {
    const position = positionOf.get(node.id);
    if (position) layoutNodes.push({node, x: position.x, y: position.y, layer: position.layer});
  }

  return {
    nodes: layoutNodes,
    edges: [...hierarchyEdges, ...looseEdges, ...pendingEdges],
    width,
    height,
  };
}

export type TreeEntry = {
  node: KnowledgeGraphNode;
  edgeKind?: string;
  pending: boolean;
  summary?: string;
  children: TreeEntry[];
};

const MAX_TREE_DEPTH = 8;

function sortByMasteryThenTitle(list: readonly KnowledgeGraphNode[]): KnowledgeGraphNode[] {
  return [...list].sort((a, b) =>
    masteryOrder[a.mastery.status] - masteryOrder[b.mastery.status] ||
    a.title.localeCompare(b.title, 'zh-Hans-CN'),
  );
}

// Forest layout: roots are concepts with no prerequisites; children are the
// concepts that directly depend on them (deeper = more advanced). Each node is
// placed exactly once, under its first prerequisite in deterministic order, so
// the outline is a true partition of the graph.
export function buildTreeForest(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
  pending: readonly KnowledgeGraphPendingProposal[],
): TreeEntry[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const dependents = new Map<string, {childId: string; edgeKind: string; pending: boolean; summary?: string}[]>();
  const hasUpstream = new Set<string>();

  const link = (parentId: string, childId: string, edgeKind: string, pendingFlag: boolean, summary?: string) => {
    if (!byId.has(parentId) || !byId.has(childId)) return;
    const list = dependents.get(parentId) ?? [];
    list.push({childId, edgeKind, pending: pendingFlag, ...(summary !== undefined ? {summary} : {})});
    dependents.set(parentId, list);
    hasUpstream.add(childId);
  };

  for (const edge of edges) {
    if (!isHierarchyKind(edge.kind)) continue;
    const fromId = nodeIdOfEdgeEndpoint(edge, 'from');
    const toId = nodeIdOfEdgeEndpoint(edge, 'to');
    const pointed = edgePointsToConcept(edge, fromId, toId);
    link(pointed.from, pointed.to, edge.kind, false);
  }

  for (const proposal of pending) {
    if (!isHierarchyKind(proposal.kind)) continue;
    const fromId = nodeIdOfProposalEndpoint(proposal, 'from');
    const toId = nodeIdOfProposalEndpoint(proposal, 'to');
    link(fromId, toId, proposal.kind, true, proposal.summary);
  }

  const placed = new Set<string>();

  const expand = (node: KnowledgeGraphNode, depth: number): TreeEntry => {
    placed.add(node.id);
    if (depth >= MAX_TREE_DEPTH) return {node, pending: false, children: []};
    const children: TreeEntry[] = [];
    const direct = dependents.get(node.id) ?? [];
    const verified = direct.filter(d => !d.pending);
    const proposed = direct.filter(d => d.pending);
    for (const dep of [...verified, ...proposed]) {
      if (placed.has(dep.childId)) continue;
      const child = byId.get(dep.childId);
      if (!child) continue;
      const entry = expand(child, depth + 1);
      entry.edgeKind = dep.edgeKind;
      entry.pending = dep.pending;
      if (dep.summary !== undefined) entry.summary = dep.summary;
      children.push(entry);
    }
    return {node, pending: false, children};
  };

  const roots: TreeEntry[] = [];
  const rootNodes = sortByMasteryThenTitle(nodes.filter(node => !hasUpstream.has(node.id)));
  for (const node of rootNodes) {
    if (!placed.has(node.id)) roots.push(expand(node, 0));
  }
  // Cycle safety net: anything still unplaced sits in a dependency loop.
  for (const node of sortByMasteryThenTitle(nodes)) {
    if (!placed.has(node.id)) roots.push(expand(node, 0));
  }

  return roots;
}

export type RelatedRef = {id: string; title: string; kind: string; pending: boolean; summary?: string};

export function relatedEdges(
  nodeId: string,
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
  pending: readonly KnowledgeGraphPendingProposal[],
): {upstream: RelatedRef[]; downstream: RelatedRef[]} {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const titleOf = (id: string) => byId.get(id)?.title ?? id;
  const upstream: RelatedRef[] = [];
  const downstream: RelatedRef[] = [];

  for (const edge of edges) {
    const fromId = nodeIdOfEdgeEndpoint(edge, 'from');
    const toId = nodeIdOfEdgeEndpoint(edge, 'to');
    if (toId === nodeId) upstream.push({id: fromId, title: titleOf(fromId), kind: edge.kind, pending: false});
    if (fromId === nodeId) downstream.push({id: toId, title: titleOf(toId), kind: edge.kind, pending: false});
  }
  for (const proposal of pending) {
    const fromId = nodeIdOfProposalEndpoint(proposal, 'from');
    const toId = nodeIdOfProposalEndpoint(proposal, 'to');
    if (toId === nodeId) upstream.push({id: fromId, title: titleOf(fromId), kind: proposal.kind, pending: true, summary: proposal.summary});
    if (fromId === nodeId) downstream.push({id: toId, title: titleOf(toId), kind: proposal.kind, pending: true, summary: proposal.summary});
  }
  return {upstream, downstream};
}
