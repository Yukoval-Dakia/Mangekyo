import type { CanonicalEvidenceSliceV1, EvidenceEventV1, FactId, FactRef, Revision, Tick } from '@mangekyo/kernel';
import { projectHelpExposure, type AdmittedHelpEvent, type HelpExposureEvidence } from './help-exposure.ts';
import { helpAppliesTo, type HelpTarget } from './help-exposure-values.ts';

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

export function activityEvidenceSlice(
  watermark: Tick,
  asOf: string,
  deadline: CanonicalEvidenceSliceV1['constraints']['deadlines'][number],
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
    constraints: { budget_min: null, locks: [], deadlines: [deadline] }, candidate_pool: [],
  };
}

export function retentionExposure(observed: HelpExposureEvidence) {
  if (observed.kind === 'unexposed') return { kind: 'independent' as const };
  if (observed.kind === 'exposed') return {
    kind: 'exposed' as const, refs: observed.evidenceRefs.map(({ id, rev }) => ({ id, rev })),
  };
  return { kind: 'unknown' as const, reason: observed.reason };
}

export function activityHelpProcess(observed: HelpExposureEvidence, events: readonly AdmittedHelpEvent[]) {
  const evidence = events.filter(({ ref }) => observed.evidenceRefs.some(use => use.id === ref.id && use.rev === ref.rev));
  const helpLevel = observed.kind === 'unexposed' ? 'independent' as const
    : observed.kind === 'unknown' ? 'unknown' as const
    : evidence.some(({ value }) => value.kind === 'displayed' && value.step.kind === 'solution')
      ? 'solution_seen' as const : 'hinted' as const;
  return { exposure: retentionExposure(observed), helpLevel };
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
