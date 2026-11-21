import { defineDeriver, type EffectReceipt } from '@mangekyo/kernel';
import { gatherNotionBlock, notionBlockDeriver, notionBlockSlot, settleNotionBlock } from '../notion-block-work.ts';

type Input = Awaited<ReturnType<typeof gatherNotionBlock>>['data'] & { readonly receipts?: readonly EffectReceipt[] };

export default defineDeriver({
  name: notionBlockDeriver,
  version: '1',
  slot: notionBlockSlot,
  gather: gatherNotionBlock,
  derive: (input: Input) => settleNotionBlock(input, input.receipts ?? []),
});
