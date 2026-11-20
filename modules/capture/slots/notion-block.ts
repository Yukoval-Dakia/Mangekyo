import { defineSlot } from '@mangekyo/kernel';
import { notionBlockSlot, notionBlockWorkKey } from '../notion-block-work.ts';
import { notionBlockWitness } from '../notion-blocks.ts';

export default defineSlot({
  type: notionBlockSlot,
  key: input => notionBlockWorkKey(notionBlockWitness(input)),
  // Explicit transactional block demand from the committed source change
  // avoids re-queuing historical keys after a permission change.
  policy: 'lazy',
  triggers: [],
});
