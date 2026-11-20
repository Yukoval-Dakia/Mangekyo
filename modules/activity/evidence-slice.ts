import type { CanonicalEvidenceSliceV1, EvidenceEventV1, FactId, Revision, Tick } from '@mangekyo/kernel';

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
