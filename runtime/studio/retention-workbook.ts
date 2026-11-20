import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { ReadContext } from '../../kernel/src/declarations/types.ts';
import { projectHelpExposure, type AdmittedHelpEvent, type HelpExposureEvidence } from '../../modules/activity/help-exposure.ts';
import { helpAppliesTo, helpExposure, helpExposureType, recordHelpExposureCommand } from '../../modules/activity/help-exposure-values.ts';
import {
  sameWorkbookJson, submitWorkbookAttemptCommand, workbookAttempt, workbookAttemptType, workbookGradingVersion,
  workbookPaper, workbookPaperType, workbookRubricGradingVersion,
} from '../../modules/activity/workbook-values.ts';
import type { RetentionObservation, RetentionTarget } from '../../modules/learner/retention.ts';
import { RequestError } from './sessions.ts';

export const retentionPurpose = 'teaching';

export async function openRetentionTarget(read: ReadContext, paperId: FactId, itemId: string) {
  const source = await read.fact(paperId, { mode: 'following' });
  if (source.type !== workbookPaperType) throw new RequestError(404, '找不到冻结试卷。');
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
  return { target, paper, accessEpoch: source.accessEpoch };
}

export async function readWorkbookObservation(
  tx: ReadTransaction, read: ReadContext, opened: Awaited<ReturnType<typeof openRetentionTarget>>, id: FactId,
): Promise<RetentionObservation> {
  const { target, paper } = opened;
  const submission = await read.fact(id, { mode: 'following' });
  if (submission.type !== workbookAttemptType) throw new RequestError(422, '需要正式交卷记录。');
  const attempt = workbookAttempt(submission.value);
  const { rows: [birth] } = await tx.query<{ tick: Tick; submitted_at: string }>(
    `SELECT r.tick::text AS tick, c.input->'input'->'data'->>'submittedAt' AS submitted_at
     FROM fact_revs r JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
     WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.kind='value' AND r.author='learner'
       AND c.type=$3 AND c.state='done'`,
    [tx.learner, id, submitWorkbookAttemptCommand],
  );
  if (!birth || birth.submitted_at !== attempt.submittedAt || attempt.paperId !== target.paper.id ||
      attempt.gradingVersion !== target.gradingVersion || !sameWorkbookJson(attempt.paper, paper)) {
    throw new RequestError(422, '交卷和冻结卷面的题项或判分条件不一致。');
  }
  const { result } = attempt.feedback.find(item => item.questionId === target.itemId)!;
  const exposure = await readExposure(tx, read, target, submission.ref, birth.tick);
  return {
    submission: { id, rev: submission.ref.rev }, admittedAt: birth.tick, submittedAt: attempt.submittedAt,
    result: result === 'correct' || result === 'incorrect' ? result : 'unknown', exposure,
  };
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
