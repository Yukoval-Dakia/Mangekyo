import type { ReactNode } from 'react';
import type { ErrorCluster } from '../recurring-error-strip';

export type MaterialsTabId = 'graph' | 'bank' | 'textbooks' | 'papers' | 'originals';

export interface MaterialsTabMeta {
  readonly id: MaterialsTabId;
  readonly label: string;
  readonly description: string;
}

export type NormalizedMasteryState = 'steady' | 'due' | 'weak' | 'unknown';

export type BankQuestionStatus = 'draft' | 'needs_verification' | 'restricted' | 'release_ready';

export interface QuestionVersionRef {
  readonly id: string;
  readonly rev: number;
}

export interface PracticeHandle {
  readonly kind: 'activity';
  readonly id: string;
  readonly rev: number;
  readonly [key: string]: unknown;
}

export interface RawWitnessLike {
  readonly id?: string;
  readonly rev?: number;
  readonly accessEpoch?: string;
  readonly learner?: string;
  readonly type?: string;
  readonly mode?: string;
}

export interface RawAnchorLike {
  readonly date?: unknown;
  readonly occurredAt?: unknown;
  readonly paperDate?: unknown;
  readonly createdAt?: unknown;
  readonly paperTitle?: unknown;
  readonly sourceLabel?: unknown;
  readonly sourceTitle?: unknown;
  readonly paperName?: unknown;
  readonly examTitle?: unknown;
  readonly title?: unknown;
  readonly position?: unknown;
  readonly questionNumber?: unknown;
  readonly label?: unknown;
  readonly kind?: unknown;
  readonly [key: string]: unknown;
}

export interface RawArchetypeMember {
  readonly question?: RawWitnessLike;
  readonly anchor?: RawAnchorLike | null;
  readonly origin?: 'original' | 'non-paper' | string;
  readonly mastery?: string;
  readonly state?: string;
  readonly practice?: unknown;
  readonly practiceEligible?: boolean;
  readonly canPractice?: boolean;
  readonly title?: string;
  readonly prompt?: string;
  readonly sourceLabel?: string;
  readonly paperTitle?: string;
  readonly revoked?: boolean;
  readonly authorized?: boolean;
  readonly withdrawn?: boolean;
}

export interface RawVariationDimension {
  readonly dimension?: string;
  readonly evidence?: RawWitnessLike;
  readonly count?: number;
}

export interface RawArchetypeVariant {
  readonly changed?: readonly string[];
  readonly from?: RawWitnessLike;
  readonly to?: RawWitnessLike;
  readonly edge?: RawWitnessLike;
  readonly basis?: readonly RawWitnessLike[];
}

export interface RawArchetypeConflict {
  readonly question?: RawWitnessLike;
  readonly groups?: readonly RawWitnessLike[];
  readonly memberships?: readonly RawWitnessLike[];
}

export interface RawMasteryCounts {
  readonly steady?: number;
  readonly due?: number;
  readonly weak?: number;
  readonly unknown?: number;
}

export interface RawArchetypeFoldingCard {
  readonly kind?: 'archetype' | 'question' | string;
  readonly archetype?: RawWitnessLike;
  readonly title?: string;
  readonly representative?: RawArchetypeMember | null;
  readonly members?: readonly RawArchetypeMember[];
  readonly question?: RawArchetypeMember;
  readonly coveredQuestionCount?: number;
  readonly steadyCount?: number;
  readonly dueCount?: number;
  readonly weakCount?: number;
  readonly unknownCount?: number;
  readonly counts?: RawMasteryCounts;
  readonly variants?: readonly RawArchetypeVariant[];
  readonly variationDimensions?: readonly (string | RawVariationDimension)[];
  readonly revoked?: boolean;
  readonly authorized?: boolean;
  readonly withdrawn?: boolean;
}

export interface RawArchetypeFoldingPayload {
  readonly asOf?: string;
  readonly cards?: readonly RawArchetypeFoldingCard[];
  readonly clusters?: readonly RawArchetypeFoldingCard[];
  readonly archetypes?: readonly RawArchetypeFoldingCard[];
  readonly conflicts?: readonly RawArchetypeConflict[];
}

export interface RawBankQuestion {
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly prompt: string;
  readonly status: BankQuestionStatus | string;
  readonly mastery?: string;
  readonly state?: string;
  readonly sourceLabel?: string;
  readonly date?: string;
  readonly revoked?: boolean;
  readonly authorized?: boolean;
  readonly teachingAuthorized?: boolean;
}

