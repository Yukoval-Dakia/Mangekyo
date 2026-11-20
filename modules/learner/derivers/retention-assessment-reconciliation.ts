import { defineDeriver, type DerivationId, type GatherContext } from '@mangekyo/kernel';
import { reconcileAssessment } from '../retention-assessment.ts';
import { reconciliationType } from '../retention.ts';

type Arguments = Parameters<typeof reconcileAssessment>;
type Input = { forecastId: DerivationId; forecast: Arguments[0]; effectiveTick: Arguments[1]; observation: Arguments[2] };

export default defineDeriver({
  name: 'learner/retention-assessment-reconciliation', version: '1', slot: reconciliationType,
  async gather(ctx, read: (ctx: GatherContext) => Promise<Input>) {
    return { kind: 'input', data: { ...await read(ctx), observedThrough: ctx.snapshotTick }, effects: [] };
  },
  derive({ forecastId, forecast, effectiveTick, observation, observedThrough }) {
    const status = reconcileAssessment(forecast, effectiveTick, observation);
    return { kind: 'value', value: { forecastId, observation, observedThrough, status } };
  },
});
