import { defineDeriver, type EffectReceipt } from '@mangekyo/kernel';
import {
  gatherLayeredExtraction, layeredExtractionDeriver, layeredExtractionSlot, settleLayeredExtraction,
  visualExtractionVersion, type LayeredExtractionKey, type LayeredExtractionValue,
} from '../extraction.ts';

type Input = Awaited<ReturnType<typeof gatherLayeredExtraction>>['data'] & { readonly receipts?: readonly EffectReceipt[] };

export default defineDeriver<LayeredExtractionKey, Input, LayeredExtractionValue>({
  name: layeredExtractionDeriver,
  version: visualExtractionVersion,
  slot: layeredExtractionSlot,
  gather: gatherLayeredExtraction,
  derive: input => settleLayeredExtraction(input, input.receipts ?? []),
});
