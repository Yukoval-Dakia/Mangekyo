import { defineSlot } from '@mangekyo/kernel';
import { workbookAttemptType, workbookFormalAssessmentType } from '../workbook-values.ts';

export default defineSlot({
  type: workbookFormalAssessmentType, key: (input: { assessment: string }) => input.assessment,
  triggers: [{ kind: 'fact', factType: workbookAttemptType }], policy: 'lazy',
});
