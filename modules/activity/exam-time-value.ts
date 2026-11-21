import {
  factId, FactNotFoundError, type CanonicalEvidenceSliceV1, type EvidenceEventV1,
  type FactId, type FactSnapshot, type ReadContext, type Revision, type Tick,
} from '@mangekyo/kernel';
import type { AssessmentResult, AssessmentRevisionRef, FormalAssessmentValue } from './assessment-values.ts';
import { readActivitySubmissionBirth, type ActivityEvidenceReadScope } from './evidence-read.ts';
import { activityEvidenceSlice, workbookExamPacingItems } from './evidence-slice.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
  WorkbookSourceMismatch, type WorkbookAttempt,
} from './workbook-values.ts';

export const examTimeValueMethod = 'plan/exam-pacing@2' as const;

export type ExamTimeValueRef = { readonly id: FactId; readonly rev: Revision };
export type ExamTimeValueState = 'steady' | 'fast-slip' | 'time-sink' | 'recovered-skip' | 'unknown';
export type ExamTimeValueItem = {
  readonly item_id: string;
  readonly position: number;
  readonly effective_duration_ms: number;
  readonly state: ExamTimeValueState;
};
export type ExamTimeValueView = {
  readonly paper: ExamTimeValueRef;
  readonly attempt_ref: ExamTimeValueRef;
  readonly method_version: typeof examTimeValueMethod;
} & (
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'observed';
      readonly total_duration_ms: number;
      readonly items: readonly ExamTimeValueItem[];
      readonly summary: string;
    }
);

export type ExamTimeValueEstimate = {
  readonly itemId: string;
  readonly estimatedDurationMs: number;
  readonly ref: string;
  readonly rev: Revision;
  readonly occurredAt: string;
};

export type ExamTimeValueFormalInput = {
  readonly state: string;
  readonly derivationId?: string;
  readonly releaseRef: AssessmentRevisionRef;
  readonly score: FormalAssessmentValue['score'];
  readonly result?: AssessmentResult;
  readonly assessedAt?: string;
};

export type ExamTimeValueSliceRequest = {
  readonly attempt_ref: ExamTimeValueRef;
  readonly slice: CanonicalEvidenceSliceV1;
};

const validStates = new Set<ExamTimeValueState>(['steady', 'fast-slip', 'time-sink', 'recovered-skip', 'unknown']);

export function unknownExamTimeValue(paper: ExamTimeValueRef, attemptRef: ExamTimeValueRef): ExamTimeValueView {
  return { method_version: examTimeValueMethod, paper, attempt_ref: attemptRef, kind: 'unknown' };
}

function authoritativeItemDurations(attempt: WorkbookAttempt, paperRef: ExamTimeValueRef) {
  const total = attempt.effectiveDurationMs;
  const pacing = attempt.pacing;
  const questions = attempt.paper.questions;
  if (!questions.length || attempt.paperId !== paperRef.id || attempt.paperRev !== paperRef.rev ||
      total === undefined || !Number.isSafeInteger(total) || total <= 0 || total > 86_400_000 ||
      pacing?.version !== 1 || pacing.items.length !== questions.length) return undefined;
  const durations = new Map<string, number>();
  const positions = new Map(questions.map((question, index) => [question.id, index + 1] as const));
  let recorded = 0;
  for (const item of pacing.items) {
    if (!positions.has(item.questionId) || durations.has(item.questionId) ||
        !Number.isSafeInteger(item.effectiveDurationMs) || item.effectiveDurationMs < 0 || item.effectiveDurationMs > 86_400_000) {
      return undefined;
    }
    durations.set(item.questionId, item.effectiveDurationMs);
    recorded += item.effectiveDurationMs;
  }
  if (recorded <= 0 || recorded > total) return undefined;
  return { total, recorded, durations, positions };
}

