import type { FactId } from '@mangekyo/kernel';
import { arithmeticPractice } from '@mangekyo/module-content/facts/arithmetic-practice';
import { workbookAttempt } from './workbook-values.ts';

// Match a complete integer exercise, including commuted operands.
function arithmeticStatement(prompt: string) {
  const match = /^(?:计算\s*)?([0-9]+)\s*([+\-−×*])\s*([0-9]+)\s*(?:=\s*)?(?:[。.!！?？])?$/u.exec(prompt.normalize('NFKC').trim());
  if (!match) return;
  const left = BigInt(match[1]!), right = BigInt(match[3]!);
  const op = match[2] === '+' ? 'add' : match[2] === '-' || match[2] === '−' ? 'subtract' : 'multiply';
  return op !== 'subtract' && left > right ? [op,right,left] as const : [op,left,right] as const;
}

/** Earlier attempts qualify by identity; later unmatched free text leaves a gap. */
export function preservesUnexposedPractice(id: FactId, practice: ReturnType<typeof arithmeticPractice>,
  rows: readonly {data: unknown; newer: boolean}[]) {
  const {operation,left,right} = arithmeticPractice(practice);
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
