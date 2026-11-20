import { defineDeriver, type GatherContext } from '@mangekyo/kernel';
import { interventionLiftType, measureInterventionLift, type LiftInput } from '../intervention-lift.ts';

export default defineDeriver({
  name: 'learner/intervention-lift',
  version: '1',
  slot: interventionLiftType,
  async gather(ctx, read: (ctx: GatherContext) => Promise<LiftInput>) {
    return { kind: 'input', data: await read(ctx), effects: [] };
  },
  derive: measureInterventionLift,
});
