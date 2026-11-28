import type { Json, JsonObject } from './declarations/types.ts';
import type { CanonicalEvidenceSliceV1, EvidenceEventV1 } from './pipeline-contracts.ts';

export type EvidenceFactRefV2 = { readonly id: string; readonly rev: number };

export type EvidenceInputRefV2 = {
  readonly item_id: string;
  readonly criterion_id?: string;
  readonly slot_id?: string;
  readonly path?: string;
  readonly fact_ref?: EvidenceFactRefV2;
};

export type CriterionKcLinkV2 = {
  readonly criterion_id: string;
  readonly kc_id: string;
  readonly relation?: 'covers' | 'tests' | 'supports' | 'contradicts';
  readonly basis?: readonly EvidenceFactRefV2[];
};

export type CriterionObservationV2 = {
  readonly item_id: string;
  readonly criterion_id: string;
  readonly inputs: readonly EvidenceInputRefV2[];
  readonly earned?: number;
  readonly maximum: number | null;
  readonly outcome: 'correct' | 'incorrect' | 'partial' | 'qualitative' | 'unknown' | 'unavailable';
  readonly evidence_refs?: readonly EvidenceFactRefV2[];
  readonly error_stage?: 'reading' | 'modeling' | 'strategy' | 'execution' | 'expression';
};

export type DiagnosticItemModelV2 = {
  readonly item_id: string;
  readonly prompt_ref?: EvidenceFactRefV2;
  readonly concept_ids: readonly string[];
  readonly criteria: readonly CriterionKcLinkV2[];
  readonly model_version?: string;
};

export type EvidenceEventV2 = EvidenceEventV1 & {
  readonly fact_ref: EvidenceFactRefV2;
  readonly item_id?: string;
  readonly criteria?: readonly CriterionObservationV2[];
  readonly attribution_status: string;
  readonly item_model?: DiagnosticItemModelV2;
};

export type ConceptGraphNodeV2 = {
  readonly id: string;
  readonly label?: string;
  readonly kli_profile?: JsonObject;
  readonly study_stage?: string;
  readonly target_level?: number | null;
};

export type ConceptGraphEdgeV2 = {
  readonly id?: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly relation?: string;
  readonly basis?: readonly EvidenceFactRefV2[];
};

export type CanonicalEvidenceSliceV2 = Omit<CanonicalEvidenceSliceV1, 'events' | 'omissions' | 'candidate_pool'> & {
  readonly schema_version: 'v2';
  readonly authorization: {
    readonly learner_id?: string;
    readonly purpose: string;
    readonly recipient: string;
    readonly access_epoch?: string;
  };
  readonly events: readonly EvidenceEventV2[];
  readonly concept_graph: {
    readonly nodes: readonly ConceptGraphNodeV2[];
    readonly edges: readonly ConceptGraphEdgeV2[];
  };
  readonly omissions?: readonly {
    readonly ref: EvidenceFactRefV2;
    readonly item_id?: string;
    readonly reason: string;
  }[];
  readonly candidate_pool?: readonly {
    readonly ref: string;
    readonly concept_ids: readonly string[];
    readonly item_novelty: 'same' | 'isomorphic' | 'transfer';
    readonly est_min: number;
    readonly item_id?: string;
  }[];
};

export type MasteryBeliefV2 = {
  readonly concept_id: string;
  readonly state: 'observed' | 'prior_belief' | 'unknown';
  readonly value?: number;
  readonly basis?: readonly EvidenceFactRefV2[];
  readonly as_of_at?: string;
};

export type QuestionMetaStickyFieldKeyWire =
  | 'hint_ladder'
  | `tag:${string}`
  | `solution:${string}`;
export type BankAnswerRowWire = {
  readonly slotId: string;
  readonly path: string;
  readonly value: Json;
};

export type CodeSandboxExecutorKindWire = 'isolated-code-sandbox';
export type CodeCaseStatusWire =
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'runtime_error'
  | 'syntax_error'
  | 'output_limit_exceeded'
  | 'missing';
