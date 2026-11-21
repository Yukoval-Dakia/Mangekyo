export function followingRevisionFloor(fact: string, purpose: string) {
  return `CASE WHEN ${fact}.current_rev=1 THEN 1 ELSE (
    WITH RECURSIVE equivalent(rev) AS (
      SELECT ${fact}.current_rev
      UNION ALL
      SELECT equivalent.rev-1 FROM equivalent
      JOIN fact_revs revision ON (revision.learner_id,revision.fact_id,revision.rev)=
        (${fact}.learner_id,${fact}.id,equivalent.rev)
      JOIN commands command ON (command.learner_id,command.id)=(revision.learner_id,revision.command_id)
      WHERE equivalent.rev>1 AND command.state='done' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(command.receipt->'scopedPurposeChanges') AS entry(change)
        WHERE entry.change @> jsonb_build_object('id',revision.fact_id,'rev',revision.rev)
          AND entry.change->>'purpose' <> ${purpose}
      )
    ) SELECT min(rev) FROM equivalent
  ) END`;
}

export function followingWitnessMatches(fact: string, floor: string, rev: string, epoch: string) {
  return `(CASE
    WHEN ${rev} = ${fact}.current_rev THEN ${fact}.access_epoch::text = ${epoch}
    WHEN ${rev} < ${fact}.current_rev AND (${fact}.access_epoch - (${fact}.current_rev - ${rev}))::text = ${epoch}
      THEN ${rev} >= ${floor}
    ELSE false
  END)`;
}
