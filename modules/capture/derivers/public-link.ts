import { defineDeriver, type EffectReceipt } from '@mangekyo/kernel';
import { gatherPublicLink, publicLinkDeriver, publicLinkSlot, publicLinkVersion, settlePublicLink,
  type PublicLinkReadRequest, type PublicLinkValue } from '../public-link.ts';

type Input = PublicLinkReadRequest & { readonly receipts?: readonly EffectReceipt[] };

export default defineDeriver<PublicLinkReadRequest, Input, PublicLinkValue>({
  name: publicLinkDeriver,
  version: publicLinkVersion,
  slot: publicLinkSlot,
  gather: gatherPublicLink,
  derive: input => settlePublicLink(input, input.receipts ?? []),
});
