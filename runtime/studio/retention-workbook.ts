import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type DerivationId, type FactId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactRef, ReadContext } from '../../kernel/src/declarations/types.ts';
import { projectHelpExposure, type AdmittedHelpEvent, type HelpExposureEvidence } from '../../modules/activity/help-exposure.ts';
import { helpAppliesTo, type HelpTarget } from '../../modules/activity/help-exposure-values.ts';
import { posttestIssuanceType, posttestSubmissionType, retentionPaperType, retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookGradingVersion,
  workbookPaper, workbookPaperType, workbookRubricGradingVersion,
  type WorkbookAttempt,
} from '../../modules/activity/workbook-values.ts';
import type { RetentionObservation, RetentionTarget } from '../../modules/learner/retention.ts';
import { readPosttestIssuance, type PosttestFactReader } from './retention-posttest.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from './learning-attempt-read.ts';
import { RequestError } from './sessions.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { knowledgeEdgeType, workspaceEntryType } from '../../modules/content/knowledge-edge.ts';
import type { WorkbookSourceQuestionRef } from '../../modules/activity/workbook-values.ts';
import { resolveSource, type SourceTrack } from './source-read.ts';
import { sourceReference, type SourceRefV1 } from '../../modules/activity/source-values.ts';

export const retentionPurpose = retentionTeachingPurpose;

async function trackSource(tx: ReadTransaction, read: PosttestFactReader, reference: string | SourceRefV1) {
  const opened: Parameters<SourceTrack>[] = [];
  const source = await resolveSource(tx, reference, {
    recipient: 'workspace', purpose: retentionPurpose, maySend: () => true, track: (...witness) => opened.push(witness),
  });
  if (!source) throw new FactReadDeniedError('changed', '冻结题项的来源当前不可用。');
  for (const [fact, mode] of opened) {
    await read.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
  }
  return source;
}

export async function openRetentionTarget(tx: ReadTransaction, read: PosttestFactReader, paperId: FactId, itemId: string) {
  const source = await read.fact(paperId, { mode: 'following' });
  if (source.type !== workbookPaperType && source.type !== retentionPaperType) throw new RequestError(404, '找不到冻结试卷。');
  const paper = workbookPaper(source.value);
  const question = paper.questions.find(question => question.id === itemId);
  if (!question || question.kind === 'rubric' || (question.kind === 'exact' && question.selfCheck)) {
    throw new RequestError(422, '保持预测需要可确定性正式判分的题项。');
  }
  if (question.sourceQuestionRef) {
    const resolved = await trackSource(tx, read, {
      v: 1, fact: { ...question.sourceQuestionRef, type: workspaceEntryType },
      anchor: { kind: 'question', itemId: 'question' },
    });
    if (resolved.content !== question.prompt) throw new RequestError(422, '来源题面与冻结题项不匹配。');
  }
  if (paper.materialId) await trackSource(tx, read, paper.materialId);
  const target: RetentionTarget = {
    activity: 'frozen-workbook-item',
    paper: { id: paperId, rev: source.ref.rev },
    itemId,
    condition: 'same-item',
    gradingVersion: paper.questions.some(item => item.kind === 'rubric')
      ? workbookRubricGradingVersion : workbookGradingVersion,
  };
  return { target, paper, question, source, accessEpoch: source.accessEpoch, sealed: source.type === retentionPaperType };
}

/** SQL only discovers IDs. Opening a knowledge edge checks its endpoints, proof and all source witnesses. */
async function readItemEdges(
  tx: ReadTransaction, read: ReadContext, source: WorkbookSourceQuestionRef | undefined, cutoff: Tick,
  kinds: readonly ('targets_concept' | 'variant_of')[],
) {
  if (!source) return [];
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT f.id FROM facts f JOIN fact_revs r
       ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND r.tick<=$3 AND r.data->>'kind'=ANY($4::text[])
       AND (r.data->'from'->'sourceUse' @> $5::jsonb OR
            (r.data->>'kind'='variant_of' AND r.data->'to'->'sourceUse' @> $5::jsonb))
     ORDER BY f.id`,
    [tx.learner, knowledgeEdgeType, cutoff, kinds, JSON.stringify(source)],
  );
  const edges = [];
  for (const { id } of rows) {
    const edge = await openKnowledgeEdge(tx, id, { recipient: 'workspace', purpose: retentionPurpose, maySend: () => true });
    if (!edge) continue;
    // Track every authorised revision used by the edge, and reject late transitive sources.
    const witnesses = edge.opened.map(([{ ref, accessEpoch }]) => ({ id: ref.id, rev: ref.rev, accessEpoch }));
    const { rows: [check] } = await tx.query<{ complete: boolean }>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS witness(id text,rev integer)
         LEFT JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=($1,witness.id,witness.rev)
         WHERE r.tick IS NULL OR r.tick>$3
       ) AS complete`, [tx.learner, JSON.stringify(witnesses), cutoff]);
    if (!check?.complete) continue;
    for (const [fact, mode] of edge.opened) {
      await read.fact(fact.ref.id, mode === 'following' ? { mode } : { mode: 'pinned', rev: fact.ref.rev });
    }
    edges.push(edge.value);
  }
  return edges;
}

