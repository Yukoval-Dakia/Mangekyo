import { defineDeriver, type GatherContext } from '@mangekyo/kernel';
import { evaluateRetention, forecastType, lastIndependentResult, type RetentionInput } from '../retention.ts';

export default defineDeriver({
  name: 'learner/retention-forecast',
  version: lastIndependentResult.version,
  slot: forecastType,
  // The activity adapter gathers comparable, authorized observations in this snapshot.
  gather(ctx, read: (ctx: GatherContext) => Promise<Omit<RetentionInput, 'observedThrough'>>) {
    return read(ctx).then(input => ({
      kind: 'input', data: { ...input, observedThrough: ctx.snapshotTick }, effects: [],
    }));
  },
  derive(input) {
    return { kind: 'value', value: evaluateRetention(lastIndependentResult, input) };
  },
});