export type CodeLanguageWire = 'python' | 'javascript' | 'typescript';
export type CodeSandboxRunResultWire = {
  readonly caseId: string; readonly status: Exclude<CodeCaseStatusWire, 'missing'>;
  readonly actualOutput?: string; readonly durationMs?: number; readonly stderr?: string; readonly exitCode?: number;
};
export type CodeSandboxRunReportWire = {
  readonly executorKind: CodeSandboxExecutorKindWire; readonly language: CodeLanguageWire; readonly runId?: string;
  readonly executedAtIso?: string; readonly compileError?: string; readonly timedOut?: boolean;
  readonly totalDurationMs?: number; readonly peakMemoryMb?: number; readonly results: readonly CodeSandboxRunResultWire[];
  readonly qualitativeDimensions?: readonly string[];
};
export type CodeCaseOutcomeWire = {
  readonly caseId: string; readonly hidden: boolean; readonly weight: number; readonly passed: boolean;
  readonly status: CodeCaseStatusWire; readonly durationMs?: number; readonly stderr?: string; readonly diagnostic?: string;
};
export type CodeSandboxProjectionWire = {
  readonly criterionId: string; readonly executorKind: CodeSandboxExecutorKindWire; readonly language: CodeLanguageWire;
  readonly state: 'scored' | 'partial' | 'ungradable'; readonly proportion: number; readonly earned: number; readonly maximum: number;
  readonly passedCount: number; readonly failedCount: number; readonly totalCount: number;
  readonly missingCaseIds: readonly string[]; readonly compileError?: string; readonly timedOut: boolean;
  readonly totalDurationMs?: number; readonly peakMemoryMb?: number; readonly caseOutcomes: readonly CodeCaseOutcomeWire[];
  readonly qualitativeDimensions: readonly JsonObject[];
};

export type KbGardeningDuplicateTargetIdsWire =
  readonly [mergeTargetId: string, keepTargetId: string];
export type KbDanglingReferenceWire = {
  readonly id: string; readonly holderKind: 'edge' | 'textbook_page' | 'question';
  readonly holderId: string; readonly holderTitle?: string;
  readonly field: 'fromId' | 'toId' | 'referencedIds' | 'conceptIds';
  readonly targetId: string; readonly reason: 'missing' | 'revoked' | 'redirected_entity';
  readonly resolvedTargetId?: string; readonly redirectChain?: readonly string[];
  readonly sticky: boolean; readonly hasUserAuthoredContent?: boolean;
};
export type KbStaleUnusedDraftWire = {
  readonly assetKind: 'textbook_page' | 'question'; readonly assetId: string; readonly title: string;
  readonly rev?: number; readonly updatedAt?: string; readonly ageDays: number;
  readonly sticky: boolean; readonly hasUserAuthoredContent: boolean;
};
export type KbEntropyRadarWire = {
  readonly scannedAt: string;
  readonly duplicateConcepts: readonly JsonObject[];
  readonly danglingReferences: readonly KbDanglingReferenceWire[];
  readonly staleUnusedDrafts: readonly KbStaleUnusedDraftWire[];
  readonly compressionCandidates: readonly JsonObject[];
  readonly coarseConcepts: readonly JsonObject[];
  readonly excludedCount: number;
};
export type KbGardeningPlanWire = {
  readonly generatedAt: string;
  readonly radar: KbEntropyRadarWire;
  readonly green: readonly JsonObject[];
  readonly yellow: readonly JsonObject[];
  readonly red: readonly JsonObject[];
  readonly summary: {
    readonly greenCount: number; readonly yellowCount: number; readonly redCount: number;
    readonly duplicateConceptCount: number; readonly danglingReferenceCount: number;
    readonly staleUnusedDraftCount: number; readonly compressionCandidateCount: number;
  };
};

export type ArchetypeClusterProjectionWire = {
  readonly cards: readonly {
    readonly archetypeId: string; readonly title: string; readonly coveredQuestionCount: number;
    readonly coveredQuestionIds: readonly string[]; readonly coveredQuestions: readonly JsonObject[];
    readonly variationDimensions: readonly string[]; readonly unmasteredCount: number; readonly coverageLabel: string;
  }[];
  readonly standaloneQuestionIds: readonly string[];
};

export type DualBacktraceEntryWire = {
  readonly evidence: JsonObject;
  readonly inference: {
    readonly matchBasis: readonly string[];
    readonly crossChapter: boolean;
    readonly provenance: 'system_inference';
  };
};
export type DualBacktraceResultWire = {
  readonly target: JsonObject;
  readonly similarMistakes: readonly DualBacktraceEntryWire[];
  readonly independentSuccesses: readonly DualBacktraceEntryWire[];
  readonly excludedRevokedCount: number;
};

export type AssessmentRevisionRefWire = {
  readonly id: string;
  readonly rev: number;
};
export type FormalAssessmentWire = {
  readonly result: {
    readonly releaseRef?: AssessmentRevisionRefWire;
    readonly submissionRef: AssessmentRevisionRefWire;
    readonly outcomes: readonly JsonObject[];
  };
  readonly score?: JsonObject;
  readonly criteria?: readonly JsonObject[];
  readonly receipts?: readonly JsonObject[];
};

export type StudyMethodStepKindWire =
  | 'predict'
  | 'try_first'
  | 'worked_example'
  | 'faded_example'
  | 'counterexample'
  | 'teach_companion'
  | 'independent_check'
  | 'independent_transfer'
  | 'self_explanation'
  | 'reflection_summary';
