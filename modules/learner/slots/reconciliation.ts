import { defineSlot } from '@mangekyo/kernel';
import { reconciliationType } from '../retention.ts';

export default defineSlot({
  type: reconciliationType,
  key: (input: { reconciliationId: string }) => input.reconciliationId,
  triggers: [],
  policy: 'lazy',
});
