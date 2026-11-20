import type { CanonicalEvidenceSliceV1 } from '@mangekyo/kernel';
import type { GoalStatus } from './goal-values.ts';
import type { Campaign, PlanRule } from './rules.ts';
import { examForecast, type FrozenExamForecast } from './exam-forecast.ts';
import { packCandidates } from './offline-pack.ts';
import { instant, integer } from './validation.ts';

export type PlanCandidate = {
  id: string;
  title: string;
  topic: string;
  kind: 'review' | 'probe' | 'counterexample' | 'exam' | 'recovery' | 'lesson';
  minutes: number;
  durationBasis: string;
  input: 'tap' | 'voice' | 'write';
  open: { kind: 'activity' | 'pack'; id: string; rev: number } | null;
  reason: string;
  evidence: readonly string[];
  delayImpact: string;
  goalId?: string;
  retention?: number;
  information?: number;
  highConfidenceWrong?: boolean;
  refused?: boolean;
  state?: 'in-progress' | 'completed';
  date?: string;
  draftRef?: string;
};
export type TodayInput = {
  now: string;
  timeZone: string;
  constraints: CanonicalEvidenceSliceV1['constraints'];
  candidates: readonly PlanCandidate[];
  goal?: { id: string; text: string | null; status: GoalStatus };
  rules?: readonly PlanRule[];
  lastOpenedAt?: string;
  mode?: 'one-hand' | 'voice' | 'any';
  // Agent may rank authorized real content. Apply only after hard admission.
  contentOrder?: readonly string[];
  frozenExamForecast?: FrozenExamForecast;
};
const dayMs = 86400000;
const days = (first: string, last: string) => (Date.parse(last) - Date.parse(first)) / dayMs;

function localClock(at: string, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant(at)));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return {
    day: get('year') + '-' + get('month') + '-' + get('day'),
    minute: Number(get('hour')) * 60 + Number(get('minute')),
  };
}
export function sessionRule(
  now: string,
  timeZone: string,
  minutes: number,
  condition: 'time' | 'tired' | 'anxious',
  sessionEnd?: string,
): PlanRule {
  const day = localClock(now, timeZone).day;
  // Find the actual boundary even on a day with an offset change.
  let low = Date.parse(now),
    high = low + 2 * dayMs;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (localClock(new Date(mid).toISOString(), timeZone).day === day) low = mid;
    else high = mid;
  }
  const end = Math.min(high, sessionEnd ? Date.parse(instant(sessionEnd)) : high);
  if (end <= Date.parse(now)) throw new Error('本次时段已结束。');
  return {
    kind: 'session',
    date: day,
    expiresAt: new Date(end).toISOString(),
    minutes: integer(minutes, 0, 1440),
    condition,
  };
}

function availableWindows(rules: readonly PlanRule[], day: string, minute: number) {
  const windows = rules.filter((r) => r.kind === 'window');
  if (!windows.length) return [1440 - minute];
  const weekday = new Date(day).getUTCDay();
  const merged: { start: number; end: number }[] = [];
  for (const r of windows
    .filter((w) => w.weekday === null || w.weekday === weekday)
    .sort((a, b) => a.start - b.start)) {
    const start = Math.max(r.start, minute);
    if (start >= r.end) continue;
    const previous = merged.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, r.end);
    else merged.push({ start, end: r.end });
  }
  return merged.map((w) => w.end - w.start);
}

function examPolicy(rules: readonly PlanRule[], day: string) {
  const exams = rules.filter((r) => r.kind === 'exam');
  const next = exams.filter((e) => e.date >= day).sort((a, b) => a.date.localeCompare(b.date))[0];
  const recent = exams.some((e) => days(e.date, day) > 0 && days(e.date, day) <= 2);
  const automatic: Campaign = next && days(day, next.date) <= 7 ? 'sprint' : recent ? 'recovery' : 'steady';
  return { exam: next, campaign: rules.findLast((r) => r.kind === 'campaign')?.campaign ?? automatic };
}
type Ranked = { candidate: PlanCandidate; score: number; why: string[] };

