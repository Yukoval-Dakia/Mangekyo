import { date, instant, integer, object, oneOf, text } from './validation.ts';

export const planRuleType = 'plan.rule';
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
  | { kind: 'lock'; date: string; activityId: string }
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
    case 'lock':
      return { kind: r.kind, date: date(r.date), activityId: text(r.activityId) };
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
