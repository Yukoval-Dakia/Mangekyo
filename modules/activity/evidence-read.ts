import type { FactId, FactRef, FactSnapshot, LearnerId, ReadContext, Revision, Tick } from '@mangekyo/kernel';
import type { AdmittedHelpEvent } from './help-exposure.ts';
import {
  helpExposure, helpExposureType, recordHelpExposureCommand, type HelpPresentation, type HelpRef,
} from './help-exposure-values.ts';
import { recallSubmissionType, submitRecallCommand } from './recall-values.ts';
import { closedPosttest, issuePosttestCommand, posttestIssuanceType, posttestSubmissionType, retentionPaperType } from './retention-posttest.ts';
import { submitWorkbookAttemptCommand, workbookAttemptType, workbookPaperType, type WorkbookSourceQuestionRef } from './workbook-values.ts';
import { recordWorkbookPresentationCommand, workbookPresentationType } from './workbook-presentation.ts';

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

/** A later single-fact grant may license the same frozen question. Every intervening revision
 * must preserve the complete original, including its private scoring fields.
 * The host still opens the selected copy and its dependencies for the actual recipient.
 */
export async function licensedQuestionCopy(tx: ActivityEvidenceReadScope, source: WorkbookSourceQuestionRef, purpose: string) {
  const {rows: [copy]} = await tx.query<{rev: Revision}>(`
    SELECT f.current_rev AS rev FROM facts f
    JOIN fact_revs original ON (original.learner_id,original.fact_id,original.rev)=(f.learner_id,f.id,$3)
    WHERE f.learner_id=$1 AND f.id=$2 AND f.retracted_rev IS NULL AND $4=ANY(f.purpose)
      AND NOT original.purpose && ARRAY[$4,'all'] AND original.kind='value' AND original.rev<f.current_rev
      AND NOT EXISTS (SELECT 1 FROM fact_revs r WHERE (r.learner_id,r.fact_id)=(f.learner_id,f.id)
        AND r.rev>original.rev AND (r.kind<>'value' OR r.data IS DISTINCT FROM original.data))`,
    [tx.learner, source.id, source.rev, purpose]);
  return copy ? {...source, rev: copy.rev} : source;
}

export async function frozenWorkbookRevision(tx: ActivityEvidenceReadScope, id: FactId, cutoff: Tick, releaseRevision: Revision | null) {
  const { rows: [version] } = await tx.query<{ rev: Revision }>(
    `SELECT rev FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND tick<$3::bigint AND kind='value'
       AND ($4::int IS NULL OR rev=$4) ORDER BY rev DESC LIMIT 1`,
    [tx.learner, id, cutoff, releaseRevision],
  );
  return version;
}

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

export async function readPosttestIssuanceBirth(tx: ActivityEvidenceReadScope, id: FactId) {
  const { rows: [birth] } = await tx.query<{ tick: Tick }>(
    `SELECT r.tick::text FROM fact_revs r
     JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
     WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.kind='value' AND r.author='learner'
       AND c.type=$3 AND c.state='done' AND r.data=c.input->'input'->'data'`,
    [tx.learner, id, issuePosttestCommand],
  );
  return birth;
}

export type WorkbookHistoryTarget = { paper: HelpRef; itemId: string };

export function throughTick(tick: Tick) {
  return String(BigInt(tick) + 1n) as Tick;
}

/** These queries identify candidates or check a watermark. The caller still opens each witness. */
export async function workbookLinkCandidates(
  tx: ActivityEvidenceReadScope, type: string, source: WorkbookSourceQuestionRef, through: Tick,
  kinds: readonly ('targets_concept' | 'variant_of')[],
) {
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT f.id FROM facts f JOIN fact_revs r
       ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND r.tick<=$3 AND r.data->>'kind'=ANY($4::text[])
       AND (r.data->'from'->'sourceUse' @> $5::jsonb OR
            (r.data->>'kind'='variant_of' AND r.data->'to'->'sourceUse' @> $5::jsonb))
     ORDER BY f.id`, [tx.learner, type, through, kinds, JSON.stringify(source)]);
  return rows;
}

export async function workbookWitnessesBy(
  tx: ActivityEvidenceReadScope, refs: readonly { id: FactId; rev: Revision }[], through: Tick,
) {
  const { rows: [check] } = await tx.query<{ complete: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS witness(id text,rev integer)
       LEFT JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=($1,witness.id,witness.rev)
       WHERE r.tick IS NULL OR r.tick>$3
     ) AS complete`, [tx.learner, JSON.stringify(refs), through]);
  return check?.complete === true;
}

/** Private veto over immutable event births. A new revision of the same source cannot erase exposure.
 * Positive evidence still requires the exact authorized source revision and access epoch.
 */