// At most three slots. Track the highest value bundle for each occupied time and count.
function bundle(pool: Ranked[], minutes: number, limit: number, windows: number[]) {
  // Booking a bundle must fit discrete windows; serial allocation could strand a longer activity.
  function fits(items: Ranked[], free: number[]): boolean {
    const [item, ...rest] = items;
    if (!item) return true;
    return free.some(
      (size, i) =>
        size >= item.candidate.minutes &&
        fits(
          rest,
          free.map((v, index) => (index === i ? v - item.candidate.minutes : v)),
        ),
    );
  }
  // Partition by topic so another copy of the same signal cannot crowd out a second check.
  if (limit === 0 || !pool.length) return [];
  const groups = new Map<string, Ranked[]>();
  for (const item of pool) {
    const group = groups.get(item.candidate.topic) ?? [];
    group.push(item);
    groups.set(item.candidate.topic, group);
  }
  let states = new Map([['', { score: 0, items: [] as Ranked[], total: 0 }]]);
  for (const group of groups.values()) {
    const next = new Map(states);
    for (const held of states.values())
      for (const item of group) {
        const total = held.total + item.candidate.minutes;
        if (held.items.length >= limit || total > minutes) continue;
        const items = [...held.items, item];
        const key =
          windows.length === 1
            ? items.length + '/' + total
            : items
                .map((i) => i.candidate.minutes)
                .sort((a, b) => a - b)
                .join(',');
        const score = held.score + item.score;
        if (score <= (next.get(key)?.score ?? -Infinity) || !fits(items, windows)) continue;
        next.set(key, { score, items, total });
      }
    states = next;
  }
  return [...states.values()]
    .reduce((best, s) => (s.score > best.score ? s : best))
    .items.sort((a, b) => b.score - a.score);
}

