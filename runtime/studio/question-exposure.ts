import { createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import { openArithmeticPractice, independentArithmeticV1 } from '../../modules/content/arithmetic-practice.ts';
import { parseQuestionState } from '../../modules/content/question-state.ts';
import { arithmeticPracticePaperId, practiceCustodyId, readPracticeCustody } from '../../modules/activity/sealed-practice.ts';
import { noAlternatePracticeFeedback } from '../../modules/activity/arithmetic-practice-history.ts';
import { helpExposureType } from '../../modules/activity/help-exposure-values.ts';

export const learningPythonReadLabel = 'local:learning-python-v1';
export const companionReplyStartedLabel = 'local:companion-reply-started';
export const companionReplyTrackingLabel = 'local:companion-reply-tracking';
export const questionScope = 'authorized_workbook_source_questions';
export const questionExposureReceiptVersion = 1;

type QuestionRead = {scope?: string; items?: {id: string; answer_exposed?: boolean | null}[]};

/** A negative is scoped to the newly generated task and to this Studio's deliveries.
 * A completed formal answer for the same task or an unresolved route can only
 * remove the negative. A confirmed positive is resolved separately with consent.
 */
export async function questionNegativeCurrent(tx: ReadTransaction, id: FactId, turn: string, beforeReply: boolean) {
  const read = createCommandReadContext(tx,'teaching');
  const paperId = await arithmeticPracticePaperId(id);
  const custody = await readPracticeCustody(read,await practiceCustodyId(paperId));
  if (custody?.value.kind !== 'sealed' || custody.value.question.id !== id) return false;
  const source = await openArithmeticPractice(read,id);
  if (!source) return false;
  const practice = parseQuestionState(source.state.value).arithmeticPractice;
  if (practice?.generation !== independentArithmeticV1) return false;
  const {rows:[window]} = await tx.query<{born: string; ambiguous: boolean}>(`
    SELECT b.tick::text AS born, (
      EXISTS (SELECT 1 FROM effects e
        WHERE e.learner_id=b.learner_id AND (
          (e.label='teaching-model' AND e.owner_id<>$4 AND e.started_tick>=b.tick)
          OR ($5 AND e.label=$6 AND e.owner_id=$4)))
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
    independentArithmeticV1,companionReplyTrackingLabel]);
  if (!window || window.ambiguous) return false;
  return noAlternatePracticeFeedback(tx,id,window.born,practice);
}

export function negativeQuestionReadIds(values: readonly unknown[]) {
  return new Set((values as readonly QuestionRead[]).flatMap(value => value?.scope === questionScope
    ? (value.items ?? []).filter(item => item.answer_exposed === false).map(item => item.id) : []));
}

export async function questionReceiptsCurrent(tx: ReadTransaction, turn: string, use: 'dispatch' | 'publish' | 'history') {
  const { rows } = await tx.query<{ result: string }>(`SELECT result FROM effects
    WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND label=$3 AND state='done'`,
  [tx.learner,turn,learningPythonReadLabel]);
  const sources = new Set<string>();
  for (const {result} of rows) {
    const packet = JSON.parse(result) as { values?: readonly unknown[]; questionExposure?: number };
    const ids = negativeQuestionReadIds(packet.values ?? []);
    if (!ids.size) continue;
    if (packet.questionExposure !== questionExposureReceiptVersion || use === 'history') return false;
    for (const id of ids) sources.add(id);
  }
  for (const id of sources) {
    if (!await questionNegativeCurrent(tx,factId(id),turn,use === 'dispatch')) return false;
  }
  return true;
}
