import { defineDeriver, type GatherContext } from '@mangekyo/kernel';
import { planTomorrowWarmup, tomorrowWarmupDay, tomorrowWarmupType, type WarmupDay } from '../tomorrow-warmup.ts';
import type { TodayInput } from '../today.ts';

type ReadTomorrow = (ctx: GatherContext, target: WarmupDay & { startsAt: string }) => Promise<TodayInput | null>;

export default defineDeriver({
  name: 'plan/tomorrow-warmup',
  version: '1',
  slot: tomorrowWarmupType,
  async gather(ctx, { now, timeZone, read }: { now: string; timeZone: string; read: ReadTomorrow }) {
    const target = tomorrowWarmupDay(now, timeZone);
    return { kind: 'input', data: { target, planning: await read(ctx, target) }, effects: [] };
  },
  derive({ target, planning }) {
    return { kind: 'value', value: planTomorrowWarmup(target, planning) };
  },
});