export function planToday(input: TodayInput) {
  const { day, minute } = localClock(input.now, input.timeZone);
  const rules = input.rules ?? [];
  const { exam, campaign } = examPolicy(rules, day);
  const returning =
    !!input.lastOpenedAt && days(localClock(input.lastOpenedAt, input.timeZone).day, day) >= 21;
  const windows = availableWindows(rules, day, minute);
  const sessions = rules
    .filter((r) => r.kind === 'session')
    .filter((r) => r.date === day && Date.parse(r.expiresAt) > Date.parse(input.now));
  const resting = rules.some((r) => (r.kind === 'rest' || r.kind === 'exception') && r.date === day);
  const hasTimeRule =
    sessions.length > 0 || rules.some((r) => r.kind === 'window') || resting || input.mode === 'one-hand';
  const assumedMinutes = input.constraints.budget_min === null && !hasTimeRule ? 15 : null;
  const budgetBasis =
    input.constraints.budget_min !== null
      ? '本人时间预算'
      : assumedMinutes !== null
        ? '可用时间未知，暂按 15 分钟列出可调整的建议。'
        : '可用时间取本次模式、时段和本人约束。';
  const budgetMinutes = Math.min(
    integer(input.constraints.budget_min ?? assumedMinutes ?? 1440, 0, 1440),
    ...sessions.map((s) => s.minutes),
    windows.reduce((a, b) => a + b, 0),
    input.mode === 'one-hand' ? 3 : 1440,
    resting ? 0 : 1440,
  );
  const upcomingSchoolwork = rules
    .filter((r) => r.kind === 'schoolwork')
    .filter((r) => days(day, r.date) >= 0 && days(day, r.date) <= 7);
  const homework = rules.filter((r) => r.kind === 'schoolwork').filter((r) => r.date === day);
  const schoolMinutes = homework.reduce((sum, r) => sum + r.minutes, 0);
  const locked = new Set(input.constraints.locks);
  const otherDayLocks = new Set<string>();
  const deferred = new Set<string>(),
    preferred = new Set<string>();
  const conflicts: { constraints: string[]; options: string[] }[] = [];
  for (const r of rules) {
    if (r.kind === 'lock') {
      if (r.date === day) locked.add(r.activityId);
      else otherDayLocks.add(r.activityId);
    }
    if (r.kind === 'defer' && day < r.until) deferred.add(r.activityId);
    if (r.kind === 'replace' && r.date === day) {
      deferred.add(r.activityId);
      preferred.add(r.replacementId);
    }
  }
  const activeGoal = input.goal?.status === 'active' && input.goal.text ? input.goal.id : null;
  const deadlines = input.constraints.deadlines.map((d) => ({
    ...d,
    day: localClock(d.at, input.timeZone).day,
  }));
  const catalog = new Map<string, PlanCandidate>();
  for (const c of input.candidates) {
    if (catalog.has(c.id)) throw new Error('活动身份重复。');
    integer(c.minutes, 1, 1440);
    for (const probability of [c.retention, c.information])
      if (probability !== undefined && (!Number.isFinite(probability) || probability < 0 || probability > 1))
        throw new Error('预测或信息量超出范围。');
    catalog.set(c.id, c);
  }
  for (const c of packCandidates()) if (!catalog.has(c.id)) catalog.set(c.id, c);
  const protectedItems = [...catalog.values()].filter(
    (c) => locked.has(c.id) || c.state === 'in-progress' || (c.state === 'completed' && c.date === day),
  );
  const protectedIds = new Set(protectedItems.map((c) => c.id));
  for (const rule of rules) {
    if (rule.kind === 'replace' && rule.date === day && protectedIds.has(rule.activityId))
      preferred.delete(rule.replacementId);
  }
  for (const id of locked)
    if (!catalog.get(id)?.open)
      conflicts.push({
        constraints: [id, '锁定材料当前不可打开'],
        options: ['保留锁定', '检查活动授权或材料'],
      });
  for (const id of deferred)
    if (protectedIds.has(id))
      conflicts.push({
        constraints: [id, '推迟或替换与保护状态冲突'],
        options: ['保留现场', '调整未开始的建议'],
      });
  const reserved = protectedItems
    .filter((c) => c.state !== 'completed')
    .reduce((sum, c) => sum + c.minutes, 0);
  // Locked work and unfinished drafts need real time blocks too. Reserve the smallest
  // fitting window before admitting suggestions, keeping long windows available.
  const freeWindows = [...windows];
  const pendingProtected = protectedItems
    .filter((c) => c.state !== 'completed')
    .sort((a, b) => b.minutes - a.minutes);
  for (const item of pendingProtected) {
    freeWindows.sort((a, b) => a - b);
    const index = freeWindows.findIndex((size) => size >= item.minutes);
    if (index >= 0) freeWindows[index] = freeWindows[index]! - item.minutes;
    else {
      freeWindows.length = 0;
      if (reserved + schoolMinutes <= budgetMinutes)
        conflicts.push({ constraints: [item.id, '连续时段不足'], options: ['保留原安排', '调整可用时段'] });
      break;
    }
  }
  const unresolvedLock = [...locked].some((id) => !catalog.has(id));
  const remaining = unresolvedLock ? 0 : Math.max(0, budgetMinutes - reserved - schoolMinutes);
  if (reserved + schoolMinutes > budgetMinutes)
    conflicts.push({
      constraints: [
        ...protectedItems.filter((c) => c.state !== 'completed').map((c) => c.id),
        ...homework.map((h) => h.topic + '作业 ' + h.minutes + ' 分钟'),
        '可用 ' + budgetMinutes + ' 分钟',
      ],
      options: ['保留已有安排并休息', '由本人调整可用时段或锁定项'],
    });
  const pool: Ranked[] = [];
  const tradeoffs: { activityId: string; reason: string }[] = [];
  const actions = ['defer', 'replace', 'rest', 'lock'] as const;
  for (const c of [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (
      !c.open ||
      c.refused ||
      !c.evidence.length ||
      c.state ||
      locked.has(c.id) ||
      otherDayLocks.has(c.id) ||
      deferred.has(c.id) ||
      (c.goalId && c.goalId !== activeGoal)
    )
      continue;
    if ((input.mode === 'one-hand' && c.input !== 'tap') || (input.mode === 'voice' && c.input !== 'voice'))
      continue;
    if (returning && c.kind !== 'probe' && c.kind !== 'counterexample') continue;
    if (!returning && campaign === 'recovery' && c.kind !== 'recovery') continue;
    if (c.kind === 'recovery' && campaign !== 'recovery') continue;
    const info = c.information ?? (c.retention === undefined ? 0 : 4 * c.retention * (1 - c.retention));
    const why = [c.reason];
    let score = 20 + 30 * info + (1 - (c.retention ?? 1)) * 12;
    if (info > 0) why.push('本次辨别可补充对「' + c.topic + '」的判断。');
    if (c.highConfidenceWrong && c.kind === 'counterexample') {
      score += 45;
      why.push('高信心错答后先做最小反例。');
    }
    if (returning) {
      score += 70 * info;
      why.push('长假后先摸底，再按结果重排。');
    }
    if (c.open.kind === 'activity') score += 18;
    if (c.goalId) {
      score += 12;
      why.push('对应当前学习目标。');
    }
    const school = upcomingSchoolwork
      .filter((h) => h.topic === c.topic)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    const dueBeforeSchool =
      school &&
      deadlines.some((d) => [c.id, c.goalId, c.topic].includes(d.ref) && d.day >= day && d.day < school.date);
    if (school && !dueBeforeSchool) {
      score -= 32;
      const reason = school.date + ' 的学校作业已覆盖「' + school.topic + '」，可留到作业时再检验。';
      why.push(reason);
      tradeoffs.push({ activityId: c.id, reason });
    }
    if (rules.some((r) => r.kind === 'progress' && r.topic === c.topic)) {
      score += 8;
      why.push('衔接当前校内进度或本人预习安排。');
    }
    if (exam?.scope.includes(c.topic)) {
      score += 10 + (exam.weights.find((w) => w.topic === c.topic)?.weight ?? 0) / 4;
      why.push('属于考试范围。');
    }
    if (campaign === 'sprint' && c.kind === 'exam') {
      score += 22;
      why.push('冲刺阶段优先限时检验或急救卡。');
    }
    if (
      deadlines.some(
        (d) => [c.id, c.goalId, c.topic].includes(d.ref) && days(day, d.day) >= 0 && days(day, d.day) <= 7,
      )
    ) {
      score += 18;
      why.push('对应期限在七天内。');
    }
    if (sessions.some((s) => s.condition !== 'time') && c.minutes <= 5) {
      score += 15;
      why.push('当前时段选择短活动。');
    }
    if (preferred.has(c.id)) {
      score += 500;
      why.push('本人选定的替换项。');
    }
    const order = input.contentOrder?.indexOf(c.id) ?? -1;
    if (order >= 0) score += 10 / (order + 1);
    pool.push({ candidate: c, score, why });
  }
  // Starter material fills an empty feasible inventory. It must not displace prepared work.
  const feasible = pool.filter(
    (p) => p.candidate.minutes <= remaining && freeWindows.some((w) => p.candidate.minutes <= w),
  );
  const prepared = feasible.filter(
    (p) => p.candidate.open?.kind === 'activity' || preferred.has(p.candidate.id),
  );
  const limit = Math.max(
    0,
    (returning ? 2 : 3) - protectedItems.filter((c) => c.state !== 'completed').length,
  );
  const selected = bundle(prepared.length ? prepared : feasible, remaining, limit, freeWindows);
  for (const id of preferred)
    if (!selected.some((i) => i.candidate.id === id) && !protectedIds.has(id))
      conflicts.push({
        constraints: [id, '替换项当前无法排入'],
        options: ['改选可用活动', '调整时间或休息'],
      });
  const items = selected.map(({ candidate, why }) => ({ candidate, why, actions }));
  const overview = returning
    ? {
        retained: [...new Set(input.candidates.filter((c) => (c.retention ?? 0) >= 0.7).map((c) => c.topic))],
        faded: [...new Set(input.candidates.filter((c) => (c.retention ?? 1) < 0.5).map((c) => c.topic))],
        unknown: [...new Set(input.candidates.filter((c) => c.retention === undefined).map((c) => c.topic))],
      }
    : null;
  const shortlist = feasible.map(({ candidate }) => candidate.id);
  const forecast = examForecast(exam, input.frozenExamForecast, input.now);
  return {
    day,
    campaign,
    returning,
    overview,
    forecast,
    activeGoal,
    protectedItems,
    items,
    shortlist,
    tradeoffs,
    actions,
    resting,
    budgetMinutes,
    budgetBasis,
    assumedMinutes,
    schoolMinutes,
    totalMinutes: reserved + items.reduce((n, i) => n + i.candidate.minutes, 0),
    conflicts,
  };
}