export async function readItemDimensions(
  tx: ReadTransaction, read: ReadContext, source: WorkbookSourceQuestionRef | undefined, cutoff: Tick,
) {
  const edges = await readItemEdges(tx, read, source, cutoff, ['targets_concept']);
  return [...new Set(edges.map(edge => edge.to.fact.id))].sort();
}

export async function openControlledSubmission(
  tx: ReadTransaction, read: PosttestFactReader, attempt: WorkbookAttempt, admittedAt: Tick,
  opened?: Awaited<ReturnType<typeof openRetentionTarget>>, expectedForecast?: DerivationId,
) {
  const issued = await readPosttestIssuance(tx, read, factId(attempt.paperId));
  const release = issued.issuance;
  const root = opened ?? await openRetentionTarget(tx, read, release.paper.id, release.itemId);
  const { target } = root;
  if (!root.sealed || release.paper.id !== target.paper.id || release.paper.rev !== target.paper.rev ||
      release.paperEpoch !== root.accessEpoch || release.itemId !== target.itemId ||
      release.gradingVersion !== target.gradingVersion || attempt.gradingVersion !== target.gradingVersion ||
      !sameWorkbookJson(attempt.paper, root.paper) || BigInt(issued.tick) >= BigInt(admittedAt) ||
      attempt.submittedAt < release.startedAt || attempt.submittedAt > release.through ||
      (expectedForecast !== undefined && release.forecastId !== expectedForecast)) {
    throw new RequestError(422, '后测交卷与原预测或发放不匹配。');
  }
  return { issued, source: root.source };
}

export async function readWorkbookObservation(
  tx: ReadTransaction, read: ReadContext, opened: Awaited<ReturnType<typeof openRetentionTarget>>, id: FactId,
  expectedForecast?: DerivationId,
): Promise<RetentionObservation> {
  return (await readWorkbookEvidence(tx, read, opened, id, expectedForecast)).observation;
}

export async function readWorkbookEvidence(
  tx: ReadTransaction, read: ReadContext, opened: Awaited<ReturnType<typeof openRetentionTarget>>, id: FactId,
  expectedForecast?: DerivationId,
) {
  const { target, paper } = opened;
  const submission = await read.fact(id, { mode: 'following' });
  const controlled = submission.type === posttestSubmissionType;
  if (!controlled && submission.type !== workbookAttemptType) throw new RequestError(422, '需要正式交卷记录。');
  const attempt = workbookAttempt(submission.value);
  const birth = await readActivitySubmissionBirth(tx, submission.ref, submission.type);
  if (!birth || !birth.unchanged || birth.submittedAt !== attempt.submittedAt || controlled !== opened.sealed) {
    throw new RequestError(422, '交卷和冻结卷面的题项或判分条件不一致。');
  }
  let process: ReturnType<typeof readProcess>;
  if (controlled) {
    const { issued } = await openControlledSubmission(tx, read, attempt, birth.tick, opened, expectedForecast);
    process = await readControlledExposure(tx, read, target, issued.tick, submission.ref, birth.tick);
  } else {
    if (attempt.paperId !== target.paper.id) throw new RequestError(422, '交卷不属于此试卷。');
    if (attempt.gradingVersion !== target.gradingVersion || !sameWorkbookJson(attempt.paper, paper)) {
      throw new RequestError(422, '交卷和冻结卷面的题项或判分条件不一致。');
    }
    process = await readExposure(tx, read, target, submission.ref, birth.tick);
  }
  const result = attempt.feedback.find(item => item.questionId === target.itemId)?.result;
  const observation: RetentionObservation = {
    submission: { id, rev: submission.ref.rev }, admittedAt: birth.tick, submittedAt: attempt.submittedAt,
    result: result === 'correct' || result === 'incorrect' ? result : 'unknown', exposure: process.exposure,
  };
  return {
    observation, process, recordedAt: birth.recordedAt, duration: attempt.effectiveDurationMs,
  };
}

