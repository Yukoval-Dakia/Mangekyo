import { defineDeriver, type GatherContext } from '@mangekyo/kernel';
import { defaultRetentionMethod, evaluateRetention, forecastType, readRetentionMethod, type RetentionInput } from '../retention.ts';

export default defineDeriver({
  name: 'learner/retention-forecast',
  version: '1',
  slot: forecastType,
  // The activity adapter gathers comparable, authorized observations in this snapshot.
  gather(ctx, read: (ctx: GatherContext) => Promise<Omit<RetentionInput, 'observedThrough'> & { method?: string }>) {
    return read(ctx).then(input => ({
      kind: 'input', data: { ...input, observedThrough: ctx.snapshotTick }, effects: [],
    }));
  },
  derive({ method = defaultRetentionMethod, ...input }) {
    const algorithm = readRetentionMethod(method);
    if (!algorithm) return { kind: 'unknown', reason: '冻结预测使用了未知的保持方法。' };
    return { kind: 'value', value: evaluateRetention(algorithm, input) };
  },
});