export interface RawQuestionCatalogResponse {
  readonly questions: readonly RawBankQuestion[];
  readonly folding?: RawArchetypeFoldingPayload | null;
  readonly archetypeFolding?: RawArchetypeFoldingPayload | null;
  readonly archetypes?: readonly RawArchetypeFoldingCard[] | null;
  readonly clusters?: readonly RawArchetypeFoldingCard[] | null;
  readonly cards?: readonly RawArchetypeFoldingCard[] | null;
}

export interface RawMistakeEntry {
  readonly paperId: string;
  readonly title: string;
  readonly questionId: string;
  readonly prompt: string;
  readonly recurringErrorCluster?: ErrorCluster;
  readonly answer: string;
  readonly expected: string;
  readonly explanation: string | null;
  readonly occurredAt?: string;
  readonly sourceRef?: QuestionVersionRef;
}

export interface NormalizedMasteryCounts {
  readonly steady: number;
  readonly due: number;
  readonly weak: number;
  readonly unknown: number;
  readonly unsteady: number;
}

export interface NormalizedArchetypeMember {
  readonly key: string;
  readonly questionRef?: QuestionVersionRef;
  readonly practice?: PracticeHandle;
  readonly practiceEligible: boolean;
  readonly mastery: NormalizedMasteryState;
  readonly origin: 'original' | 'non-paper';
  readonly dateLabel: string | null;
  readonly sourceLabel: string;
  readonly positionLabel: string | null;
  readonly title: string;
  readonly prompt: string | null;
  readonly isMistake: boolean;
  readonly mistakeEntry?: NormalizedMistakeItem;
}

export type RepresentativeStatus = 'actionable' | 'all_steady' | 'unknown_only' | 'no_handle';

export interface NormalizedVariationDimension {
  readonly dimension: string;
  readonly evidenceCount: number;
}

export interface NormalizedArchetypeVariant {
  readonly key: string;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly changed: readonly string[];
}

export interface NormalizedArchetypeConflict {
  readonly key: string;
  readonly questionLabel: string;
  readonly groupLabels: readonly string[];
  readonly membershipCount: number;
}

export interface NormalizedArchetypeCluster {
  readonly key: string;
  readonly title: string;
  readonly coveredQuestionCount: number;
  readonly originalCount: number;
  readonly nonPaperCount: number;
  readonly counts: NormalizedMasteryCounts;
  readonly variationDimensions: readonly string[];
  readonly variationDimensionCounts: readonly NormalizedVariationDimension[];
  readonly variants: readonly NormalizedArchetypeVariant[];
  readonly members: readonly NormalizedArchetypeMember[];
  readonly representativeMember?: NormalizedArchetypeMember;
  readonly actionableRepresentative?: NormalizedArchetypeMember;
  readonly representativeStatus: RepresentativeStatus;
  readonly hasMistake: boolean;
}

export interface NormalizedBankQuestion {
  readonly key: string;
  readonly sourceRef: QuestionVersionRef;
  readonly title: string;
  readonly prompt: string;
  readonly status: BankQuestionStatus;
  readonly statusLabel: string;
  readonly canPractice: boolean;
  readonly teachingAuthorized: boolean;
  readonly mastery?: NormalizedMasteryState;
  readonly sourceLabel?: string;
  readonly dateLabel?: string;
}

export interface NormalizedMistakeItem {
  readonly key: string;
  readonly paperId: string;
  readonly questionId: string;
  readonly title: string;
  readonly prompt: string;
  readonly answer: string;
  readonly expected: string;
  readonly explanation: string | null;
  readonly occurredAt: string | null;
  readonly recurringCount: number | null;
  readonly recurringErrorCluster?: ErrorCluster;
  readonly sourceRef?: QuestionVersionRef;
  readonly retryHref: string;
}

export type FoldingAvailability = 'ready' | 'unavailable' | 'empty';

export interface NormalizedFoldingResult {
  readonly status: FoldingAvailability;
  readonly clusters: readonly NormalizedArchetypeCluster[];
  readonly standaloneQuestions: readonly NormalizedArchetypeMember[];
  readonly conflicts: readonly NormalizedArchetypeConflict[];
  readonly hiddenClusterCount: number;
}

