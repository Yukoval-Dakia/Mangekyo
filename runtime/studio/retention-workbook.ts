import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type DerivationId, type FactId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactRef, ReadContext } from '../../kernel/src/declarations/types.ts';
import { projectHelpExposure, type AdmittedHelpEvent, type HelpExposureEvidence } from '../../modules/activity/help-exposure.ts';
import { helpAppliesTo, helpExposure, helpExposureType, recordHelpExposureCommand, type HelpTarget } from '../../modules/activity/help-exposure-values.ts';
import { closedPosttest, posttestIssuanceType, posttestSubmissionType, retentionPaperType, retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import {
  sameWorkbookJson, submitWorkbookAttemptCommand, workbookAttempt, workbookAttemptType, workbookGradingVersion,
  workbookPaper, workbookPaperType, workbookRubricGradingVersion,
} from '../../modules/activity/workbook-values.ts';
import type { RetentionObservation, RetentionTarget } from '../../modules/learner/retention.ts';
import { readPosttestIssuance } from './retention-posttest.ts';
import { RequestError } from './sessions.ts';

export const retentionPurpose = retentionTeachingPurpose;

export async function openRetentionTarget(read: ReadContext, paperId: FactId, itemId: string) {
  const source = await read.fact(paperId, { mode: 'following' });
  if (source.type !== workbookPaperType && source.type !== retentionPaperType) throw new RequestError(404, '找不到冻结试卷。');
  const paper = workbookPaper(source.value);
  const question = paper.questions.find(question => question.id === itemId);
  if (!question || question.kind === 'rubric' || (question.kind === 'exact' && question.selfCheck) ||
      question.sourceQuestionRef || paper.materialId !== null) {
    throw new RequestError(422, '保持预测首版只支持本卷内嵌、可确定性正式判分的题项。');
  }
  const target: RetentionTarget = {
    activity: 'frozen-workbook-item',
    paper: { id: paperId, rev: source.ref.rev },
    itemId,
    condition: 'same-item',
    gradingVersion: paper.questions.some(item => item.kind === 'rubric')
      ? workbookRubricGradingVersion : workbookGradingVersion,
  };
  return { target, paper, accessEpoch: source.accessEpoch, sealed: source.type === retentionPaperType };
}

export async function readWorkbookObservation(
  tx: ReadTransaction, read: ReadContext, opened: Awaited<ReturnType<typeof openRetentionTarget>>, id: FactId,
  expectedForecast?: DerivationId,
): Promise<RetentionObservation> {
  const { target, paper } = opened;
  const submission = await read.fact(id, { mode: 'following' });
  const controlled = submission.type === posttestSubmissionType;
  if (!controlled && submission.type !== workbookAttemptType) throw new RequestError(422, '需要正式交卷记录。');
  const attempt = workbookAttempt(submission.value);
  const { rows: [birth] } = await tx.query<{ tick: Tick; submitted_at: string; condition: string | null }>(
    `SELECT r.tick::text AS tick, c.input->'input'->'data'->>'submittedAt' AS submitted_at,
       c.input->'input'->>'condition' AS condition
     FROM fact_revs r JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
     WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.kind='value' AND r.author='learner'
       AND c.type=$3 AND c.state='done'`,
    [tx.learner, id, submitWorkbookAttemptCommand],
  );
  if (!birth || birth.submitted_at !== attempt.submittedAt || controlled !== opened.sealed ||
      attempt.gradingVersion !== target.gradingVersion || !sameWorkbookJson(attempt.paper, paper)) {
    throw new RequestError(422, '交卷和冻结卷面的题项或判分条件不一致。');
  }
  const { result } = attempt.feedback.find(item => item.questionId === target.itemId)!;
  let exposure: RetentionObservation['exposure'];
  if (controlled) {
    const issued = await readPosttestIssuance(tx, read, factId(attempt.paperId));
    const release = issued.issuance;
    if (birth.condition !== closedPosttest || release.paper.id !== target.paper.id || release.paper.rev !== target.paper.rev ||
        release.paperEpoch !== opened.accessEpoch || release.itemId !== target.itemId || release.gradingVersion !== target.gradingVersion ||
        BigInt(issued.tick) >= BigInt(birth.tick) || attempt.submittedAt < release.startedAt || attempt.submittedAt > release.through ||
        (expectedForecast !== undefined && release.forecastId !== expectedForecast)) {
      throw new RequestError(422, '后测交卷与原预测或发放不匹配。');
    }
    exposure = await readControlledExposure(tx, read, target, issued.tick, submission.ref, birth.tick);
  } else {
    if (attempt.paperId !== target.paper.id) throw new RequestError(422, '交卷不属于此试卷。');
    exposure = await readExposure(tx, read, target, submission.ref, birth.tick);
  }
  return {
    submission: { id, rev: submission.ref.rev }, admittedAt: birth.tick, submittedAt: attempt.submittedAt,
    result: result === 'correct' || result === 'incorrect' ? result : 'unknown', exposure,
  };
}

async function readControlledExposure(
  tx: ReadTransaction, read: ReadContext, target: RetentionTarget, started: Tick, ref: FactRef, cutoff: Tick,
): Promise<RetentionObservation['exposure']> {
  // Include earlier issuances of the same frozen source, where a solution could have been released.
  // Withdrawal of a help record cannot restore complete coverage.
  const { rows: releases } = await tx.query<{ id: string; competing_submission: boolean }>(
    `SELECT i.fact_id AS id, EXISTS (
       SELECT 1 FROM fact_revs r JOIN facts f ON f.learner_id=r.learner_id AND f.id=r.fact_id
       WHERE r.learner_id=i.learner_id AND r.rev=1 AND r.data->>'paperId'=i.fact_id AND f.type=$4
         AND r.tick>$5::bigint AND r.tick<$6::bigint
     ) AS competing_submission
     FROM fact_revs i JOIN facts f ON f.learner_id=i.learner_id AND f.id=i.fact_id
     WHERE i.learner_id=$1 AND i.rev=1 AND f.type=$2 AND i.data->'paper'->>'id'=$3 AND i.tick<$6::bigint`,
    [tx.learner, posttestIssuanceType, target.paper.id, posttestSubmissionType, started, cutoff],
  );
  const mounts: HelpTarget[] = [target.paper, ...releases.map(row => ({ id: factId(row.id), rev: 1 as Revision }))].map(({ id, rev }) => ({
    activityId: id, issuance: { id, rev }, item: { itemId: target.itemId },
  }));
  const { rows } = await tx.query<{ id: string; tick: Tick }>(
    `SELECT r.fact_id AS id, r.tick::text FROM fact_revs r
     JOIN facts f ON f.learner_id=r.learner_id AND f.id=r.fact_id
     JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
     WHERE r.learner_id=$1 AND f.type=$2 AND c.type=$3 AND r.rev=1 AND r.tick<$4::bigint
       AND r.data->>'kind' IN ('opened','displayed')
       AND (r.data->'mount'->>'activityId'=ANY($5::text[]) OR r.data->'mount'->'issuance'->>'id'=ANY($5::text[]))`,
    [tx.learner, helpExposureType, recordHelpExposureCommand, cutoff, mounts.map(mount => mount.activityId)],
  );
  const events: AdmittedHelpEvent[] = [];
  // Another attempt of this item can supply correctness feedback during this sitting.
  let complete = ref.rev === 1 && !releases.some(release => release.competing_submission);
  for (const row of rows) {
    const id = factId(row.id);
    try {
      const fact = await read.fact(id, { mode: 'pinned', rev: 1 as Revision });
      const value = helpExposure(fact.value);
      if (value.kind === 'displayed' && mounts.some(mount => helpAppliesTo(value, mount))) {
        events.push({ ref: fact.ref, value, admittedAt: row.tick });
      } else {
        // A release without a display witness vetoes independence without claiming the learner saw it.
        complete = false;
      }
    } catch (error) {
      if (!(error instanceof FactReadDeniedError || error instanceof FactNotFoundError)) throw error;
      complete = false;
    }
  }
  const results = mounts.map(target => projectHelpExposure({ submission: { ref, target, cutoff }, events,
    coverage: complete ? { submission: ref, target, through: cutoff } : null }));
  const evidenceRefs = results.flatMap(result => result.evidenceRefs).sort((a, b) => a.id.localeCompare(b.id));
  return retentionExposure(evidenceRefs.length ? { kind: 'exposed', evidenceRefs } : results[0]!);
}

async function readExposure(
  tx: ReadTransaction, read: ReadContext, target: RetentionTarget,
  ref: Parameters<typeof projectHelpExposure>[0]['submission']['ref'], cutoff: Tick,
): Promise<RetentionObservation['exposure']> {
  // Workbook creates the original release at revision 1. Teaching grants create revisions carrying its unchanged content.
  const mount = {
    activityId: target.paper.id, issuance: { id: target.paper.id, rev: 1 as Revision },
    item: { itemId: target.itemId },
  };
  const { rows } = await tx.query<{ id: string; tick: Tick }>(
    `SELECT f.id, r.tick::text FROM facts f
     JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=1
     JOIN fact_revs visible ON visible.learner_id=f.learner_id AND visible.fact_id=f.id AND visible.rev=f.current_rev
     JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
     WHERE f.learner_id=$1 AND f.type=$2 AND c.type=$3 AND c.state='done' AND r.tick<$4::bigint
       AND f.retracted_rev IS NULL AND f.purpose && ARRAY[$6,'all']::text[]
       AND visible.purpose && ARRAY[$6,'all']::text[]
       AND visible.data->>'kind'='displayed' AND visible.data->'mount'->>'activityId'=$5`,
    [tx.learner, helpExposureType, recordHelpExposureCommand, cutoff, target.paper.id, retentionPurpose],
  );
  const check = createCommandReadContext(tx, retentionPurpose);
  const events: AdmittedHelpEvent[] = [];
  for (const row of rows) {
    const id = factId(row.id);
    try {
      const fact = await check.fact(id, { mode: 'following' });
      const displayed = helpExposure(fact.value);
      if (displayed.kind === 'displayed' && helpAppliesTo(displayed, mount)) {
        const recorded = await read.fact(id, { mode: 'following' });
        events.push({ ref: recorded.ref, value: displayed, admittedAt: row.tick });
      }
    } catch (error) {
      if (!(error instanceof FactReadDeniedError || error instanceof FactNotFoundError)) throw error;
    }
  }
  // The ordinary workbook host has no complete observation of pre-submission help.
  return retentionExposure(projectHelpExposure({ submission: { ref, target: mount, cutoff }, events, coverage: null }));
}

export function retentionExposure(observed: HelpExposureEvidence): RetentionObservation['exposure'] {
  if (observed.kind === 'unexposed') return { kind: 'independent' };
  if (observed.kind === 'exposed') return {
    kind: 'exposed', refs: observed.evidenceRefs.map(({ id, rev }) => ({ id, rev })),
  };
  return { kind: 'unknown', reason: observed.reason };
}
