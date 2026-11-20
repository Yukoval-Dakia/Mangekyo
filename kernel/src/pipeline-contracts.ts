import type { CommandId, FactId, Revision, Tick } from './declarations/ids.ts';
import type { CommandReceipt, FactRef, Json, JsonObject } from './declarations/types.ts';

// Scope, recipient and the default query projection are bound by the host.
export type BusRef = { readonly id: FactId; readonly accessEpoch?: Tick; readonly type?: string } & (
  | { readonly mode: 'pinned'; readonly rev: Revision }
  | { readonly mode: 'following'; readonly rev?: Revision }
);
export type BusWitness = FactRef & {
  readonly type: string;
  readonly mode: 'pinned' | 'following';
  readonly accessEpoch: Tick;
};
export type BusReadResult<T> = { readonly items: readonly T[]; readonly witnesses: readonly BusWitness[] };
export type BusQuery = { readonly types: readonly string[]; readonly limit?: number };
export type BusMutation = { readonly deletionWatermark?: string; readonly id: CommandId; readonly type: string; readonly input: Json };
export type PipelineBus<Projection, Preset, Mutation = BusMutation, Receipt = CommandReceipt> = {
  query(filter: BusQuery): Promise<BusReadResult<Projection>>;
  resolve(refs: readonly BusRef[], preset: Preset): Promise<BusReadResult<Projection>>;
  mutate(command: Mutation): Promise<Receipt>;
};

// The owning module supplies its parsed block bodies, frozen items and typed anchors.
export type Asset<Unit, Block> = Unit & { readonly blocks: readonly Block[] };
export type Activity<Item, Modality extends string = string> = {
  readonly modality: Modality;
  readonly items: readonly Item[];
};
export type Edge<Ref, Kind extends string = string> = {
  readonly from_ref: Ref;
  readonly to_ref: Ref;
  readonly kind: Kind;
  readonly basis: readonly BusWitness[];
  readonly author: 'learner' | 'companion';
  readonly confidence: number | null;
  readonly sticky: boolean;
};

export type BeliefTime = {
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly recordedAt: string;
  readonly supersededAt: string | null;
};
export type RefusalBoundary = {
  readonly goal: string;
  readonly intent_key: string;
  readonly reopen_condition: { readonly kind: 'learner_request' } | { readonly kind: 'at'; readonly at: string };
};
type Belief<Scope, Evidence> = BeliefTime & {
  readonly text: string;
  readonly scope: Scope;
  readonly evidence_refs: readonly [Evidence, ...Evidence[]];
  readonly sticky: boolean;
};
export type Directive<Scope, Evidence> = Belief<Scope, Evidence> & { readonly category: 'directive' } & (
  | { readonly kind: 'preference' | 'statement' }
  | { readonly kind: 'state'; readonly validTo: string }
  | { readonly kind: 'refusal'; readonly refusal: RefusalBoundary }
);
export type Hypothesis<Scope, Evidence> = Belief<Scope, Evidence> & {
  readonly category: 'hypothesis';
  readonly kind: 'misconception' | 'metacognitive_habit' | 'observation' | 'memoryAssertion';
  readonly status: 'tentative' | 'supported' | 'disputed' | 'improving' | 'retired' | 'relapsed';
};
export type Experience<Ref, Outcome> = {
  readonly runId: string;
  readonly objective: string;
  readonly strategyId: string | null;
  readonly actionRefs: readonly Ref[];
  readonly observationRefs: readonly Ref[];
  readonly outcome: Outcome;
  readonly verificationRefs: readonly Ref[];
  readonly userFeedbackRefs: readonly Ref[];
  readonly latencyMs: number | null;
  readonly tokenCost: number | null;
};
export type Playbook<Step, Evidence> = {
  readonly version: number;
  readonly preconditions: readonly string[];
  readonly strategy_steps: readonly Step[];
  readonly counterexamples: readonly Evidence[];
  readonly exit_conditions: readonly string[];
};

type Dimensions = { readonly representation?: string; readonly context?: string; readonly method?: string };
type ItemNovelty = 'same' | 'isomorphic' | 'transfer';
export type EvidenceEventV1 = Dimensions & {
  readonly ref: string;
  readonly rev: number;
  readonly occurred_at: string;
  readonly concept_ids: readonly string[];
  readonly item_novelty: ItemNovelty;
  readonly help_level: 'independent' | 'hinted' | 'solution_seen';
  readonly outcome: 'correct' | 'incorrect' | 'unknown';
  readonly claim_ids: readonly string[];
  readonly score_norm?: number;
  readonly effective_duration_ms?: number;
  readonly confidence?: number;
  readonly error_stage?: 'reading' | 'modeling' | 'strategy' | 'execution' | 'expression';
};
export type EvidenceCandidateV1 = Dimensions & {
  readonly ref: string;
  readonly concept_ids: readonly string[];
  readonly item_novelty: ItemNovelty;
  readonly est_min: number;
};
// JSON at the Python boundary. Absence of a witnessed observation can be explained
// without encoding it as assisted, independent, correct or incorrect.
export type CanonicalEvidenceSliceV1 = {
  readonly clock_watermark: string;
  readonly as_of_at: string;
  readonly events: readonly EvidenceEventV1[];
  readonly omissions?: readonly { readonly ref: { readonly id: string; readonly rev: number }; readonly reason: string }[];
  readonly constraints: {
    readonly budget_min: number | null;
    readonly locks: readonly string[];
    readonly deadlines: readonly { readonly ref: string; readonly at: string }[];
  };
  readonly candidate_pool: readonly EvidenceCandidateV1[];
};

export type ToolErrorCode = 'invalid_args' | 'not_found' | 'access_revoked' | 'basis_stale'
  | 'version_conflict' | 'evidence_not_opened' | 'limit_exceeded';
export type ToolError = {
  readonly ok: false;
  readonly message: string;
  readonly next: { readonly tool: string; readonly args: JsonObject };
} & (
  | { readonly code: 'not_found'; readonly candidates: readonly string[] }
  | { readonly code: Exclude<ToolErrorCode, 'not_found'> }
);