export interface ArchetypeClustersPanelProps {
  readonly clusters?: readonly NormalizedArchetypeCluster[] | undefined;
  readonly projection?: RawArchetypeFoldingPayload | null | undefined;
  readonly conflicts?: readonly NormalizedArchetypeConflict[] | undefined;
  readonly catalogQuestions?: readonly NormalizedBankQuestion[] | undefined;
  readonly mistakes?: readonly NormalizedMistakeItem[] | undefined;
  readonly mistakesOnly?: boolean | undefined;
  readonly busyActionKey?: string | null | undefined;
  readonly citedKey?: string | null | undefined;
  readonly onPractice?: ((actionKey: string, payload: PracticeQuestionPayload) => void) | undefined;
  readonly onCite?: ((citeKey: string, payload: CompanionCitationPayload) => void) | undefined;
  readonly onNavigate?: ((href: string) => void) | undefined;
  readonly showSummaryHeader?: boolean | undefined;
  readonly emptyMode?: 'card' | 'hidden' | undefined;
  readonly emptyTitle?: string | undefined;
  readonly emptyDescription?: string | undefined;
}

/* ---------- Wave Feature-4 · 知识园艺（绿 / 黄 / 红灯） ---------- */

export interface KbDuplicateConceptCandidate {
  readonly pairKey: string;
  readonly kind?: string;
  readonly leftId: string;
  readonly rightId: string;
  readonly leftName: string;
  readonly rightName: string;
  readonly recommendedKeepId: string;
  readonly recommendedMergeId: string;
  readonly score?: number;
  readonly lexicalScore?: number;
  readonly embeddingScore?: number;
  readonly crossSource?: boolean;
  readonly sources?: readonly string[];
  readonly reasons?: readonly string[];
}

export type KbDanglingReferenceReason = 'missing' | 'revoked' | 'redirected_entity';

export interface KbDanglingReferenceCandidate {
  readonly id: string;
  readonly holderKind?: string;
  readonly holderId: string;
  readonly holderTitle?: string;
  readonly field?: string;
  readonly targetId: string;
  readonly reason: KbDanglingReferenceReason | string;
  readonly resolvedTargetId?: string;
  readonly redirectChain?: readonly string[];
  readonly sticky?: boolean;
}

export interface KbStaleUnusedDraftCandidate {
  readonly assetKind: 'textbook_page' | 'question' | string;
  readonly assetId: string;
  readonly title: string;
  readonly rev?: number;
  readonly updatedAt?: string;
  readonly ageDays: number;
  readonly sticky?: boolean;
  readonly hasUserAuthoredContent?: boolean;
}

export interface KbCompressionCandidate {
  readonly candidateKey: string;
  readonly targetKind: 'chapter' | 'concept' | string;
  readonly targetId: string;
  readonly targetTitle: string;
  readonly noteCount: number;
  readonly noteIds?: readonly string[];
  readonly noteSummaries?: readonly string[];
  readonly recommendedArtifact: 'emergency_card' | 'decision_tree' | string;
  readonly hasUserAuthoredPage?: boolean;
  readonly sticky?: boolean;
}

export interface KbCoarseConceptCandidate {
  readonly conceptId: string;
  readonly title: string;
  readonly linkedQuestionCount: number;
  readonly sticky?: boolean;
}

export interface KbEntropyRadarReport {
  readonly scannedAt?: string;
  readonly duplicateConcepts?: readonly KbDuplicateConceptCandidate[];
  readonly danglingReferences?: readonly KbDanglingReferenceCandidate[];
  readonly staleUnusedDrafts?: readonly KbStaleUnusedDraftCandidate[];
  readonly compressionCandidates?: readonly KbCompressionCandidate[];
  readonly coarseConcepts?: readonly KbCoarseConceptCandidate[];
  readonly excludedCount?: number;
}

export type GardeningGreenActionKind = 'repoint_redirected_reference' | 'archive_stale_unused_draft' | string;

export interface GardeningGreenActionPreview {
  readonly fromTargetId?: string;
  readonly toTargetId?: string;
  readonly redirectChain?: readonly string[];
  readonly previousStatus?: 'draft' | string;
  readonly nextStatus?: 'archived' | string;
}

export interface GardeningGreenAction {
  readonly actionId: string;
  readonly tier?: 'green';
  readonly actionKind: GardeningGreenActionKind;
  readonly targetKind?: 'edge' | 'textbook_page' | 'question' | string;
  readonly targetId: string;
  readonly title: string;
  readonly reason: string;
  readonly reversible?: boolean;
  readonly undo_token: string;
  readonly preview?: GardeningGreenActionPreview;
  readonly suggestedCommand?: string;
}

