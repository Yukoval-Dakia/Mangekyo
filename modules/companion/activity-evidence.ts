import { factId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import artifact from '@mangekyo/module-activity/facts/artifact-action';
import note from '@mangekyo/module-activity/facts/organizer-note';
import posttest from '@mangekyo/module-activity/facts/retention-posttest-submission';
import turn from '@mangekyo/module-activity/facts/turn';
import workbook from '@mangekyo/module-activity/facts/workbook-attempt';
import intake from '@mangekyo/module-capture/facts/intake';
import { parseTextbookPage, textbookPageType } from '@mangekyo/module-content/facts/textbook-page';
import type { ActivityCitation } from './understanding.ts';
import { retentionReviewPermission, retentionReviewPermissionType } from './research.ts';

export const activityEvidenceTypes = [turn.type, workbook.type, posttest.type, intake.type, textbookPageType,
  note.type, artifact.type, retentionReviewPermissionType] as const;
export const turnEvidenceType = turn.type;

type Pinned = {id: string; rev: Revision};
type Fragment = { anchor: string; text: string; prompt?: string; result?: 'correct' | 'incorrect';
  sourceQuestionRef?: Pinned; independence?: 'unknown' };
type ActivityKind = 'conversation' | 'attempt' | 'posttest' | 'intake' | 'notes' | 'artifact' | 'feedback';

const linkedReader = Symbol.for('@mangekyo/companion/linked-attempt-citation');
type OpenCitation = (citation: ActivityCitation) => Promise<{teaching: boolean} | undefined>;
export type LinkedCitationRead = ReadContext & { [linkedReader]?: OpenCitation };
export function bindLinkedCitationRead(read: ReadContext, open: OpenCitation): LinkedCitationRead {
  return {...read, [linkedReader]: open};
}
export function reopenLinkedCitation(read: LinkedCitationRead, citation: ActivityCitation) {
  return read[linkedReader]?.(citation);
}
export function hasLinkedAttempt(fact: FactSnapshot) {
  return fact.type === workbook.type && workbook.schema.parse(fact.value).paper.questions.some(q => q.sourceQuestionRef);
}

export function citeQuestion(source: {paper: Pinned | undefined; fragments: readonly Fragment[];
  basis: readonly {id: string; epoch: string}[]}, anchor: string, recipient: string) {
  const fragment = source.fragments.find(item => item.anchor === anchor);
  if (!fragment?.sourceQuestionRef || !fragment.result || !source.paper) return;
  const witness = (ref: Pinned) => {
    const observed = source.basis.find(item => item.id === ref.id);
    if (!observed) throw new Error('缺少已读取的题源或冻结试卷。');
    return {id: factId(ref.id), rev: ref.rev, accessEpoch: observed.epoch as Tick};
  };
  return {paper: witness(source.paper), question: witness(fragment.sourceQuestionRef), recipient,
    result: fragment.result, independence: 'unknown' as const};
}

export function questionOrigin(...args: Parameters<typeof citeQuestion>) {
  const evidence = citeQuestion(...args);
  return evidence ? {question_evidence: evidence} : {};
}

export function activityEvidence(fact: FactSnapshot, linkedItem?: string): { kind: ActivityKind; fragments: Fragment[]; quoteOnly?: true } | undefined {
  switch (fact.type) {
    case turn.type: {
      const { caseId, answer, allowBackgroundUnderstanding } = turn.schema.parse(fact.value);
      if (caseId === 'companion' && allowBackgroundUnderstanding && answer?.trim()) return { kind: 'conversation',
        fragments: [{anchor: 'message', text: answer}], quoteOnly: true };
      return;
    }
    case workbook.type:
    case posttest.type: {
      const { feedback, paper } = workbook.schema.parse(fact.value);
      return { kind: fact.type === posttest.type ? 'posttest' : 'attempt', fragments: feedback.flatMap(item => {
        const question = paper.questions.find(question => question.id === item.questionId);
        if (item.answer === null || !question || question.kind === 'rubric' ||
            (question.sourceQuestionRef && (item.questionId !== linkedItem || fact.type !== workbook.type || paper.assessmentRelease)) ||
            (item.result !== 'correct' && item.result !== 'incorrect')) return [];
        return [{anchor: item.questionId, text: typeof item.answer === 'string' ? item.answer : JSON.stringify(item.answer),
          ...(question.sourceQuestionRef ? {sourceQuestionRef:question.sourceQuestionRef, independence:'unknown' as const} : {}),
          ...(paper.materialId === null ? {prompt: question.prompt} : {}), result: item.result}];
      }) };
    }
    case intake.type: {
      const { extraction } = intake.schema.parse(fact.value);
      if (extraction.status === 'corrected' && extraction.method === 'learner') {
        return { kind: 'intake', fragments: [{anchor: 'corrected-text', text: extraction.text}] };
      }
      return;
    }
    case textbookPageType:
      return { kind: 'notes', fragments: parseTextbookPage(fact.value).blocks.flatMap(({ id, body }) =>
        body.kind === 'text' ? [{anchor: id, text: body.text}] : []) };
    case note.type:
      return { kind: 'notes', fragments: [{anchor: 'markdown', text: note.schema.parse(fact.value).markdown}] };
    case artifact.type: {
      artifact.schema.parse(fact.value);
      const {action} = fact.value as {action: {intent: unknown}};
      // Client action is evidence of an interaction, never of a score or independent success.
      if (typeof action.intent === 'string') return { kind: 'artifact', fragments: [{anchor: 'interaction', text: action.intent}] };
      return;
    }
    case retentionReviewPermissionType:
      if (!retentionReviewPermission(fact.value).allowed) {
        return { kind: 'feedback', fragments: [{anchor: 'permission', text: '已撤回为这次后测准备复习单的授权'}] };
      }
      return;
    default: return;
  }
}

export function admittedActivityFragments(fact: FactSnapshot, item?: string) {
  const activity = activityEvidence(fact, item);
  if (!activity) return;
  if (activity.quoteOnly) return activity;
  const fragments = activity.fragments.filter(fragment => fragment.text.trim() &&
    (!item || fragment.sourceQuestionRef && fragment.anchor === item)).slice(0, 12).map(fragment => ({
    ...fragment, text: fragment.text.slice(0, 1200).toWellFormed(),
    ...(fragment.prompt ? {prompt: fragment.prompt.slice(0, 350).toWellFormed()} : {}),
  }));
  return fragments.length ? {kind: activity.kind, fragments} : undefined;
}
