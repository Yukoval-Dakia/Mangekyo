import type { ReactNode } from 'react';

export type MemoryCategoryKey = 'preference' | 'claim' | 'state' | 'refusal';

/** One HTTP write action offered by the backend for a memory item. */
export type MemoryActionSpec = {
  method: 'POST';
  path: string;
  body: Record<string, unknown>;
};

export type MemoryRevokeSourceAction = MemoryActionSpec & {
  sourceId: string;
};

/** Action map exactly as `GET /api/memory/overview` returns it. */
export type MemoryItemActions = {
  correct?: MemoryActionSpec;
  forget?: MemoryActionSpec;
  undo?: MemoryActionSpec;
  revokeSources?: readonly MemoryRevokeSourceAction[];
};

export type MemoryBasisEntry =
  | { kind: 'turn-quote'; id: string; rev: number; accessEpoch: string; excerpt: string; start: number }
  | { kind: 'scope-object'; id: string; rev: number; accessEpoch: string; type?: string }
  | {
      kind: 'activity-citation';
      id: string;
      rev: number;
      accessEpoch: string;
      anchor: string;
      direction: 'support' | 'contradict' | 'unresolved';
      excerpt: string;
    }
  | { kind: 'learner-declaration'; id: string; rev: number; accessEpoch: string };

export type MemoryOverviewItem = {
  id: string;
  rev: number;
  accessEpoch: string;
  factType: string;
  category: MemoryCategoryKey;
  text: string;
  origin: 'turn' | 'learner';
  authority: 'directive' | null;
  sticky: boolean;
  scope: unknown;
  validUntil: string | null;
  expired: boolean;
  refusal: unknown;
  recordedTick: string;
  basis: readonly MemoryBasisEntry[];
  actions: MemoryItemActions;
};

export type MemoryHypothesisItem = {
  id: string;
  rev: number;
  accessEpoch: string;
  factType: string;
  kind: string;
  status: string;
  text: string;
  scope: unknown;
  sticky: boolean;
  ttl: string | null;
  review: 'supported' | 'contradicted' | 'unresolved' | 'unknown';
  basis: readonly MemoryBasisEntry[];
  actions: MemoryItemActions;
};

export type CalibrationRecord = {
  key: string;
  status: 'confirmed' | 'missed' | string;
  conceptId: string | null;
  occurredAt: string;
};

export type CalibrationSummary = {
  status: 'available' | 'unknown';
  totalReconciliations: number;
  confirmed: number;
  missed: number;
  recent: readonly CalibrationRecord[];
};

export type MemoryOverviewResponse = {
  asOf: string;
  categories: {
    preference: readonly MemoryOverviewItem[];
    claim: readonly MemoryOverviewItem[];
    state: readonly MemoryOverviewItem[];
    refusal: readonly MemoryOverviewItem[];
  };
  stickyDirectives: readonly MemoryOverviewItem[];
  hypotheses: readonly MemoryHypothesisItem[];
  calibration: CalibrationSummary;
};

export type MemoryItem =
  | (MemoryOverviewItem & { section: 'directive' })
  | (MemoryHypothesisItem & { section: 'hypothesis' });

export type MemoryActionKind = 'correct' | 'forget' | 'undo';

export type MemoryActionRequest = {
  item: MemoryItem;
  kind: MemoryActionKind;
  spec: MemoryActionSpec;
  /** For `correct`, the learner-supplied replacement text. */
  text?: string;
};

export type MemoryOverviewState =
  | { status: 'loading' }
  | { status: 'ready'; data: MemoryOverviewResponse }
  | { status: 'error'; message: string; code: 'not-found' | 'network' | 'parse' };

export type MemoryOverviewHandlers = {
  /** Run a write action; default performs `fetch(spec.path, {method: spec.method, body: spec.body})`. */
  onRunAction?: (request: MemoryActionRequest) => Promise<void>;
};

export type MemoryOverviewPanelProps = MemoryOverviewHandlers & {
  fetchJson?: (path: string) => Promise<MemoryOverviewResponse>;
  initialOverview?: MemoryOverviewResponse;
  /** Optional slot rendered above the item list (e.g. extra controls). */
  renderHeaderExtra?: (() => ReactNode) | undefined;
};
