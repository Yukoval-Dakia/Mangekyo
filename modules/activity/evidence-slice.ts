import type { CanonicalEvidenceSliceV1, EvidenceEventV1, FactId, FactRef, Revision, Tick } from '@mangekyo/kernel';
import { projectHelpExposure, type AdmittedHelpEvent, type HelpExposureEvidence } from './help-exposure.ts';
import { helpAppliesTo, type HelpTarget } from './help-exposure-values.ts';
import type { AssessmentRevisionRef, FormalAssessmentValue } from './assessment-values.ts';
import type { WorkbookAttempt } from './workbook-values.ts';

export type ActivityEvidenceObservation = {
  submission: { id: FactId; rev: Revision };
  occurredAt: string;
  concepts: readonly string[];
  novelty: EvidenceEventV1['item_novelty'];
  helpLevel: EvidenceEventV1['help_level'] | 'unknown';
  result: EvidenceEventV1['outcome'];
  score?: number;
  duration?: number;
};

/** Project an authorized frozen whole paper and its settled result, if any. */
export function workbookExamPacingEvent(
  { id, rev }: FactRef, {submittedAt, effectiveDurationMs, paper}: WorkbookAttempt, frozen: AssessmentRevisionRef,
  formal?: { state: string; releaseRef: AssessmentRevisionRef; score: FormalAssessmentValue['score'] },
) {
  const releaseItems = paper.assessmentRelease?.items;
  const score = formal?.state === 'complete' && releaseItems?.length === paper.questions.length &&
    paper.questions.every(question => releaseItems.some(item => item.itemId === question.id)) ? formal.score : null;
  const scored = score && Number.isFinite(score.maximum) && score.maximum > 0 &&
    Number.isFinite(score.earned) && score.earned >= 0 && score.earned <= score.maximum;
  return {
    ref:id, rev, occurred_at:submittedAt, concept_ids:[], item_novelty:'same', help_level:'unknown',
    outcome:'unknown', claim_ids:[],
    ...(effectiveDurationMs === undefined ? {} : {effective_duration_ms:effectiveDurationMs}),
    exam_pacing: {
      paper_key:JSON.stringify([frozen.id,frozen.rev]),
      ...(scored && formal ? {
        scale_key:JSON.stringify(['workbook-formal-assessment@1',formal.releaseRef.id,formal.releaseRef.rev]),
        score:{earned:score.earned,maximum:score.maximum},
      } : {}),
    },
  } as const;
}

export function workbookExamPacingItems(ref: FactRef, attempt: WorkbookAttempt, frozen: AssessmentRevisionRef): EvidenceEventV1[] {
  if (!attempt.pacing || attempt.paperRev !== frozen.rev || attempt.paperId !== frozen.id) return [];
  const paperKey = JSON.stringify([frozen.id, frozen.rev]);
  const observed = new Map(attempt.pacing.items.map(item => [item.questionId, item]));
  return attempt.paper.questions.flatMap(({ id }, index) => {
    const item = observed.get(id);
    if (!item) return [];
    const anchor = { attempt_ref: { id: ref.id, rev: ref.rev }, paper_key: paperKey, item_id: id,
      position: index + 1, item_count: attempt.paper.questions.length };
    return [{
      ref: JSON.stringify([ref.id, id]), rev: ref.rev, occurred_at: attempt.submittedAt,
      concept_ids: [], item_novelty: 'same', help_level: 'unknown', outcome: 'unknown', claim_ids: [],
      effective_duration_ms: item.effectiveDurationMs,
      exam_pacing_item: item.skipped ? {
        ...anchor, skipped: true, ...(item.returned ? { returned: true } : {}),
      } : anchor,
    }];
  });
}

export function activityEvidenceSlice(
  watermark: Tick,
  asOf: string,
  deadline: CanonicalEvidenceSliceV1['constraints']['deadlines'][number] | undefined,
  observations: readonly ActivityEvidenceObservation[],
): CanonicalEvidenceSliceV1 {
  const events: EvidenceEventV1[] = [];
  const omissions: NonNullable<CanonicalEvidenceSliceV1['omissions']>[number][] = [];
  for (const row of observations) {
    if (row.occurredAt > asOf) throw new Error('证据晚于预测发起时间。');
    if (row.helpLevel === 'unknown') {
      omissions.push({ ref: row.submission, reason: 'unwitnessed-independence' });
      continue;
    }
    events.push({
      ref: row.submission.id, rev: row.submission.rev, occurred_at: row.occurredAt,
      concept_ids: row.concepts, item_novelty: row.novelty, help_level: row.helpLevel,
      outcome: row.result, claim_ids: [],
      ...(row.score === undefined ? {} : { score_norm: row.score }),
      ...(row.duration === undefined ? {} : { effective_duration_ms: row.duration }),
    });
  }
  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.ref.localeCompare(b.ref));
  return {
    clock_watermark: watermark, as_of_at: asOf, events, omissions,
    constraints: { budget_min: null, locks: [], deadlines: deadline ? [deadline] : [] }, candidate_pool: [],
  };
}

export function retentionExposure(observed: HelpExposureEvidence, level?: 'hint_l1' | 'hint_l2') {
  if (observed.kind === 'unexposed') return { kind: 'independent' as const };
  if (observed.kind === 'exposed') return {
    kind: 'exposed' as const, refs: observed.evidenceRefs.map(({ id, rev }) => ({ id, rev })),
    ...(level ? { level } : {}),
  };
  return { kind: 'unknown' as const, reason: observed.reason };
}

export function activityHelpProcess(observed: HelpExposureEvidence, events: readonly AdmittedHelpEvent[]) {
  const displayed = new Set(events.flatMap(({ ref, value }) => value.kind === 'displayed' &&
    observed.evidenceRefs.some(use => use.learner === ref.learner && use.id === ref.id && use.rev === ref.rev)
    ? [value.step.kind] : []));
  const ungraded = displayed.has('hint') || displayed.has('explanation') || displayed.has('worked-example');
  const level = ungraded || displayed.has('solution') ? undefined
    : displayed.has('hint_l2') ? 'hint_l2' : displayed.has('hint_l1') ? 'hint_l1' : undefined;
  const helpLevel: ActivityEvidenceObservation['helpLevel'] = observed.kind === 'unexposed' ? 'independent'
    : observed.kind === 'unknown' ? 'unknown'
    : displayed.has('solution') ? 'solution_seen' : level ?? 'hinted';
  return { exposure: retentionExposure(observed, level), helpLevel };
}

export function controlledWorkbookHelp(
  ref: FactRef, cutoff: Tick, mounts: readonly HelpTarget[], events: readonly AdmittedHelpEvent[],
  omitted: boolean, competingSubmission: boolean,
) {
  // Another attempt of this item can supply correctness feedback during this sitting.
  // A release without a display witness vetoes independence without claiming the learner saw it.
  const complete = ref.rev === 1 && !omitted && !competingSubmission
    && events.every(({ value }) => value.kind === 'displayed' && mounts.some(mount => helpAppliesTo(value, mount)));
  const results = mounts.map(target => projectHelpExposure({ submission: { ref, target, cutoff }, events,
    coverage: complete ? { submission: ref, target, through: cutoff } : null }));
  const evidenceRefs = results.flatMap(result => result.evidenceRefs).sort((a, b) => a.id.localeCompare(b.id));
  return activityHelpProcess(evidenceRefs.length ? { kind: 'exposed', evidenceRefs } : results[0]!, events);
}
