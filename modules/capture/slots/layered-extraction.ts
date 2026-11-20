import { defineSlot, factId } from '@mangekyo/kernel';
import { layeredExtractionSlot } from '../extraction.ts';
import { captureSourceType } from '../source.ts';

export default defineSlot({
  type: layeredExtractionSlot,
  key: ({ sourceId }: { readonly sourceId: string }) => factId(sourceId),
  policy: 'eager',
  triggers: [{ kind: 'fact', factType: captureSourceType }],
});
