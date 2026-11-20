import { defineSlot } from '@mangekyo/kernel';
import { interventionLiftType } from '../intervention-lift.ts';

export default defineSlot({
  type: interventionLiftType,
  key: (input: { playbookId: string; version: number }) => JSON.stringify([input.playbookId, input.version]),
  policy: 'lazy',
  triggers: [{ kind: 'slot', slotType: 'predict.reconciliation' }],
});
