import { defineDeriver, type GatherContext } from '@mangekyo/kernel';
import { planToday, type TodayInput } from '../today.ts';
import slot from '../slots/today.ts';

export default defineDeriver({
  name: 'plan/today',
  version: '1',
  slot: slot.type,
  async gather(ctx, read: (ctx: GatherContext) => Promise<TodayInput>) {
    const input = await read(ctx);
    return { kind: 'input', data: { ...input, observedThrough: ctx.snapshotTick }, effects: [] };
  },
  derive(input) {
    return { kind: 'value', value: planToday(input) };
  },
});
