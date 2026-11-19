import type { Json } from '@mangekyo/kernel';
import {
  assessmentRelease, assessmentResult,
  type AssessmentRelease, type AssessmentRevisionRef, type AssessmentSubmission,
} from './assessment-values.ts';

export const sentenceBreakEvaluator = { id: 'sentence-breaks', version: '1' } as const;
const sentenceBreakSchema = 'sentence-breaks-v1';
const criterionId = 'breaks';
const maximum = 100;

export function sentenceBreakRelease(
  releaseRef: AssessmentRevisionRef, itemId: string, slotId: string, breakpointIds: string[],
  definitionDigest: string, alternatives: unknown,
) {
  if (!Array.isArray(alternatives) || alternatives.length !== 2)
    throw new Error('断句规则须提供两套不同的完整断法。');
  const solutions = alternatives.map(solution => {
    if (!Array.isArray(solution) || !solution.length || new Set(solution).size !== solution.length ||
        !solution.every(id => breakpointIds.includes(id))) throw new Error('完整断法须引用本版不重复的断点。');
    return breakpointIds.filter(id => solution.includes(id));
  });
  const [left, right] = solutions;
  if (!left!.some(id => !right!.includes(id)) || !right!.some(id => !left!.includes(id)))
    throw new Error('两套完整断法须各有独占断点。');

  return assessmentRelease({ releaseRef, items: [{
    itemId, promptRef: releaseRef, workRef: releaseRef,
    slots: [{ slotId, schemaVersion: sentenceBreakSchema, fields: [{ path: '', kind: 'structured' }] }],
    criteria: [{
      criterionId, evaluator: sentenceBreakEvaluator, maximum, inputs: [{ slotId, path: '' }],
      source: { kind: 'product-rubric', ref: releaseRef, path: '/assessment/release/items/0/criteria/0/parameters' },
      parameters: { breakpointIds, alternatives: solutions, definitionDigest },
      missingEvidence: 'insufficient-evidence',
    }],
  }] });
}

function parameters(release: AssessmentRelease) {
  // This evaluator only receives releases built by sentenceBreakRelease and frozen by publication.
  return release.items[0]!.criteria[0]!.parameters as { breakpointIds: string[]; alternatives: [string[], string[]] };
}

export function submittedBreaks(release: AssessmentRelease, submission: AssessmentSubmission): string[] {
  const [answer] = submission.answers;
  if (!answer) return [];
  const value = answer.value.kind === 'structured' ? answer.value.value as { kind?: Json; ids?: Json } : null;
  const ids = value?.ids;
  if (value?.kind !== 'selection' || !Array.isArray(ids) || new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === 'string' && parameters(release).breakpointIds.includes(id)))
    throw new Error('结构化作答须引用本版不重复的断点。');
  return parameters(release).breakpointIds.filter(id => ids.includes(id));
}

export function mixesSentenceBreakSolutions(release: AssessmentRelease, ids: readonly string[]) {
  const [left, right] = parameters(release).alternatives;
  return ids.some(id => left.includes(id) && !right.includes(id)) &&
    ids.some(id => right.includes(id) && !left.includes(id));
}

export function evaluateSentenceBreaks(release: AssessmentRelease, submission: AssessmentSubmission) {
  const ids = submittedBreaks(release, submission);
  const item = release.items[0]!;
  const key = { itemId: item.itemId, criterionId };
  // Compare the selected set with each complete solution independently. Extra breaks increase the
  // denominator, so even a union containing a complete solution earns less than full credit.
  const best = Math.max(...parameters(release).alternatives.map(solution => {
    const matched = ids.filter(id => solution.includes(id)).length;
    return Math.floor(maximum * matched / (ids.length + solution.length - matched));
  }));
  const outcome = ids.length
    ? { ...key, state: 'scored', earned: best, evidence: item.criteria[0]!.inputs }
    : { ...key, state: 'unsubmitted', reason: '未交断点。' };
  return assessmentResult({ releaseRef: release.releaseRef, submissionRef: submission.submissionRef, outcomes: [outcome] },
    release, submission);
}