export type GardeningYellowProposalKind =
  | 'merge_duplicate_concepts'
  | 'propose_emergency_card'
  | 'cleanup_dangling_reference'
  | 'propose_split_coarse_concept'
  | 'duplicate_merge'
  | 'merge_duplicate'
  | 'dangling_ref'
  | 'broken_reference'
  | 'repair_dangling'
  | 'stale_draft'
  | 'expired_draft'
  | 'prune_draft'
  | 'compression_candidate'
  | 'emergency_card'
  | 'chapter_compression'
  | string;

export interface GardeningYellowProposalDetail {
  readonly keepEntityId?: string;
  readonly mergeEntityId?: string;
  readonly keepEntityName?: string;
  readonly mergeEntityName?: string;
  readonly fromTitle?: string;
  readonly toTitle?: string;
  readonly similarityScore?: number;
  readonly crossSource?: boolean;
  readonly sources?: readonly string[];
  readonly reasons?: readonly string[];
  readonly compressionTargetKind?: 'chapter' | 'concept' | string;
  readonly compressionTargetId?: string;
  readonly noteIds?: readonly string[];
  readonly noteCount?: number;
  readonly noteSummaries?: readonly string[];
  readonly recommendedArtifact?: 'emergency_card' | 'decision_tree' | string;
  readonly danglingReferenceId?: string;
  readonly danglingReason?: KbDanglingReferenceReason | string;
  readonly holderTitle?: string;
  readonly field?: string;
  readonly targetId?: string;
  readonly resolvedTargetId?: string;
  readonly redirectChain?: readonly string[];
  readonly linkedQuestionCount?: number;
  readonly ageDays?: number;
  readonly assetKind?: 'textbook_page' | 'question' | string;
}

export interface GardeningYellowProposal {
  readonly proposalId: string;
  readonly tier?: 'yellow';
  readonly proposalKind: GardeningYellowProposalKind;
  readonly title: string;
  readonly summary: string;
  readonly requiresApproval?: boolean;
  readonly appendOnly?: boolean;
  readonly suggestedCommand?:
    | 'content.evolveGraph'
    | 'content.createTextbookPage'
    | 'content.proposeTextbookRevision'
    | 'content.cleanupReference'
    | string;
  readonly targetIds?: readonly string[];
  readonly detail?: GardeningYellowProposalDetail;
}

export type GardeningRedGuardRule =
  | 'sticky_protected'
  | 'user_authored_textbook_protected'
  | 'no_permanent_delete'
  | string;

export interface GardeningRedGuard {
  readonly guardId: string;
  readonly tier?: 'red';
  readonly rule: GardeningRedGuardRule;
  readonly blocked?: boolean;
  readonly assetKind?: 'entity' | 'edge' | 'textbook_page' | 'question' | 'chapter' | string;
  readonly assetId: string;
  readonly title: string;
  readonly blockedAction: string;
  readonly reason: string;
}

export interface GardeningInboxSummary {
  readonly greenCount: number;
  readonly yellowCount: number;
  readonly redCount: number;
  readonly duplicateConceptCount: number;
  readonly danglingReferenceCount: number;
  readonly staleUnusedDraftCount: number;
  readonly compressionCandidateCount: number;
}

export interface GardeningInboxPlan {
  readonly generatedAt?: string;
  readonly radar?: KbEntropyRadarReport;
  readonly green?: readonly GardeningGreenAction[];
  readonly yellow?: readonly GardeningYellowProposal[];
  readonly red?: readonly GardeningRedGuard[];
  readonly summary?: GardeningInboxSummary;
}

export type NormalizedGardeningCategory =
  | 'merge_duplicate_concepts'
  | 'cleanup_dangling_reference'
  | 'stale_draft'
  | 'propose_emergency_card'
  | 'propose_split_coarse_concept';

export interface NormalizedGardeningProposal {
  readonly proposalId: string;
  readonly rawKind: string;
  readonly category: NormalizedGardeningCategory;
  readonly title: string;
  readonly summary: string;
  readonly appendOnly: boolean;
  readonly suggestedCommand?: string;
  readonly targetIds: readonly string[];
  readonly detail: GardeningYellowProposalDetail;
}

