import { listCompletedEffects, type FactId, type ReadTransaction } from '../../kernel/src/index.ts';
import { teachingRead } from './fact-read-helpers.ts';
import { preservesUnexposedPractice } from '../../modules/activity/arithmetic-practice-history.ts';
import { helpExposureType } from '../../modules/activity/help-exposure-values.ts';
import { readIndependentSealedPractice } from '../../modules/activity/sealed-practice.ts';
import teachingFeedbackSlot from '../../modules/activity/slots/feedback.ts';
import { posttestSubmissionType } from '../../modules/activity/retention-posttest.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { independentArithmeticV1 } from '../../modules/content/arithmetic-practice.ts';
import { learningPythonReadLabel, questionNegativeRefs } from '../../executors/teaching/question-read-receipts.ts';
import { purpose } from './identity.ts';

export const companionReplyStartedLabel = 'local:companion-reply-started';
export const companionReplyTrackingLabel = 'local:companion-reply-tracking';

export async function questionNegativeCurrent(tx: ReadTransaction, id: FactId, turn: string, beforeReply: boolean) {
  const candidate = await readIndependentSealedPractice(teachingRead(tx), id);
  if (!candidate) return false;
  const {paperId, practice} = candidate;
  const {rows:[window]} = await tx.query<{born: string; ambiguous: boolean}>(`
    SELECT b.tick::text AS born, (
      EXISTS (SELECT 1 FROM effects e
        WHERE e.learner_id=b.learner_id AND e.owner_kind='session' AND (
          (e.label='teaching-model' AND e.owner_id<>$4 AND (e.ended_tick>=b.tick OR (e.ended_tick IS NULL AND NOT EXISTS (
            SELECT 1 FROM slot_state s WHERE (s.learner_id,s.slot_key)=(e.learner_id,e.owner_id)
              AND s.slot_type=$11 AND s.changed_tick<b.tick AND (s.last_error IS NOT NULL OR s.current_id IS NOT NULL)
          )))
            AND CASE WHEN e.state='done' AND COALESCE(e.result->>'reply',e.result#>>'{}') IS JSON OBJECT
              THEN (COALESCE(e.result->>'reply',e.result#>>'{}')::jsonb->'phaticExchangeV1') IS DISTINCT FROM 'true'::jsonb
              ELSE true END)
          OR ($5::boolean AND e.label=$6 AND e.owner_id=$4)))
      OR EXISTS (SELECT 1 FROM erasure_requests er WHERE er.learner_id=b.learner_id AND er.generation>b.tick)
      OR EXISTS (SELECT 1 FROM fact_revs r JOIN facts f
        ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
        WHERE r.learner_id=b.learner_id AND f.type=$7 AND r.tick>=b.tick AND r.kind='value'
          AND (r.data->>'kind' IN ('offered','opened','displayed'))
          AND r.data#>>'{mount,activityId}'=$8)
    ) AS ambiguous
    FROM fact_revs b JOIN commands c ON (c.learner_id,c.id)=(b.learner_id,b.command_id)
    WHERE b.learner_id=$1 AND b.fact_id=$2 AND b.rev=1 AND b.kind='value'
      AND b.author='learner' AND c.type=$3 AND c.state='done'
      AND c.input#>>'{input,arithmeticPractice,generation}'=$9
      AND EXISTS (SELECT 1 FROM effects e WHERE e.learner_id=b.learner_id AND e.owner_id=$4 AND e.label=$10
        AND e.result='"tracked"'::jsonb)`,
  [tx.learner,id,'content.saveQuestion',turn,beforeReply,companionReplyStartedLabel,helpExposureType,paperId,
    independentArithmeticV1,companionReplyTrackingLabel,teachingFeedbackSlot.type]);
  if (!window || window.ambiguous) return false;
  const token = (n: number) => '(^|[^0-9])0*' + n + '([^0-9]|$)';
  const {rows} = await tx.query<{data: unknown; newer: boolean}>(`
    SELECT r.data, r.tick >= $3::bigint AS newer FROM facts f JOIN fact_revs r
      ON (r.learner_id,r.fact_id)=(f.learner_id,f.id)
    WHERE f.learner_id=$1 AND f.type=ANY($2::text[]) AND r.kind='value'
      AND (r.rev=1 OR EXISTS (SELECT 1 FROM fact_revs first
        WHERE (first.learner_id,first.fact_id,first.rev)=(r.learner_id,r.fact_id,1)
          AND ROW(r.data->'paper',r.data->'feedback') IS DISTINCT FROM ROW(first.data->'paper',first.data->'feedback')))
      AND (r.tick >= $3::bigint OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(r.data#>'{paper,questions}') q
        WHERE q#>>'{sourceQuestionRef,id}'=$4 OR
          (normalize(q->>'prompt', NFKC) ~ $5 AND normalize(q->>'prompt', NFKC) ~ $6)
      ))
    ORDER BY r.tick DESC LIMIT 257`, [tx.learner,[workbookAttemptType,posttestSubmissionType],window.born,id,token(practice.left),token(practice.right)]);
  return preservesUnexposedPractice(id,practice,rows);
}

export async function questionReceiptsCurrent(tx: ReadTransaction, turn: string, use: 'dispatch' | 'publish' | 'history') {
  const { rows } = await listCompletedEffects(tx,{ownerKind:'session',ownerId:turn,label:learningPythonReadLabel});
  const sources = questionNegativeRefs(rows.map(({result}) => result as string));
  if (!sources) return false;
  // Settlement verified the contemporaneous assertion. A later exposure
  // changes new reads, while the historical answer keeps its source authority.
  if (use === 'history') return true;
  for (const id of sources) { if (!await questionNegativeCurrent(tx,id,turn,use === 'dispatch')) return false;
  }
  return true;
}