export async function workbookItemHistory(
  tx: ActivityEvidenceReadScope, target: WorkbookHistoryTarget, before: Tick, ownIssuance?: FactId,
) {
  const { rows: [row] } = await tx.query<{ seen: boolean; cross_help: boolean }>(
    `WITH fence AS (
      SELECT LEAST($5::bigint, min(r.tick)) AS tick
      FROM fact_revs r JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
        JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
      WHERE r.learner_id=$1 AND r.rev=1 AND r.author='learner' AND f.type=$14 AND c.type=$10
        AND r.data->>'paperId'=$6
    ), item AS (
      SELECT q->'sourceQuestionRef'->>'id' AS source_id FROM fact_revs r
        CROSS JOIN LATERAL jsonb_array_elements(r.data->'questions') q
      WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=$3 AND q->>'id'=$4
    ), releases AS (
      SELECT p.fact_id AS paper_id, p.fact_id AS mount_id, p.rev AS mount_rev, p.data, false AS controlled
      FROM fact_revs p JOIN facts f ON (f.learner_id,f.id)=(p.learner_id,p.fact_id)
      WHERE p.learner_id=$1 AND f.type=ANY($7::text[]) AND p.kind='value' AND p.tick<(SELECT tick FROM fence)
      UNION ALL
      SELECT p.fact_id, i.fact_id, i.rev, p.data, true
      FROM fact_revs i JOIN facts f ON (f.learner_id,f.id)=(i.learner_id,i.fact_id)
      JOIN commands c ON (c.learner_id,c.id)=(i.learner_id,i.command_id)
      JOIN fact_revs p ON (p.learner_id,p.fact_id,p.rev)=
        (i.learner_id,i.data->'paper'->>'id',(i.data->'paper'->>'rev')::int)
      WHERE i.learner_id=$1 AND f.type=$8 AND c.type=$9 AND i.author='learner' AND i.rev=1
        AND i.tick<(SELECT tick FROM fence) AND i.fact_id IS DISTINCT FROM $6
    ), matches AS (
      SELECT r.paper_id,r.mount_id,r.mount_rev,r.controlled,q->>'id' AS item_id FROM releases r
        CROSS JOIN LATERAL jsonb_array_elements(r.data->'questions') q CROSS JOIN item
      WHERE (r.paper_id=$2 AND q->>'id'=$4) OR q->'sourceQuestionRef'->>'id'=item.source_id
    ), assignments AS (
      SELECT r.data, f.type FROM fact_revs r JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
        JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
      WHERE r.learner_id=$1 AND r.rev=1 AND r.author='learner' AND r.tick<(SELECT tick FROM fence) AND c.type=$10
        AND f.type=ANY($11::text[])
    ), attempted AS (
      SELECT DISTINCT m.paper_id, m.controlled,
        EXISTS (SELECT 1 FROM jsonb_array_elements(a.data->'feedback') b
          WHERE b->>'questionId'=m.item_id AND b->>'result'<>'unanswered') AS feedback
      FROM assignments a CROSS JOIN item CROSS JOIN LATERAL jsonb_array_elements(a.data->'paper'->'questions') q
      JOIN matches m ON m.mount_id=a.data->>'paperId' AND m.item_id=q->>'id'
      WHERE (m.paper_id=$2 AND m.item_id=$4) OR q->'sourceQuestionRef'->>'id'=item.source_id
    ), helped AS (
      SELECT DISTINCT m.paper_id FROM fact_revs r
        JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
        JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
        JOIN matches m ON (m.mount_id,m.mount_rev::text)=
          (r.data->'mount'->'issuance'->>'id',r.data->'mount'->'issuance'->>'rev')
      WHERE r.learner_id=$1 AND f.type=$12 AND c.type=$13 AND r.rev=1 AND r.tick<(SELECT tick FROM fence)
        AND r.data->>'kind' IN ('opened','displayed')
        AND (r.data->'mount'->'item'->>'itemId'=m.item_id OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.data->'alsoAppliesTo') h WHERE h->>'itemId'=m.item_id))
    ), presented AS (
      SELECT m.paper_id,r.data->>'kind' AS kind FROM fact_revs r
        JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
        JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
        JOIN matches m ON (m.mount_id,m.mount_rev::text)=(r.data->'paper'->>'id',r.data->'paper'->>'rev')
      WHERE r.learner_id=$1 AND f.type=$15 AND c.type=$16 AND r.author='learner' AND r.rev=1
        AND r.tick<(SELECT tick FROM fence) AND (r.data->'items') ? m.item_id
    )
    SELECT EXISTS (SELECT 1 FROM matches WHERE controlled) OR EXISTS (SELECT 1 FROM attempted)
        OR EXISTS (SELECT 1 FROM helped) OR EXISTS (SELECT 1 FROM presented) AS seen,
      EXISTS (SELECT 1 FROM attempted WHERE paper_id<>$2 AND feedback) OR
        EXISTS (SELECT 1 FROM helped WHERE paper_id<>$2) OR
        EXISTS (SELECT 1 FROM presented WHERE paper_id<>$2 AND kind='solution') AS cross_help`,
    [tx.learner, target.paper.id, target.paper.rev, target.itemId, before, ownIssuance ?? null,
      [workbookPaperType, retentionPaperType], posttestIssuanceType, issuePosttestCommand, submitWorkbookAttemptCommand,
      [workbookAttemptType, posttestSubmissionType], helpExposureType, recordHelpExposureCommand, posttestSubmissionType,
      workbookPresentationType, recordWorkbookPresentationCommand],
  );
  if (!row) throw new Error('Missing workbook item safety result');
  return row;
}

export async function validatesWorkbookHistory(
  tx: ActivityEvidenceReadScope, target: WorkbookHistoryTarget & { condition: string },
  before: Tick, ownIssuance?: FactId, independent = false,
) {
  if (target.condition !== 'variant' && !independent) return true;
  const { seen, cross_help } = await workbookItemHistory(tx, target, before, ownIssuance);
  return !(target.condition === 'variant' && seen) && !(independent && cross_help);
}