export interface NormalizedGardeningGreenAction {
  readonly actionId: string;
  readonly actionKind: GardeningGreenActionKind;
  readonly targetKind?: string;
  readonly targetId: string;
  readonly title: string;
  readonly reason: string;
  readonly undoToken: string;
  readonly preview?: GardeningGreenActionPreview;
  readonly suggestedCommand?: string;
}

export interface NormalizedGardeningRedGuard {
  readonly guardId: string;
  readonly rule: GardeningRedGuardRule;
  readonly assetKind?: string;
  readonly assetId: string;
  readonly title: string;
  readonly blockedAction: string;
  readonly reason: string;
}

export interface NormalizedGardeningInbox {
  readonly generatedAt: string | null;
  readonly yellow: readonly NormalizedGardeningProposal[];
  readonly green: readonly NormalizedGardeningGreenAction[];
  readonly red: readonly NormalizedGardeningRedGuard[];
  readonly excludedCount: number;
}

export interface GardeningActionDecision {
  readonly proposalId: string;
  readonly proposalKind: string;
  readonly category: NormalizedGardeningCategory;
  readonly action: 'accept' | 'dismiss';
  readonly suggestedCommand?: string;
  readonly targetIds: readonly string[];
}

export interface GardeningInboxPanelProps {
  readonly plan?: GardeningInboxPlan | null;
  readonly radar?: KbEntropyRadarReport | null;
  readonly endpoint?: string | null;
  readonly actionsEndpoint?: string;
  readonly undoEndpoint?: string;
  readonly compactWhenEmpty?: boolean;
  readonly defaultExpanded?: boolean;
  readonly onDecision?: (decision: GardeningActionDecision) => void | Promise<void>;
  readonly onBatchDecision?: (decisions: readonly GardeningActionDecision[]) => void | Promise<void>;
  readonly onUndo?: (action: NormalizedGardeningGreenAction) => void | Promise<void>;
}

export interface PracticeQuestionPayload {
  readonly kind: 'archetype-representative' | 'cluster-member' | 'bank-question' | 'mistake-retry';
  readonly title: string;
  readonly prompt?: string;
  readonly archetypeTitle?: string;
  readonly mastery?: NormalizedMasteryState;
  readonly practice?: PracticeHandle;
  readonly sourceRef?: QuestionVersionRef;
  readonly paperId?: string;
  readonly questionId?: string;
  readonly anchorLabel?: string;
}

export interface CompanionCitationPayload {
  readonly kind: 'archetype' | 'question' | 'mistake';
  readonly title: string;
  readonly prompt?: string;
  readonly archetypeTitle?: string;
  readonly sourceLabel?: string;
  readonly mastery?: NormalizedMasteryState;
  readonly lastAnswer?: string;
  readonly expected?: string;
  readonly questionRef?: QuestionVersionRef;
  readonly paperId?: string;
}

export interface QuestionBankTabProps {
  readonly questions?: readonly RawBankQuestion[];
  readonly mistakes?: readonly RawMistakeEntry[];
  readonly folding?: RawArchetypeFoldingPayload | null;
  readonly foldingEndpoint?: string | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly defaultFoldByArchetype?: boolean;
  readonly defaultMistakesOnly?: boolean;
  readonly onPracticeQuestion?: (payload: PracticeQuestionPayload) => void | Promise<void>;
  readonly onCiteToCompanion?: (payload: CompanionCitationPayload) => void | Promise<void>;
  readonly onNavigate?: (href: string) => void;
  readonly headerAction?: ReactNode;
}

export interface MaterialsSurfaceProps {
  readonly activeTab?: MaterialsTabId;
  readonly defaultTab?: MaterialsTabId;
  readonly onTabChange?: (tab: MaterialsTabId) => void;
  readonly syncUrl?: boolean;
  readonly historyMode?: 'replace' | 'push';
  readonly title?: string;
  readonly subtitle?: string;
  readonly headerAction?: ReactNode;
  readonly theme?: 'light' | 'dark';
  readonly renderGraph?: () => ReactNode;
  readonly renderBank?: (defaultBankView: ReactNode) => ReactNode;
  readonly renderTextbooks?: () => ReactNode;
  readonly renderPapers?: () => ReactNode;
  readonly renderOriginals?: () => ReactNode;
  readonly bankProps?: QuestionBankTabProps;
  readonly gardeningProps?: GardeningInboxPanelProps;
  readonly onCaptureMaterial?: () => void;
  readonly onNavigate?: (href: string) => void;
}
