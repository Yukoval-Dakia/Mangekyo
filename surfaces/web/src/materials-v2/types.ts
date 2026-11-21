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

export interface NormalizedArchetypeCluster {
  readonly key: string;
  readonly title: string;
  readonly coveredQuestionCount: number;
  readonly counts: NormalizedMasteryCounts;
  readonly variationDimensions: readonly string[];
  readonly members: readonly NormalizedArchetypeMember[];
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
  readonly hiddenClusterCount: number;
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
  readonly onCaptureMaterial?: () => void;
  readonly onNavigate?: (href: string) => void;
}
