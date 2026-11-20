import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type DerivationId, type FactId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactRef, ReadContext } from '../../kernel/src/declarations/types.ts';
import { projectHelpExposure } from '../../modules/activity/help-exposure.ts';
import { helpAppliesTo, type HelpTarget } from '../../modules/activity/help-exposure-values.ts';
import {
  matchesControlledSubmission, posttestSubmissionType, retentionPaperType, retentionTeachingPurpose,
  workbookRetentionTarget, workbookVariantItem,
} from '../../modules/activity/retention-posttest.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
  type WorkbookAttempt, type WorkbookSourceQuestionRef,
} from '../../modules/activity/workbook-values.ts';
import type { RetentionObservation, RetentionTarget } from '../../modules/learner/retention.ts';
import { readPosttestIssuance, type PosttestFactReader } from './retention-posttest.ts';
import { activityHelpProcess, controlledWorkbookHelp } from '../../modules/activity/evidence-slice.ts';
import { readEarlierControlledPosttests, workbookItemHistory } from '../../modules/activity/evidence-read.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from './learning-attempt-read.ts';
import { RequestError } from './sessions.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { knowledgeEdgeType, workspaceEntryType } from '../../modules/content/knowledge-edge.ts';
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
  const target = workbookRetentionTarget(paper, { id: paperId, rev: source.ref.rev }, itemId);
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
  if (!matchesControlledSubmission(attempt, admittedAt, issued, root, expectedForecast)) {
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
  let process: ReturnType<typeof activityHelpProcess>;
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
  if (controlled && process.helpLevel === 'independent' && (await workbookItemHistory(tx, target, birth.tick)).cross_help) {
    process = activityHelpProcess({ kind: 'unknown', reason: 'incomplete-observation', evidenceRefs: [] }, []);
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
  const match = workbookVariantItem(attempt.paper, target.question.sourceQuestionRef, candidates);
  if (!match) throw new RequestError(422, '交卷与预测题项缺少可核对的无剧透变式关系。');
  const opened = await openRetentionTarget(tx, read, paperId, match.id);
  const evidence = await readWorkbookEvidence(tx, read, opened, id);
  return { evidence, opened, novelty: 'isomorphic' as const };
}

async function readControlledExposure(
  tx: ReadTransaction, read: ReadContext, target: RetentionTarget, started: Tick, ref: FactRef, cutoff: Tick,
) {
  const releases = await readEarlierControlledPosttests(tx, target.paper.id, started, cutoff);
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
  return controlledWorkbookHelp(ref, cutoff, mounts, events, omitted || visible.length !== releases.length,
    releases.some(release => release.competing_submission));
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
  return activityHelpProcess(projectHelpExposure({ submission: { ref, target: mount, cutoff }, events, coverage: null }), events);
}

export { retentionExposure } from '../../modules/activity/evidence-slice.ts';
