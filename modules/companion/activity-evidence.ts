import type { FactSnapshot } from '@mangekyo/kernel';
import artifact from '@mangekyo/module-activity/facts/artifact-action';
import note from '@mangekyo/module-activity/facts/organizer-note';
import posttest from '@mangekyo/module-activity/facts/retention-posttest-submission';
import turn from '@mangekyo/module-activity/facts/turn';
import workbook from '@mangekyo/module-activity/facts/workbook-attempt';
import intake from '@mangekyo/module-capture/facts/intake';
import { parseTextbookPage, textbookPageType } from '@mangekyo/module-content/facts/textbook-page';
import { retentionReviewPermission, retentionReviewPermissionType } from './research.ts';

export const activityEvidenceTypes = [turn.type, workbook.type, posttest.type, intake.type, textbookPageType,
  note.type, artifact.type, retentionReviewPermissionType] as const;
export const turnEvidenceType = turn.type;

type Fragment = { anchor: string; text: string; prompt?: string; result?: 'correct' | 'incorrect' };
type ActivityKind = 'conversation' | 'attempt' | 'posttest' | 'intake' | 'notes' | 'artifact' | 'feedback';

export function activityEvidence(fact: FactSnapshot): { kind: ActivityKind; fragments: Fragment[] } | undefined {
  switch (fact.type) {
    case turn.type: {
      const { caseId, answer } = turn.schema.parse(fact.value);
      if (caseId === 'companion' && answer?.trim()) return { kind: 'conversation', fragments: [{anchor: 'message', text: answer}] };
      return;
    }
    case workbook.type:
    case posttest.type: {
      const { feedback, paper } = workbook.schema.parse(fact.value);
      return { kind: fact.type === posttest.type ? 'posttest' : 'attempt', fragments: feedback.flatMap(item => {
        const question = paper.questions.find(question => question.id === item.questionId);
        if (item.answer === null || !question || question.sourceQuestionRef || question.kind === 'rubric' ||
            (item.result !== 'correct' && item.result !== 'incorrect')) return [];
        return [{anchor: item.questionId, text: typeof item.answer === 'string' ? item.answer : JSON.stringify(item.answer),
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
