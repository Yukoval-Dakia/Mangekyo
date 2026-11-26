import type { ReactNode } from 'react';
import type { Settings } from '../api';

export type {
  PriorityConceptSummary,
  TopErrorStageSummary,
  WeaknessAndErrorSummaryView,
  WeaknessEvidenceRef,
  WeaknessNextAction,
} from '../../../../modules/learner/weakness-error-summary';

import type { WeaknessAndErrorSummaryView } from '../../../../modules/learner/weakness-error-summary';

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

export type MasteryIllusionAlert = {
  readonly id: string;
  readonly conceptId?: string | undefined;
  readonly conceptTitle: string;
  readonly subject?: string | undefined;
  readonly errorStageLabel?: string | undefined;
  readonly highConfidenceWrongCount: number;
  readonly latestWrongSummary?: string | undefined;
  readonly discriminatorHint?: string | undefined;
  readonly targetPrompt?: string | undefined;
  readonly recommendedAction?: 'author_mistake_variant' | 'discriminator_probe' | string | undefined;
  readonly evidenceIds?: readonly string[] | undefined;
  readonly evidenceHref?: string | undefined;
  readonly practiceHref?: string | undefined;
};

export type MetacognitiveHabitEvidence = {
  readonly id?: string | undefined;
  readonly label?: string | undefined;
  readonly excerpt: string;
  readonly href?: string | undefined;
};

export type MetacognitiveHabit = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly errorStageLabel?: string | undefined;
  readonly preStartHint?: string | undefined;
  readonly confidenceNote?: string | undefined;
  readonly subjects?: readonly string[] | undefined;
  readonly sessionCount?: number | undefined;
  readonly evidenceCount?: number | undefined;
  readonly evidenceIds?: readonly string[] | undefined;
  readonly status?: string | undefined;
  readonly evidences?: readonly MetacognitiveHabitEvidence[] | undefined;
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
  /** Optional add-on from the domain-3 weakness projection; absent before backend rollout. */
  weaknessSummary?: WeaknessAndErrorSummaryView | undefined;
  /** Optional add-on for high-confidence wrong alerts (mastery illusion red-light zone). */
  masteryIllusionAlerts?: readonly MasteryIllusionAlert[] | undefined;
  /** Optional add-on for cross-subject/multi-session metacognitive habits. */
  metacognitiveHabits?: readonly MetacognitiveHabit[] | undefined;
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
  /** Hide the panel's own heading when an enclosing surface already renders it. */
  hideHeading?: boolean;
  /** Optional slot rendered above the item list (e.g. extra controls). */
  renderHeaderExtra?: (() => ReactNode) | undefined;
  /** Model settings used when a weakness action starts a classroom. */
  settings?: Settings | undefined;
  /** SPA navigation; falls back to location.assign when absent. */
  onNavigate?: ((href: string) => void) | undefined;
  /** Optional handler invoked when learner launches a counterexample drill from a mastery illusion alert. */
  onPracticeCounterexample?: ((alert: MasteryIllusionAlert) => void) | undefined;
};
