import { factId, type FactId, type ReadContext } from '@mangekyo/kernel';
import { openArithmeticPractice, independentArithmeticV1 } from '@mangekyo/module-content/facts/arithmetic-practice';
import { arithmeticPracticePaperId, practiceCustodyId, readPracticeCustody } from './sealed-practice.ts';
import { noAlternatePracticeFeedback } from './arithmetic-practice-history.ts';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import { helpExposureType } from './help-exposure-values.ts';
import teachingFeedbackSlot from './slots/feedback.ts';

export const learningPythonReadLabel = 'local:learning-python-v1';
export const companionReplyStartedLabel = 'local:companion-reply-started';
export const companionReplyTrackingLabel = 'local:companion-reply-tracking';
export const questionScope = 'authorized_workbook_source_questions';
export const questionExposureReceiptVersion = 2;

// Only simple prose in a recognized repertoire can clear an independently
// generated integer exercise. Numerals, references, markup and opaque channels
// remain possible exposure, without trying to identify the correct answer.
export function arithmeticFreeProse(text: string) {
  const prose = text.normalize('NFKC');
  return /^[a-z\p{Script=Han} \t\r\n,.!?;:。、…'"’‘“”]*$/iu.test(prose) &&
    !/[零〇一二三四五六七八九十百千万萬亿億兆两兩廿卅卌壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]/u.test(prose) &&
    !/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty|hundred|thousand|\w*illion|first|second|third|(?:four|fif|six|seven|eigh|nin|ten)th|[ivxlcdm]{2,}|minus|plus|point|half|double|twice)\b/i.test(prose);
}

/** A negative is scoped to the newly generated task and to this Studio's deliveries.
 * A completed formal answer for the same task or an unresolved route can only
 * remove the negative. A confirmed positive is resolved separately with consent.
 */
export async function questionNegativeCurrent(tx: ActivityEvidenceReadScope, read: ReadContext, id: FactId, turn: string, beforeReply: boolean) {
  const paperId = await arithmeticPracticePaperId(id);
  const custody = await readPracticeCustody(read,await practiceCustodyId(paperId));
  if (custody?.value.kind !== 'sealed' || custody.value.question.id !== id) return false;
  const source = await openArithmeticPractice(read,id);
  if (!source) return false;
  const practice = source.practice;
  if (practice.generation !== independentArithmeticV1) return false;
  const {rows:[window]} = await tx.query<{born: string; ambiguous: boolean}>(`
    SELECT b.tick::text AS born, (
      EXISTS (SELECT 1 FROM effects e
        WHERE e.learner_id=b.learner_id AND (
          (e.label='teaching-model' AND e.owner_id<>$4 AND (e.ended_tick>=b.tick OR (e.ended_tick IS NULL AND NOT EXISTS (
            SELECT 1 FROM slot_state s WHERE (s.learner_id,s.slot_key)=(e.learner_id,e.owner_id)
              AND s.slot_type=$11 AND s.changed_tick<b.tick AND (s.last_error IS NOT NULL OR s.current_id IS NOT NULL)
          )))
            AND CASE WHEN e.state='done' AND COALESCE(e.result->>'reply',e.result#>>'{}') IS JSON OBJECT
              THEN (COALESCE(e.result->>'reply',e.result#>>'{}')::jsonb->'arithmeticFree') IS DISTINCT FROM 'true'::jsonb
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
  [tx.learner,id,'content.saveQuestion',turn,String(beforeReply),companionReplyStartedLabel,helpExposureType,paperId,
    independentArithmeticV1,companionReplyTrackingLabel,teachingFeedbackSlot.type]);
  if (!window || window.ambiguous) return false;
  return noAlternatePracticeFeedback(tx,id,window.born,practice);
}

export async function questionReceiptsCurrent(tx: ActivityEvidenceReadScope, read: ReadContext, turn: string, use: 'dispatch' | 'publish' | 'history') {
  const { rows } = await tx.query<{ result: string }>(`SELECT result FROM effects
    WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND label=$3 AND state='done'`,
  [tx.learner,turn,learningPythonReadLabel]);
  const sources = new Set<FactId>();
  for (const {result} of rows) {
    const packet = JSON.parse(result) as {
      values?: {scope?: string}[]; questionExposure?: number; questionNegatives?: string[];
    };
    if (!packet.values?.some(value => value?.scope === questionScope)) continue;
    // Older receipts cannot prove which filtered rows contributed to coverage.
    if (packet.questionExposure !== questionExposureReceiptVersion || !Array.isArray(packet.questionNegatives)) return false;
    for (const id of packet.questionNegatives) sources.add(factId(id));
  }
  // Settlement verified the contemporaneous assertion. A later exposure
  // changes new reads, while the historical answer keeps its source authority.
  if (use === 'history') return true;
  for (const id of sources) {
    if (!await questionNegativeCurrent(tx,read,id,turn,use === 'dispatch')) return false;
  }
  return true;
}
