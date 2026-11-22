import type {Settings} from '../api.ts';

export type MasteryStatus = 'steady' | 'fading' | 'fragile' | 'unknown';

export type KnowledgeGraphNode = {
  id: string;
  rev: number;
  title: string;
  kind: 'concept';
  mastery: {
    status: MasteryStatus;
    retrievability: number | null;
    independentCount: number;
    basisRefs: readonly unknown[];
  };
  counts: { questions: number; textbooks: number; notes: number; notionBlocks: number };
};

export type KnowledgeGraphEdge = {
  id: string;
  rev: number;
  kind: string;
  from: string;
  to: string;
  status: 'verified';
  basisRefs: readonly unknown[];
};

export type KnowledgeGraphPendingProposal = {
  id: string;
  kind: string;
  from: string;
  to: string;
  summary: string;
  basisRefs: readonly unknown[];
};

export type KnowledgeGraphResponse = {
  asOf: string;
  nodes: readonly KnowledgeGraphNode[];
  edges: readonly KnowledgeGraphEdge[];
  pendingProposals: readonly KnowledgeGraphPendingProposal[];
};

export type MasteryFilter = 'all' | 'steady' | 'needs-work' | 'unknown';

export type GraphViewMode = 'tree' | 'graph';

export type KnowledgeGraphViewProps = {
  data?: KnowledgeGraphResponse | null;
  loading?: boolean;
  error?: string | null;
  fetchOnMount?: boolean;
  settings?: Settings | null | undefined;
  onNavigate?: (href: string) => void;
  onCaptureMaterial?: () => void;
  onSelectQuestion?: (questionId: string) => void;
  onCiteToCompanion?: (node: KnowledgeGraphNode) => void;
};
