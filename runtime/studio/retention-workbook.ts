import { createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type DerivationId, type FactId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactRef, ReadContext } from '../../kernel/src/declarations/types.ts';
import { projectHelpExposure, type HelpExposureEvidence } from '../../modules/activity/help-exposure.ts';
import { helpAppliesTo, type HelpTarget } from '../../modules/activity/help-exposure-values.ts';
import { posttestIssuanceType, posttestSubmissionType, retentionPaperType, retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookGradingVersion,
  workbookPaper, workbookPaperType, workbookRubricGradingVersion,
} from '../../modules/activity/workbook-values.ts';
import type { RetentionObservation, RetentionTarget } from '../../modules/learner/retention.ts';
import { readPosttestIssuance } from './retention-posttest.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from './learning-attempt-read.ts';
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
  const birth = await readActivitySubmissionBirth(tx, submission.ref, submission.type);
  if (!birth || birth.submittedAt !== attempt.submittedAt || controlled !== opened.sealed ||
      attempt.gradingVersion !== target.gradingVersion || !sameWorkbookJson(attempt.paper, paper)) {
    throw new RequestError(422, '交卷和冻结卷面的题项或判分条件不一致。');
  }
  const { result } = attempt.feedback.find(item => item.questionId === target.itemId)!;
  let exposure: RetentionObservation['exposure'];
  if (controlled) {
    const issued = await readPosttestIssuance(tx, read, factId(attempt.paperId));
    const release = issued.issuance;
    if (release.paper.id !== target.paper.id || release.paper.rev !== target.paper.rev ||
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
  const { events, omitted } = await readActivityHelpEvents(tx, read, {
    activities: mounts.map(mount => mount.activityId), cutoff, mode: 'pinned', includeOpens: true,
  });
  // Another attempt of this item can supply correctness feedback during this sitting.
  // A release without a display witness vetoes independence without claiming the learner saw it.
  const complete = ref.rev === 1 && !omitted && !releases.some(release => release.competing_submission)
    && events.every(({ value }) => value.kind === 'displayed' && mounts.some(mount => helpAppliesTo(value, mount)));
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
  const { events } = await readActivityHelpEvents(tx, createCommandReadContext(tx, retentionPurpose), {
    activities: [target.paper.id], cutoff, mode: 'following',
  }, async (fact, value) => {
    if (!helpAppliesTo(value, mount)) return false;
    await read.fact(fact.ref.id, { mode: 'following' });
    return true;
  });
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
