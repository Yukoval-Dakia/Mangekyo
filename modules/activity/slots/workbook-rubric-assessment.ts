import { defineSlot } from '@mangekyo/kernel';
import { workbookAttemptType, workbookRubricAssessmentType } from '../workbook-values.ts';

export default defineSlot({
  type: workbookRubricAssessmentType,
  key: (input: { assessment: string }) => input.assessment,
  triggers: [{kind: 'fact', factType: workbookAttemptType}],
  policy: 'lazy',
});
