import { defineSlot } from '@mangekyo/kernel';
import { publicLinkSlot, publicLinkWorkKey } from '../public-link.ts';

export default defineSlot({ type: publicLinkSlot, key: publicLinkWorkKey, policy: 'lazy', triggers: [] });
