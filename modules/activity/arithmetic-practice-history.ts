import type { FactId } from '@mangekyo/kernel';
import { arithmeticPractice } from '@mangekyo/module-content/facts/arithmetic-practice';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import { workbookAttempt, workbookAttemptType } from './workbook-values.ts';
import { posttestSubmissionType } from './retention-posttest.ts';

// Match a complete integer exercise, including commuted operands.
function arithmeticStatement(prompt: string) {
  const match = /^(?:计算\s*)?([0-9]+)\s*([+\-−×*])\s*([0-9]+)\s*(?:=\s*)?(?:[。.!！?？])?$/u.exec(prompt.normalize('NFKC').trim());
  if (!match) return;
  const left = BigInt(match[1]!), right = BigInt(match[3]!);
  const op = match[2] === '+' ? 'add' : match[2] === '-' || match[2] === '−' ? 'subtract' : 'multiply';
  return op !== 'subtract' && left > right ? [op,right,left] as const : [op,left,right] as const;
}

/** Earlier attempts qualify by identity; later unmatched free text leaves a gap. */
export async function noAlternatePracticeFeedback(tx: ActivityEvidenceReadScope, id: FactId, born: string,
  practice: ReturnType<typeof arithmeticPractice>) {
  const {operation,left,right} = arithmeticPractice(practice);
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
    ORDER BY r.tick DESC LIMIT 257`, [tx.learner,[workbookAttemptType,posttestSubmissionType],born,id,token(left),token(right)]);
  if (rows.length > 256) return false;
  for (const {data,newer} of rows) {
    let attempt;
    try { attempt = workbookAttempt(data); } catch { return false; }
    for (const item of attempt.paper.questions) {
      const feedback = attempt.feedback.find(entry => entry.questionId === item.id);
      if (!feedback || feedback.result === 'unanswered') continue;
      if (item.sourceQuestionRef?.id === id) return false;
      const statement = arithmeticStatement(item.prompt);
      if (statement?.[0] === operation && statement[1] === BigInt(left) && statement[2] === BigInt(right)) return false;
      if (newer && (!statement || item.kind !== 'numeric' || item.unit || feedback.explanation)) return false;
    }
  }
  return true;
}