function settledItemScore(
  item: NonNullable<WorkbookAttempt['paper']['assessmentRelease']>['items'][number],
  outcomes: AssessmentResult['outcomes'],
) {
  let earned = 0;
  let maximum = 0;
  for (const criterion of item.criteria) {
    const matched = outcomes.filter(outcome => outcome.itemId === item.itemId && outcome.criterionId === criterion.criterionId);
    if (matched.length !== 1) return undefined;
    const [outcome] = matched;
    if (criterion.maximum === null) {
      if (outcome!.state !== 'qualitative') return undefined;
      continue;
    }
    if (outcome!.state !== 'scored' || !Number.isFinite(outcome!.earned) || outcome!.earned < 0 || outcome!.earned > criterion.maximum) {
      return undefined;
    }
    earned += outcome!.earned;
    maximum += criterion.maximum;
  }
  if (!Number.isFinite(maximum) || maximum <= 0 || earned < 0 || earned > maximum) return undefined;
  return { earned, maximum };
}

export function buildWorkbookExamTimeValueInput(params: {
  readonly learner: FactId | string;
  readonly paperRef: ExamTimeValueRef;
  readonly attemptRef: ExamTimeValueRef;
  readonly attempt: WorkbookAttempt;
  readonly watermark: Tick;
  readonly asOfAt: string;
  readonly formal?: ExamTimeValueFormalInput;
  readonly estimates?: readonly ExamTimeValueEstimate[];
  readonly errorStages?: Readonly<Record<string, NonNullable<EvidenceEventV1['error_stage']>>>;
}): { readonly request: ExamTimeValueSliceRequest; readonly recordedDurationMs: number } | undefined {
  const { paperRef, attemptRef, attempt, watermark, asOfAt, formal, estimates, errorStages } = params;
  const timing = authoritativeItemDurations(attempt, paperRef);
  const release = attempt.paper.assessmentRelease;
  if (!timing || !release || !formal?.derivationId || !formal.result) return undefined;
  if (formal.state !== 'complete' && formal.state !== 'partial') return undefined;
  if (formal.releaseRef.id !== paperRef.id || formal.releaseRef.rev !== release.releaseRef.rev ||
      formal.result.releaseRef.id !== formal.releaseRef.id || formal.result.releaseRef.rev !== formal.releaseRef.rev ||
      formal.result.submissionRef.id !== attemptRef.id || formal.result.submissionRef.rev > attemptRef.rev) {
    return undefined;
  }
  const paperKey = JSON.stringify([paperRef.id, paperRef.rev]);
  const scaleKey = JSON.stringify(['workbook-formal-assessment@1', formal.releaseRef.id, formal.releaseRef.rev]);
  const processEvents = workbookExamPacingItems({ learner: params.learner as never, ...attemptRef }, attempt, paperRef);
  if (processEvents.length !== attempt.paper.questions.length) return undefined;
  const seenProcess = new Set<string>();
  const processRefByItem = new Map<string, string>();
  for (const event of processEvents) {
    const witnessKey = JSON.stringify([event.ref, event.rev]);
    if (seenProcess.has(witnessKey) || !event.exam_pacing_item) return undefined;
    seenProcess.add(witnessKey);
    processRefByItem.set(event.exam_pacing_item.item_id, event.ref);
  }

  const formalOccurredAt = formal.assessedAt && Date.parse(formal.assessedAt) >= Date.parse(attempt.submittedAt)
    ? formal.assessedAt : attempt.submittedAt;
  const formalEvents: EvidenceEventV1[] = [];
  const formalRefByItem = new Map<string, string>();
  for (const item of release.items) {
    const position = timing.positions.get(item.itemId);
    if (!position) continue;
    const score = settledItemScore(item, formal.result.outcomes);
    if (!score) continue;
    const ref = JSON.stringify(['formal', formal.derivationId, item.itemId]);
    if (ref === processRefByItem.get(item.itemId)) return undefined;
    formalRefByItem.set(item.itemId, ref);
    const errorStage = errorStages?.[item.itemId];
    formalEvents.push({
      ref, rev: 1 as Revision, occurred_at: formalOccurredAt,
      concept_ids: [], item_novelty: 'same', help_level: 'unknown', outcome: 'unknown', claim_ids: [],
      ...(errorStage ? { error_stage: errorStage } : {}),
      exam_pacing_item: {
        attempt_ref: attemptRef, paper_key: paperKey, item_id: item.itemId,
        position, item_count: attempt.paper.questions.length, scale_key: scaleKey, score,
      },
    });
  }
  if (!formalEvents.length) return undefined;

  const estimateEvents: EvidenceEventV1[] = [];
  const seenEstimateItems = new Set<string>();
  for (const entry of estimates ?? []) {
    const position = timing.positions.get(entry.itemId);
    if (!position || seenEstimateItems.has(entry.itemId)) continue;
    if (!Number.isSafeInteger(entry.estimatedDurationMs) || entry.estimatedDurationMs < 1 || entry.estimatedDurationMs > 86_400_000) continue;
    if (!entry.ref.trim() || entry.ref === processRefByItem.get(entry.itemId) || entry.ref === formalRefByItem.get(entry.itemId)) continue;
    if (!(Date.parse(entry.occurredAt) <= Date.parse(attempt.submittedAt))) continue;
    seenEstimateItems.add(entry.itemId);
    estimateEvents.push({
      ref: entry.ref, rev: entry.rev, occurred_at: entry.occurredAt,
      concept_ids: [], item_novelty: 'same', help_level: 'unknown', outcome: 'unknown', claim_ids: [],
      exam_pacing_item: {
        attempt_ref: attemptRef, paper_key: paperKey, item_id: entry.itemId,
        position, item_count: attempt.paper.questions.length, estimated_duration_ms: entry.estimatedDurationMs,
      },
    });
  }

  const wholePaperCovered = formal.state === 'complete' && release.items.length === attempt.paper.questions.length &&
    attempt.paper.questions.every(question => release.items.some(item => item.itemId === question.id));
  const wholeScore = wholePaperCovered && formal.score && Number.isFinite(formal.score.maximum) && formal.score.maximum > 0 &&
    Number.isFinite(formal.score.earned) && formal.score.earned >= 0 && formal.score.earned <= formal.score.maximum
    ? { earned: formal.score.earned, maximum: formal.score.maximum } : undefined;
  const attemptEvent: EvidenceEventV1 = {
    ref: attemptRef.id, rev: attemptRef.rev, occurred_at: attempt.submittedAt,
    concept_ids: [], item_novelty: 'same', help_level: 'unknown', outcome: 'unknown', claim_ids: [],
    effective_duration_ms: timing.total,
    exam_pacing: { paper_key: paperKey, scale_key: scaleKey, ...(wholeScore ? { score: wholeScore } : {}) },
  };
  const sliceAsOf = [asOfAt, attempt.submittedAt, formalOccurredAt]
    .toSorted((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1)!;
  const slice: CanonicalEvidenceSliceV1 = {
    ...activityEvidenceSlice(watermark, sliceAsOf, undefined, []),
    events: [attemptEvent, ...processEvents, ...formalEvents, ...estimateEvents],
  };
  return { request: { attempt_ref: attemptRef, slice }, recordedDurationMs: timing.recorded };
}

export function projectWorkbookExamTimeValue(params: {
  readonly paperRef: ExamTimeValueRef;
  readonly attemptRef: ExamTimeValueRef;
  readonly attempt: WorkbookAttempt;
  readonly rawResult: unknown;
}): ExamTimeValueView {
  const { paperRef, attemptRef, attempt, rawResult } = params;
  const fallback = unknownExamTimeValue(paperRef, attemptRef);
  const timing = authoritativeItemDurations(attempt, paperRef);
  if (!timing || !rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) return fallback;
  const candidate = rawResult as Record<string, unknown>;
  const ref = candidate.attempt_ref as Record<string, unknown> | undefined;
  if (candidate.method_version !== examTimeValueMethod || candidate.kind !== 'observed' ||
      ref?.id !== attemptRef.id || ref?.rev !== attemptRef.rev ||
      candidate.total_duration_ms !== timing.recorded ||
      typeof candidate.summary !== 'string' || !candidate.summary.trim() ||
      !Array.isArray(candidate.items) || candidate.items.length !== attempt.paper.questions.length) {
    return fallback;
  }
  const items: ExamTimeValueItem[] = [];
  for (let index = 0; index < attempt.paper.questions.length; index++) {
    const question = attempt.paper.questions[index]!;
    const row = candidate.items[index] as Record<string, unknown> | undefined;
    if (!row || row.position !== index + 1 || row.item_id !== question.id ||
        row.effective_duration_ms !== timing.durations.get(question.id) ||
        typeof row.state !== 'string' || !validStates.has(row.state as ExamTimeValueState)) {
      return fallback;
    }
    items.push({
      item_id: question.id,
      position: index + 1,
      effective_duration_ms: row.effective_duration_ms as number,
      state: row.state as ExamTimeValueState,
    });
  }
  return {
    method_version: examTimeValueMethod,
    paper: paperRef,
    attempt_ref: attemptRef,
    kind: 'observed',
    total_duration_ms: timing.recorded,
    items,
    summary: candidate.summary,
  };
}

type FactReader = { fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot> };

export type AuthorizedExamTimeValueBundle = {
  readonly paperRef: ExamTimeValueRef;
  readonly attemptRef: ExamTimeValueRef;
  readonly paperEpoch: string;
  readonly submissionEpoch: string;
  readonly attempt: WorkbookAttempt;
  readonly request: ExamTimeValueSliceRequest;
  readonly purpose: string;
};

async function openFrozenPaperForTimeValue(params: {
  readonly read: FactReader;
  readonly paperId: FactId;
  readonly paperRev: Revision;
  readonly attemptPaper: WorkbookAttempt['paper'];
  readonly isPurposeDenied: (error: unknown) => boolean;
  readonly onlyGrantsChanged: (id: FactId, before: Revision, after: Revision) => Promise<boolean>;
}) {
  const matches = (fact: FactSnapshot) => fact.type === workbookPaperType && sameWorkbookJson(workbookPaper(fact.value), params.attemptPaper);
  try {
    const pinned = await params.read.fact(params.paperId, { mode: 'pinned', rev: params.paperRev });
    return matches(pinned) ? pinned : undefined;
  } catch (error) {
    if (!params.isPurposeDenied(error)) throw error;
    const current = await params.read.fact(params.paperId, { mode: 'following' });
    if (!matches(current) || !await params.onlyGrantsChanged(params.paperId, params.paperRev, current.ref.rev)) return undefined;
    return current;
  }
}

export async function gatherAuthorizedExamTimeValueBundle(ports: {
  readonly tx: ActivityEvidenceReadScope;
  readonly read: FactReader;
  readonly paperId: FactId;
  readonly attemptId: FactId;
  readonly purpose: string;
  readonly asOfAt: string;
  readonly estimates?: readonly ExamTimeValueEstimate[];
  readonly errorStages?: Readonly<Record<string, NonNullable<EvidenceEventV1['error_stage']>>>;
  readonly isUnavailable: (error: unknown) => boolean;
  readonly isPurposeDenied: (error: unknown) => boolean;
  readonly onlyGrantsChanged: (id: FactId, before: Revision, after: Revision) => Promise<boolean>;
  readonly readFormal: (
    release: NonNullable<WorkbookAttempt['paper']['assessmentRelease']>,
    attemptRef: ExamTimeValueRef,
    epochs: { releaseEpoch: string; submissionEpoch: string },
  ) => Promise<ExamTimeValueFormalInput>;
}): Promise<AuthorizedExamTimeValueBundle | undefined> {
  try {
    const submission = await ports.read.fact(ports.attemptId, { mode: 'following' });
    if (submission.type !== workbookAttemptType) return undefined;
    const attempt = workbookAttempt(submission.value);
    if (attempt.paperId !== ports.paperId || attempt.paperRev === undefined || !attempt.paper.assessmentRelease) return undefined;
    const birth = await readActivitySubmissionBirth(ports.tx, submission.ref, workbookAttemptType);
    if (!birth?.unchanged || birth.submittedAt !== attempt.submittedAt) return undefined;
    const paper = await openFrozenPaperForTimeValue({
      read: ports.read, paperId: ports.paperId, paperRev: attempt.paperRev, attemptPaper: attempt.paper,
      isPurposeDenied: ports.isPurposeDenied, onlyGrantsChanged: ports.onlyGrantsChanged,
    });
    if (!paper) return undefined;
    if (attempt.paper.materialId !== null) await ports.read.fact(factId(attempt.paper.materialId), { mode: 'following' });
    await readFrozenWorkbookBank(ports.read as Pick<ReadContext, 'fact'>, attempt.paper);
    const paperRef: ExamTimeValueRef = { id: ports.paperId, rev: attempt.paperRev };
    const attemptRef: ExamTimeValueRef = { id: ports.attemptId, rev: submission.ref.rev };
    const formal = await ports.readFormal(attempt.paper.assessmentRelease, attemptRef, {
      releaseEpoch: paper.accessEpoch, submissionEpoch: submission.accessEpoch,
    });
    const { rows: [clockRow] } = await ports.tx.query<{ tick: Tick }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [ports.tx.learner]);
    const built = buildWorkbookExamTimeValueInput({
      learner: ports.tx.learner, paperRef, attemptRef, attempt,
      watermark: clockRow?.tick ?? ('0' as Tick), asOfAt: ports.asOfAt, formal,
      ...(ports.estimates ? { estimates: ports.estimates } : {}),
      ...(ports.errorStages ? { errorStages: ports.errorStages } : {}),
    });
    return built ? {
      paperRef, attemptRef, paperEpoch: paper.accessEpoch, submissionEpoch: submission.accessEpoch,
      attempt, request: built.request, purpose: ports.purpose,
    } : undefined;
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof WorkbookSourceMismatch || ports.isUnavailable(error)) return undefined;
    throw error;
  }
}

