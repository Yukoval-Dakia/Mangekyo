import { date, instant, integer, object, oneOf, text } from './validation.ts';

export class TomorrowWarmupConflict extends Error {}

export const planRuleType = 'plan.rule';
export type WarmupOpen = { kind: 'activity' | 'pack'; id: string; rev: number };
type WarmupLock = { timeZone: string; open: WarmupOpen };

export type Campaign = 'steady' | 'sprint' | 'recovery';
export type PlanRule =
  | { kind: 'exam'; date: string; scope: string[]; weights: { topic: string; weight: number }[] }
  | { kind: 'schoolwork'; date: string; minutes: number; topic: string }
  | { kind: 'progress'; topic: string; stage: 'current' | 'preview' }
  | { kind: 'window'; weekday: number | null; start: number; end: number }
  | { kind: 'exception' | 'rest'; date: string }
  | {
      kind: 'session';
      date: string;
      expiresAt: string;
      minutes: number;
      condition: 'time' | 'tired' | 'anxious';
    }
  | { kind: 'lock'; date: string; activityId: string; warmup?: WarmupLock }
  | { kind: 'defer'; until: string; activityId: string }
  | { kind: 'replace'; date: string; activityId: string; replacementId: string }
  | { kind: 'campaign'; campaign: Campaign };

export function planRule(input: unknown): PlanRule {
  const r = object(input);
  switch (r.kind) {
    case 'exam': {
      if (!Array.isArray(r.scope) || !Array.isArray(r.weights)) throw new Error('需要考试范围与权重列表。');
      const scope = r.scope.map(text);
      const weights = r.weights.map((raw) => {
        const item = object(raw);
        return { topic: text(item.topic), weight: integer(item.weight, 0, 100) };
      });
      if (
        weights.some((item) => !scope.includes(item.topic)) ||
        new Set(weights.map((w) => w.topic)).size !== weights.length ||
        weights.reduce((sum, w) => sum + w.weight, 0) > 100
      )
        throw new Error('范围、权重不一致。');
      return { kind: r.kind, date: date(r.date), scope, weights };
    }
    case 'schoolwork':
      return { kind: r.kind, date: date(r.date), topic: text(r.topic), minutes: integer(r.minutes, 1, 1440) };
    case 'progress':
      return { kind: r.kind, topic: text(r.topic), stage: oneOf(r.stage, ['current', 'preview']) };
    case 'window': {
      const start = integer(r.start, 0, 1439);
      return {
        kind: r.kind,
        weekday: r.weekday === null ? null : integer(r.weekday, 0, 6),
        start,
        end: integer(r.end, start + 1, 1440),
      };
    }
    case 'session':
      return {
        kind: r.kind,
        date: date(r.date),
        expiresAt: instant(r.expiresAt),
        minutes: integer(r.minutes, 0, 1440),
        condition: oneOf(r.condition, ['time', 'tired', 'anxious']),
      };
    case 'rest':
    case 'exception':
      return { kind: r.kind, date: date(r.date) };
    case 'lock': {
      const lock = { kind: r.kind, date: date(r.date), activityId: text(r.activityId) } as const;
      if (r.warmup === undefined) return lock;
      const warmup = object(r.warmup);
      const open = object(warmup.open);
      return { ...lock, warmup: {
        timeZone: warmupTimeZone(warmup.timeZone),
        open: { kind: oneOf(open.kind, ['activity', 'pack']), id: text(open.id), rev: integer(open.rev, 1, 2147483647) },
      } };
    }
    case 'defer':
      return { kind: r.kind, until: date(r.until), activityId: text(r.activityId) };
    case 'replace': {
      const activityId = text(r.activityId),
        replacementId = text(r.replacementId);
      if (activityId === replacementId) throw new Error('请选择不同的活动。');
      return { kind: r.kind, date: date(r.date), activityId, replacementId };
    }
    case 'campaign':
      return { kind: r.kind, campaign: oneOf(r.campaign, ['steady', 'sprint', 'recovery']) };
    default:
      throw new Error('无法识别的规划约束。');
  }
}

export function warmupTimeZone(value: unknown) {
  const zone = text(value);
  if (!/^[a-zA-Z][a-zA-Z0-9_+/-]*$/.test(zone)) throw new Error('需要命名时区。');
  new Intl.DateTimeFormat('en', { timeZone: zone });
  return zone;
}

export function sameWarmupOpen(a: { kind: string; id: string; rev: number } | null, b: WarmupOpen) {
  return a !== null && a.kind === b.kind && a.id === b.id && a.rev === b.rev;
}

export function todayWarmupRules(
  rules: readonly PlanRule[], day: string, timeZone: string,
  candidates: readonly { id: string; open: { kind: string; id: string; rev: number } | null; refused?: boolean; minutes?: number }[],
): { rules: PlanRule[]; warmup: string | null } {
  const ordinary: PlanRule[] = [];
  let selected: Extract<PlanRule, { kind: 'lock' }> | null = null;
  for (const rule of rules) {
    if (rule.kind !== 'lock' || !rule.warmup) {
      ordinary.push(rule);
      continue;
    }
    const { open } = rule.warmup;
    if (rule.date === day && rule.warmup.timeZone === timeZone && candidates.some(
      candidate => candidate.id === rule.activityId && !candidate.refused &&
        (candidate.minutes === undefined || candidate.minutes <= 3) && sameWarmupOpen(candidate.open, open),
    )) {
      selected ??= rule;
    }
  }
  if (selected) ordinary.push(selected);
  return { rules: ordinary, warmup: selected?.activityId ?? null };
}
