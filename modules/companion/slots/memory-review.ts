import { defineSlot } from '@mangekyo/kernel';
import { memoryReviewSlotType } from '../memory-review.ts';

export default defineSlot({ type: memoryReviewSlotType, key: (input: { requestId: string }) => input.requestId, triggers: [{ kind: 'always' }], policy: 'lazy' });