export async function revalidateAuthorizedExamTimeValueBundle(ports: {
  readonly read: FactReader;
  readonly bundle: AuthorizedExamTimeValueBundle;
  readonly isUnavailable: (error: unknown) => boolean;
  readonly isPurposeDenied: (error: unknown) => boolean;
  readonly onlyGrantsChanged: (id: FactId, before: Revision, after: Revision) => Promise<boolean>;
  readonly readFormal: (
    release: NonNullable<WorkbookAttempt['paper']['assessmentRelease']>,
    attemptRef: ExamTimeValueRef,
    epochs: { releaseEpoch: string; submissionEpoch: string },
  ) => Promise<Pick<ExamTimeValueFormalInput, 'state' | 'derivationId'>>;
}): Promise<boolean> {
  const { bundle } = ports;
  try {
    const submission = await ports.read.fact(bundle.attemptRef.id, { mode: 'following' });
    const paper = await openFrozenPaperForTimeValue({
      read: ports.read, paperId: bundle.paperRef.id, paperRev: bundle.paperRef.rev, attemptPaper: bundle.attempt.paper,
      isPurposeDenied: ports.isPurposeDenied, onlyGrantsChanged: ports.onlyGrantsChanged,
    });
    if (submission.type !== workbookAttemptType || !paper ||
        submission.ref.rev !== bundle.attemptRef.rev || submission.accessEpoch !== bundle.submissionEpoch ||
        paper.accessEpoch !== bundle.paperEpoch) return false;
    const release = bundle.attempt.paper.assessmentRelease;
    if (!release) return false;
    if (bundle.attempt.paper.materialId !== null) await ports.read.fact(factId(bundle.attempt.paper.materialId), { mode: 'following' });
    await readFrozenWorkbookBank(ports.read as Pick<ReadContext, 'fact'>, bundle.attempt.paper);
    const formal = await ports.readFormal(release, bundle.attemptRef, {
      releaseEpoch: bundle.paperEpoch, submissionEpoch: bundle.submissionEpoch,
    });
    return (formal.state === 'complete' || formal.state === 'partial') && Boolean(formal.derivationId);
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof WorkbookSourceMismatch || ports.isUnavailable(error)) return false;
    throw error;
  }
}
