import { planRule, sameWarmupOpen, todayWarmupRules, warmupTimeZone, TomorrowWarmupConflict, type WarmupOpen } from './rules.ts';
import { planToday, type TodayInput } from './today.ts';
import { instant } from './validation.ts';

export { TomorrowWarmupConflict } from './rules.ts';

export const tomorrowWarmupType = 'plan.tomorrowWarmup';

export type WarmupDay = { day: string; timeZone: string };
type AvailableWarmup = WarmupDay & {
  state: 'suggested' | 'locked';
  activityId: string;
  title: string;
  minutes: number;
  open: WarmupOpen;
};
export type TomorrowWarmup = AvailableWarmup | (WarmupDay & { state: 'empty' | 'unavailable' });

export function tomorrowWarmupDay(now: string, timeZone: string) {
  const zone = warmupTimeZone(timeZone);
  const clock = new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' });
  let low = Date.parse(instant(now));
  let high = low + 48 * 60 * 60 * 1000;
  const today = clock.format(low);
  // The first instant in the next local day can move with offset changes.
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (clock.format(mid) === today) low = mid;
    else high = mid;
  }
  return { day: clock.format(high), timeZone: zone, startsAt: new Date(high).toISOString() };
}

export function planTomorrowWarmup(
  target: ReturnType<typeof tomorrowWarmupDay>, input: TodayInput | null,
): TomorrowWarmup {
  const { day, timeZone, startsAt } = target;
  const next = { day, timeZone };
  if (!input) return { ...next, state: 'unavailable' };

  const rules = input.rules ?? [];
  const activeLock = rules.find(rule =>
    rule.kind === 'lock' && rule.date === day && rule.warmup?.timeZone === timeZone);
  const { rules: admittedRules, warmup } = todayWarmupRules(rules, day, timeZone, input.candidates);
  const candidate = input.candidates.find(item => item.id === warmup);
  if (activeLock) {
    if (!candidate?.open) return { ...next, state: 'unavailable' };
    return { ...next, state: 'locked', activityId: candidate.id, title: candidate.title,
      minutes: candidate.minutes, open: candidate.open };
  }

  // Use tomorrow's time constraints. The closing device's filters and model ranking
  // do not carry over into the first step.
  const { duration: _duration, contentOrder: _order, ...planning } = input;
  const tomorrow = planToday({ ...planning, now: startsAt, timeZone, mode: 'any', rules: admittedRules });
  if (tomorrow.day !== day) return { ...next, state: 'unavailable' };
  if (!tomorrow.items.length) return { ...next, state: 'empty' };
  const eligible = new Map(input.candidates.filter(item => item.minutes <= 3 && item.open)
    .map(item => [item.id, item]));
  for (const id of [...tomorrow.items.map(({ candidate }) => candidate.id), ...tomorrow.shortlist]) {
    const candidate = eligible.get(id);
    if (candidate?.open) return { ...next, state: 'suggested', activityId: id, title: candidate.title,
      minutes: candidate.minutes, open: candidate.open };
  }
  return { ...next, state: 'empty' };
}

export function tomorrowWarmupLock(
  selection: WarmupDay & { activityId: string; open: WarmupOpen }, current: TomorrowWarmup,
) {
  if (current.state !== 'suggested' || current.day !== selection.day || current.timeZone !== selection.timeZone ||
      current.activityId !== selection.activityId || !sameWarmupOpen(current.open, selection.open))
    throw new TomorrowWarmupConflict('明日热身入口已变化，请刷新。');
  return planRule({ kind: 'lock', date: current.day, activityId: current.activityId,
    warmup: { timeZone: current.timeZone, open: current.open } });
}
