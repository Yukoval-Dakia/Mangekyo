import { defineSlot } from '@mangekyo/kernel';
import { forecastType } from '../retention.ts';

export default defineSlot({
  type: forecastType,
  key: (input: { forecastId: string }) => input.forecastId,
  triggers: [],
  policy: 'lazy',
});