export async function readComparableWorkbookEvidence(
  tx: ReadTransaction, read: ReadContext, target: Awaited<ReturnType<typeof openRetentionTarget>>,
  id: FactId, cutoff: Tick,
) {
  const fact = await read.fact(id, { mode: 'following' });
  if (fact.type !== workbookAttemptType && fact.type !== posttestSubmissionType)
    throw new RequestError(422, '需要正式交卷记录。');
  const attempt = workbookAttempt(fact.value);
  const paperId = fact.type === posttestSubmissionType
    ? (await readPosttestIssuance(tx, read, factId(attempt.paperId))).issuance.paper.id : factId(attempt.paperId);
  if (paperId === target.target.paper.id) {
    const evidence = await readWorkbookEvidence(tx, read, target, id);
    return { evidence, opened: target, novelty: 'same' as const };
  }
  const candidates = await readItemEdges(tx, read, target.question.sourceQuestionRef, cutoff, ['variant_of']);
  const matches = attempt.paper.questions.flatMap(item => candidates.flatMap(edge => {
    const other = edge.from.fact.id === target.question.sourceQuestionRef?.id ? edge.to.fact : edge.from.fact;
    return item.sourceQuestionRef?.id === other.id && item.sourceQuestionRef.rev === other.rev &&
      edge.variant?.spoilsNext === 'none' ? [{ item, edge }] : [];
  }));
  const match = matches[0];
  if (matches.length !== 1 || !match) throw new RequestError(422, '交卷与预测题项缺少可核对的无剧透变式关系。');
  const opened = await openRetentionTarget(tx, read, paperId, match.item.id);
  const evidence = await readWorkbookEvidence(tx, read, opened, id);
  return { evidence, opened, novelty: 'isomorphic' as const };
}

function readProcess(observed: HelpExposureEvidence, events: readonly AdmittedHelpEvent[]) {
  const evidence = events.filter(({ ref }) => observed.evidenceRefs.some(use => use.id === ref.id && use.rev === ref.rev));
  const helpLevel = observed.kind === 'unexposed' ? 'independent' as const
    : observed.kind === 'unknown' ? 'unknown' as const
    : evidence.some(({ value }) => value.kind === 'displayed' && value.step.kind === 'solution')
      ? 'solution_seen' as const : 'hinted' as const;
  return { exposure: retentionExposure(observed), helpLevel };
}

async function readControlledExposure(
  tx: ReadTransaction, read: ReadContext, target: RetentionTarget, started: Tick, ref: FactRef, cutoff: Tick,
) {
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
  const visible = [];
  for (const row of releases) {
    try {
      const { fact } = await readPosttestIssuance(tx, read, factId(row.id));
      visible.push(fact.ref);
    } catch (error) {
      if (!(error instanceof RequestError || error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
    }
  }
  const mounts: HelpTarget[] = [target.paper, ...visible].map(({ id, rev }) => ({
    activityId: id, issuance: { id, rev }, item: { itemId: target.itemId },
  }));
  const { events, omitted } = await readActivityHelpEvents(tx, read, {
    activities: mounts.map(mount => mount.activityId), cutoff, mode: 'pinned', includeOpens: true,
  }, async (_, presentation) => {
    const { id, rev } = presentation.content;
    const content = await read.fact(id, { mode: 'pinned', rev });
    await trackSource(tx, read, sourceReference(content, { kind: 'whole' }));
    return true;
  });
  // Another attempt of this item can supply correctness feedback during this sitting.
  // A release without a display witness vetoes independence without claiming the learner saw it.
  const complete = ref.rev === 1 && !omitted && !releases.some(release => release.competing_submission)
    && visible.length === releases.length
    && events.every(({ value }) => value.kind === 'displayed' && mounts.some(mount => helpAppliesTo(value, mount)));
  const results = mounts.map(target => projectHelpExposure({ submission: { ref, target, cutoff }, events,
    coverage: complete ? { submission: ref, target, through: cutoff } : null }));
  const evidenceRefs = results.flatMap(result => result.evidenceRefs).sort((a, b) => a.id.localeCompare(b.id));
  return readProcess(evidenceRefs.length ? { kind: 'exposed', evidenceRefs } : results[0]!, events);
}

async function readExposure(
  tx: ReadTransaction, read: ReadContext, target: RetentionTarget,
  ref: Parameters<typeof projectHelpExposure>[0]['submission']['ref'], cutoff: Tick,
) {
  // Workbook creates the original release at revision 1. Teaching grants create revisions carrying its unchanged content.
  const mount = {
    activityId: target.paper.id, issuance: { id: target.paper.id, rev: 1 as Revision },
    item: { itemId: target.itemId },
  };
  const { events } = await readActivityHelpEvents(tx, createCommandReadContext(tx, retentionPurpose), {
    activities: [target.paper.id], cutoff, mode: 'following',
  }, async (fact, value) => {
    if (!helpAppliesTo(value, mount)) return false;
    const { id, rev } = value.content;
    const content = await read.fact(id, { mode: 'pinned', rev });
    await trackSource(tx, read, sourceReference(content, { kind: 'whole' }));
    await read.fact(fact.ref.id, { mode: 'following' });
    return true;
  });
  // The ordinary workbook host has no complete observation of pre-submission help.
  return readProcess(projectHelpExposure({ submission: { ref, target: mount, cutoff }, events, coverage: null }), events);
}

export function retentionExposure(observed: HelpExposureEvidence): RetentionObservation['exposure'] {
  if (observed.kind === 'unexposed') return { kind: 'independent' };
  if (observed.kind === 'exposed') return {
    kind: 'exposed', refs: observed.evidenceRefs.map(({ id, rev }) => ({ id, rev })),
  };
  return { kind: 'unknown', reason: observed.reason };
}