export type StudyMethodStepWire = {
  readonly stepId: string;
  readonly kind: StudyMethodStepKindWire;
  readonly title: string;
  readonly promptHint: string;
  readonly observationRequired: boolean;
  readonly blocksSpoiler: boolean;
  readonly maxMinutes?: number;
};
export type StudyMethodTemplateWire = {
  readonly templateId: string;
  readonly version: number;
  readonly name: string;
  readonly goal: string;
  readonly disciplineTags: readonly string[];
  readonly steps: readonly StudyMethodStepWire[];
  readonly observationRequirements: readonly string[];
  readonly author: 'learner' | 'companion' | 'co_created';
  readonly replacesVersion?: number;
  readonly undoToken?: `undo:method-template:${string}`;
};

export type CalcArtifactBindingWire = {
  readonly handle: string;
  readonly artifactId: string;
  readonly artifactRev: number;
  readonly outputSha256: string;
  readonly producer: 'python_calculation_sandbox';
  readonly mediaKind: 'table_json' | 'series_json' | 'svg_plot' | 'png_plot';
  readonly frozenAtIso: string;
  readonly seriesSummary?: {
    readonly pointCount: number;
    readonly unit?: string;
    readonly xLabel?: string;
    readonly yLabel?: string;
  };
};
export type CalcBindingsFreezeVerificationWire = {
  readonly status: 'exact' | 'drifted_keep_frozen' | 'missing_keep_frozen';
  readonly preservedFrozen: true;
  readonly entries: readonly {
    readonly handle: string;
    readonly artifactId: string;
    readonly frozenRev: number;
    readonly frozenSha256: string;
    readonly currentRev?: number;
    readonly currentSha256?: string;
    readonly status: 'exact' | 'drifted_keep_frozen' | 'missing_keep_frozen';
    readonly reason: string;
  }[];
};

export type LivingMineMetricKeyWire =
  | 'unknown_exam_gaps' | 'high_conf_misses' | 'supply_shortages'
  | 'warm_backfill_queue' | 'asset_entropy_candidates' | 'stale_unused_inventory';
export type LivingMineRadarHandleWire = {
  readonly id: string; readonly metric: LivingMineMetricKeyWire; readonly kind: string;
  readonly title: string; readonly reasonLabel: string; readonly refId?: string;
  readonly tier?: 'hot' | 'warm' | 'cold';
  readonly priority?: 'active_error_related' | 'high_frequency_archetype' | 'recent_history';
};
export type LivingMineMetricBucketWire = {
  readonly key: LivingMineMetricKeyWire; readonly label: string;
  readonly count: number; readonly topHandles: readonly LivingMineRadarHandleWire[];
};
export type LivingMineRadarWire = {
  readonly generatedAt: string; readonly carePaused: boolean;
  readonly metrics: Readonly<Record<LivingMineMetricKeyWire, LivingMineMetricBucketWire>>;
  readonly totalActionableCount: number; readonly topHandles: readonly LivingMineRadarHandleWire[];
};

export type ShadowCalibrationPkWire = {
  readonly verdict: 'insufficient_sample' | 'shadow_wins_ready' | 'keep_active' | 'tied_keep_active';
  readonly verdictReason: string; readonly thresholds: JsonObject; readonly calibrationCurve: readonly JsonObject[];
  readonly brierDelta: number | null; readonly eceDelta: number | null;
  readonly coverageDelta: number | null; readonly baselineBeatMargin: number | null;
  readonly contaminatedCount: number; readonly missingIndependentCount: number; readonly nextEvidenceNeeded: number;
  readonly recorded: JsonObject; readonly shadow: JsonObject; readonly baseline: JsonObject;
  readonly memoryLayerBoundary: 'read_only_proposal';
};

export type ExamPacingReviewWire = {
  readonly methodVersion: 'plan/exam-pacing@1'; readonly status: 'ready' | 'unknown'; readonly headline: string;
  readonly observedAttemptCount: number; readonly unknownAttemptCount: number;
  readonly missingFields: readonly string[]; readonly missingReasons: readonly string[];
  readonly bottleneckItems: readonly JsonObject[]; readonly positiveStrategyExamples: readonly JsonObject[];
  readonly crossAttemptTradeoffs: readonly JsonObject[];
};

export type LongBreakReentryPlanWire = {
  readonly triggered: boolean; readonly inactiveDays: number; readonly minInactiveDays: number;
  readonly maxProbeCount: number; readonly headline: string; readonly reassuranceMessage: string;
  readonly buckets: {
    readonly likelyStillSolid: readonly JsonObject[];
    readonly likelyFaded: readonly JsonObject[];
    readonly uncertainNeedsProbe: readonly JsonObject[];
  };
  readonly probeItems: readonly JsonObject[]; readonly lockedActivityIds: readonly string[];
  readonly filteredRefusedCount: number; readonly rawOverdueCount: number; readonly suppressedOverdueCount: number;
};
