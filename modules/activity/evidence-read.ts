import type { FactId, FactRef, FactSnapshot, LearnerId, ReadContext, Revision, Tick } from '@mangekyo/kernel';
import type { AdmittedHelpEvent } from './help-exposure.ts';
import {
  helpExposure, helpExposureType, recordHelpExposureCommand, type HelpPresentation, type HelpRef,
} from './help-exposure-values.ts';
import { recallSubmissionType, submitRecallCommand } from './recall-values.ts';
import { closedPosttest, posttestIssuanceType, posttestSubmissionType } from './retention-posttest.ts';
import { submitWorkbookAttemptCommand, workbookAttemptType } from './workbook-values.ts';

export type ActivityEvidenceReadScope = {
  learner: LearnerId;
  query<Row>(sql: string, params: readonly (string | number | null | readonly string[])[]):
    Promise<{ rows: readonly Row[] }>;
};

const submissionCommands = {
  [workbookAttemptType]: submitWorkbookAttemptCommand,
  [posttestSubmissionType]: submitWorkbookAttemptCommand,
  [recallSubmissionType]: submitRecallCommand,
} as const;

export async function readActivitySubmissionBirth(
  tx: ActivityEvidenceReadScope, ref: FactRef, type: keyof typeof submissionCommands,
) {
  if (ref.learner !== tx.learner) return;
  const { rows: [birth] } = await tx.query<{
    tick: Tick; recorded_tick: Tick; unchanged: boolean; submitted_at: string | null; condition: string | null;
  }>(
    `SELECT r.tick::text AS tick, c.input->'input'->'data'->>'submittedAt' AS submitted_at,
       selected.tick::text AS recorded_tick, selected.data=r.data AS unchanged,
       c.input->'input'->>'condition' AS condition
     FROM fact_revs r JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
     JOIN fact_revs selected ON (selected.learner_id,selected.fact_id,selected.rev)=(r.learner_id,r.fact_id,$5)
     JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
     WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.kind='value' AND r.author='learner'
       AND selected.kind='value' AND f.type=$3 AND c.type=$4 AND c.state='done'`,
    [tx.learner, ref.id, type, submissionCommands[type], ref.rev],
  );
  const condition = type === posttestSubmissionType ? closedPosttest : null;
  return birth?.condition === condition
    ? {tick: birth.tick, recordedAt: birth.recorded_tick, unchanged: birth.unchanged, submittedAt: birth.submitted_at}
    : undefined;
}

export async function readActivityHelpEvents(
  tx: ActivityEvidenceReadScope, read: ReadContext, query: {
    activities: readonly FactId[];
    cutoff: Tick;
    mode: 'pinned' | 'following';
    issuance?: HelpRef;
    includeOpens?: boolean;
  },
  admit: ((fact: FactSnapshot, event: HelpPresentation) => Promise<boolean>) | undefined,
  unavailable: (error: unknown) => boolean,
) {
  const { rows } = await tx.query<{ id: FactId; tick: Tick; unchanged: boolean }>(
    `SELECT f.id, r.tick::text, visible.data=r.data AS unchanged
     FROM fact_revs r JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
     JOIN fact_revs visible ON (visible.learner_id,visible.fact_id,visible.rev)=(f.learner_id,f.id,f.current_rev)
     JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
     WHERE r.learner_id=$1 AND f.type=$2 AND c.type=$3 AND c.state='done'
       AND r.rev=1 AND r.kind='value' AND r.tick<$4::bigint AND r.data->>'kind'=ANY($5::text[])
       AND (r.data->'mount'->>'activityId'=ANY($6::text[]) OR r.data->'mount'->'issuance'->>'id'=ANY($6::text[]))
       AND ($7::jsonb IS NULL OR r.data->'mount'->'issuance' @> $7::jsonb)`,
    [tx.learner, helpExposureType, recordHelpExposureCommand, query.cutoff,
      query.includeOpens ? ['opened','displayed'] : ['displayed'], query.activities,
      query.issuance ? JSON.stringify(query.issuance) : null],
  );
  const events: AdmittedHelpEvent[] = [];
  let omitted = false;
  for (const row of rows) {
    try {
      if (query.mode === 'following' && !row.unchanged) {
        omitted = true;
        continue;
      }
      const fact = await read.fact(row.id, query.mode === 'pinned'
        ? { mode: 'pinned', rev: 1 as Revision } : { mode: 'following' });
      const value = helpExposure(fact.value);
      if (value.kind !== 'displayed' && value.kind !== 'opened') continue;
      if (!admit || await admit(fact, value)) {
        events.push({ ref: fact.ref, value, admittedAt: row.tick });
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
      omitted = true;
    }
  }
  return { events, omitted };
}

export async function readEarlierControlledPosttests(
  tx: ActivityEvidenceReadScope, paperId: FactId, started: Tick, cutoff: Tick,
) {
  // Include earlier issuances of the same frozen source, where a solution could have been released.
  // Withdrawal of a help record cannot restore complete coverage.
  const { rows } = await tx.query<{ id: string; competing_submission: boolean }>(
    `SELECT i.fact_id AS id, EXISTS (
       SELECT 1 FROM fact_revs r JOIN facts f ON f.learner_id=r.learner_id AND f.id=r.fact_id
       WHERE r.learner_id=i.learner_id AND r.rev=1 AND r.data->>'paperId'=i.fact_id AND f.type=$4
         AND r.tick>$5::bigint AND r.tick<$6::bigint
     ) AS competing_submission
     FROM fact_revs i JOIN facts f ON f.learner_id=i.learner_id AND f.id=i.fact_id
     WHERE i.learner_id=$1 AND i.rev=1 AND f.type=$2 AND i.data->'paper'->>'id'=$3 AND i.tick<$6::bigint`,
    [tx.learner, posttestIssuanceType, paperId, posttestSubmissionType, started, cutoff],
  );
  return rows;
}
