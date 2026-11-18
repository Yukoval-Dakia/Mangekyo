import { defineSlot } from '@mangekyo/kernel';
export default defineSlot({
  type: 'activity.teachingFeedback',
  key: (input: { turn: string }) => input.turn,
  triggers: [{ kind: 'fact', factType: 'activity.studyTurn' }],
  policy: 'eager',
});
