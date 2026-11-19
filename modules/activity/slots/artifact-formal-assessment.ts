import { defineSlot } from '@mangekyo/kernel';

export default defineSlot({
  type: 'activity.artifactFormalAssessment',
  key: (input: { assessment: string }) => input.assessment,
  triggers: [{ kind: 'fact', factType: 'activity.artifactAction' }],
  policy: 'lazy',
});
