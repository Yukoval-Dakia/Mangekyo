import { defineSlot } from '@mangekyo/kernel';
import { goalType } from '../goal-values.ts';
import { organizerTaskType } from '../organizer-task-values.ts';
import { planRuleType } from '../rules.ts';

export default defineSlot({
  type: 'plan.today',
  key: (input: { day: string; mode: string }) => JSON.stringify([input.day, input.mode]),
  triggers: [goalType, planRuleType, organizerTaskType].map((factType) => ({ kind: 'fact', factType })),
  policy: 'lazy',
});
