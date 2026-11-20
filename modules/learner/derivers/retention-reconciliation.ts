import { defineDeriver, type DerivationId, type GatherContext } from '@mangekyo/kernel';
import { reconcileRetention, reconciliationType, type RetentionForecast, type RetentionObservation } from '../retention.ts';

type Input = { forecastId: DerivationId; forecast: RetentionForecast; observation: RetentionObservation };

export default defineDeriver({
  name: 'learner/retention-reconciliation',
  version: '1',
  slot: reconciliationType,
  gather(ctx, read: (ctx: GatherContext) => Promise<Input>) {
    return read(ctx).then(input => ({
      kind: 'input', data: { ...input, observedThrough: ctx.snapshotTick }, effects: [],
    }));
  },
  derive({ forecastId, forecast, observation, observedThrough }) {
    return { kind: 'value', value: { forecastId, observedThrough, ...reconcileRetention(forecast, observation) } };
  },
});
