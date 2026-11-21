import { defineSlot } from '@mangekyo/kernel';
import { tomorrowWarmupType, type WarmupDay } from '../tomorrow-warmup.ts';

export default defineSlot({
  type: tomorrowWarmupType,
  key: ({ day, timeZone }: WarmupDay) => JSON.stringify([day, timeZone]),
  triggers: [{ kind: 'always' }],
  policy: 'lazy',
});
