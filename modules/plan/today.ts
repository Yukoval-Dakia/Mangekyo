import type { CanonicalEvidenceSliceV1 } from '@mangekyo/kernel';
import type { GoalStatus } from './goal-values.ts';
import { freshMaterialSummary, freshMaterialWindowDays, type FreshMaterialSummary } from './fresh-materials.ts';
import { pendingCorrectionSummary, type PendingCorrectionSummary } from './pending-corrections.ts';
import { todayWarmupRules, type Campaign, type PlanRule } from './rules.ts';
import { examForecast, reviewExamScore, type ExamScoreObservation, type FrozenExamForecast } from './exam-forecast.ts';
import { packCandidates } from './offline-pack.ts';
import { instant, integer, oneOf } from './validation.ts';

export { freshMaterialWindowDays, projectFreshMaterialCandidates } from './fresh-materials.ts';
export type { FreshMaterialSource, FreshMaterialSummary } from './fresh-materials.ts';
export { projectPendingCorrectionCandidates } from './pending-corrections.ts';
export type { PendingCorrectionItem, PendingCorrectionSource, PendingCorrectionSummary } from './pending-corrections.ts';

type CandidateUncertainty =
  | { readonly kind: 'interval'; readonly low: number; readonly high: number }
  | { readonly kind: 'unknown'; readonly reason: string; readonly needed: string };

export type PlanCandidate = {
  id: string;
  title: string;
  topic: string;
  kind: 'review' | 'probe' | 'counterexample' | 'exam' | 'recovery' | 'lesson';
  minutes: number;
  durationBasis: string;
  input: 'tap' | 'voice' | 'write';
  open: { kind: 'activity' | 'pack' | 'material'; id: string; rev: number } | null;
  reason: string;
  evidence: readonly string[];
  delayImpact: string;
  goalId?: string;
  retention?: number;
  information?: number;
  uncertainty?: CandidateUncertainty;
  excludedFromProbePool?: boolean;
  highConfidenceWrong?: boolean;
  refused?: boolean;
  state?: 'in-progress' | 'completed';
  date?: string;
  draftRef?: string;
  // Authorized result for this completed probe's frozen item in the current return round.
  // For a known result, evidence includes the submission/result witness.
  returnProbeResult?: 'correct' | 'incorrect' | 'unknown';
  // Uncorrected wrong or partially-correct items from the latest submitted
  // attempt on this frozen paper; the candidate retires once all are corrected.
  pendingCorrection?: PendingCorrectionSummary;
  // Newly saved learner material with no derived practice/classroom/companion
  // session yet; retires automatically once an activity is derived from it.
  freshMaterial?: FreshMaterialSummary;
  // From authorized content/issuance witnesses in the same planning snapshot.
  examPrep?:
    | { kind: 'archetype'; coveredQuestionCount: number }
    | { kind: 'first-aid' | 'timed' };
};

// Call with the admitted pool from the same snapshot as these plan candidates.
export function applyCandidateInformation(
  candidates: readonly PlanCandidate[],
  rankedCandidates: readonly { readonly ref: string; readonly info_gain: number; readonly uncertainty: CandidateUncertainty }[],
  pool: CanonicalEvidenceSliceV1['candidate_pool'],
): PlanCandidate[] {
  const screened = new Set(pool.map(candidate => candidate.ref));
  const information = new Map(rankedCandidates.map(row => [row.ref, row]));
  const explicitIds = new Set(candidates.map(candidate => candidate.id));
  const screenedPacks = packCandidates().filter(pack => screened.has(pack.id) && !explicitIds.has(pack.id));
  return [...candidates, ...screenedPacks].map(candidate => {
    if (!screened.has(candidate.id)) return candidate;
    const row = information.get(candidate.id);
    if (!row) return { ...candidate, excludedFromProbePool: true };
    if (!candidate.open || candidate.refused || candidate.state || !candidate.evidence.length) return candidate;
    return { ...candidate, excludedFromProbePool: false, information: row.info_gain, uncertainty: row.uncertainty };
  });
}

export type TodayInput = {
  now: string;
  timeZone: string;
  constraints: CanonicalEvidenceSliceV1['constraints'];
  candidates: readonly PlanCandidate[];
  goal?: { id: string; text: string | null; status: GoalStatus };
  rules?: readonly PlanRule[];
  // Keep the pre-return visit timestamp stable across refreshes of the return round.
  lastOpenedAt?: string;
  mode?: 'one-hand' | 'voice' | 'any';
  duration?: TodayDuration;
  // Agent may rank authorized real content. Apply only after hard admission.
  contentOrder?: readonly string[];
  frozenExamForecast?: FrozenExamForecast;
  examScore?: ExamScoreObservation;
};
const durationMinutes = { '3min': 3, '15min': 15, '45min+': 45 } as const;
export type TodayDuration = keyof typeof durationMinutes;

export function todayDuration(value: string | null): { duration?: TodayDuration } {
  return value === null ? {} : {duration: oneOf(value, ['3min', '15min', '45min+'])};
}

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
  const previous = exams.filter((e) => e.date < day).sort((a, b) => b.date.localeCompare(a.date))[0];
  const automatic: Campaign =
    next && days(day, next.date) <= 7 ? 'sprint' : previous && days(previous.date, day) <= 2 ? 'recovery' : 'steady';
  const campaign = rules.findLast((r) => r.kind === 'campaign')?.campaign ?? automatic;
  const latestExam = next?.date === day ? next : previous;
  return { exam: campaign === 'recovery' ? latestExam : next, campaign };
}

function sprintPriority(candidate: PlanCandidate, inScope: boolean, scopeKnown: boolean) {
  if (scopeKnown && !inScope) return null;
  const prep = candidate.examPrep;
  if (prep?.kind === 'archetype' && prep.coveredQuestionCount > 1) {
    return { boost: 55 + 5 * Math.min(prep.coveredQuestionCount, 12),
      reason: '高频母题，已有 ' + prep.coveredQuestionCount + ' 道原卷题关联。' };
  }
  if (prep?.kind === 'first-aid' && candidate.minutes <= 3) {
    return { boost: 70, reason: '可在三分钟内重看已备好的急救卡。' };
  }
  if (prep?.kind === 'timed') return { boost: 55, reason: '考前做一次已备好的限时模拟。' };
  return null;
}

const returnProbeLimit = 2;
const isReturnProbe = (c: PlanCandidate) => c.kind === 'probe' || c.kind === 'counterexample';

function witnessedProbeResults(completed: readonly PlanCandidate[]) {
  const results = new Map<string, PlanCandidate | null>();
  for (const probe of completed) {
    const outcome = probe.returnProbeResult;
    if ((outcome !== 'correct' && outcome !== 'incorrect') || !probe.evidence.length) continue;
    const previous = results.get(probe.topic);
    if (previous === undefined) results.set(probe.topic, probe);
    else if (previous?.returnProbeResult !== outcome) results.set(probe.topic, null);
  }
  return results;
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
  const catalog = new Map<string, PlanCandidate>();
  for (const c of input.candidates) {
    if (catalog.has(c.id)) throw new Error('活动身份重复。');
    integer(c.minutes, 1, 1440);
    for (const probability of [c.retention, c.information])
      if (probability !== undefined && (!Number.isFinite(probability) || probability < 0 || probability > 1))
        throw new Error('预测或信息量超出范围。');
    if (c.examPrep?.kind === 'archetype') integer(c.examPrep.coveredQuestionCount, 1, Number.MAX_SAFE_INTEGER);
    if (c.pendingCorrection !== undefined) pendingCorrectionSummary(c.pendingCorrection);
    if (c.freshMaterial !== undefined) freshMaterialSummary(c.freshMaterial);
    catalog.set(c.id, c);
  }
  for (const c of packCandidates()) if (!catalog.has(c.id)) catalog.set(c.id, c);
  const { rules, warmup: requestedWarmup } = todayWarmupRules(input.rules ?? [], day, input.timeZone, [...catalog.values()]);
  const { exam, campaign } = examPolicy(rules, day);
  const returning =
    !!input.lastOpenedAt && days(localClock(input.lastOpenedAt, input.timeZone).day, day) >= 21;
  const windows = availableWindows(rules, day, minute);
  const sessions = rules
    .filter((r) => r.kind === 'session')
    .filter((r) => r.date === day && Date.parse(r.expiresAt) > Date.parse(input.now));
  const resting = rules.some((r) => (r.kind === 'rest' || r.kind === 'exception') && r.date === day);
  const duration = input.duration ?? (input.mode === 'one-hand' ? '3min' : undefined);
  const presetMinutes = duration === undefined ? null : durationMinutes[duration];
  const presetCap = duration === '45min+' ? null : presetMinutes;
  const hasTimeRule =
    sessions.length > 0 || rules.some((r) => r.kind === 'window') || resting;
  const assumedMinutes = input.constraints.budget_min === null && !hasTimeRule && presetCap === null
    ? presetMinutes ?? 15 : null;
  const budgetBasis =
    input.constraints.budget_min !== null
      ? '本人时间预算'
      : assumedMinutes !== null
        ? '可用时间未知，暂按 ' + assumedMinutes + ' 分钟列出可调整的建议。'
        : '可用时间取本次模式、时段和本人约束。';
  const budgetMinutes = Math.min(
    integer(input.constraints.budget_min ?? assumedMinutes ?? 1440, 0, 1440),
    ...sessions.map((s) => s.minutes),
    windows.reduce((a, b) => a + b, 0),
    presetCap ?? 1440,
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
    if (r.kind === 'lock' && !r.warmup) {
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
  const protectedItems = [...catalog.values()].filter(
    (c) => locked.has(c.id) || c.state === 'in-progress' || (c.state === 'completed' && c.date === day),
  );
  const protectedIds = new Set(protectedItems.map((c) => c.id));
  // A refresh with the same return timestamp must still account for submitted probes.
  const returnPlanning = returning && campaign !== 'recovery';
  const completedProbes = returnPlanning
    ? protectedItems.filter((c) => c.state === 'completed' && c.date === day && isReturnProbe(c))
    : [];
  const checkedTopics = new Set(completedProbes.map((c) => c.topic));
  const probesLeft = returnProbeLimit - checkedTopics.size;
  const probing = returnPlanning && probesLeft > 0;
  const probeResults = returnPlanning && !probing ? witnessedProbeResults(completedProbes) : null;
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
  let reserved = protectedItems
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
  const anchor = requestedWarmup ? catalog.get(requestedWarmup) : undefined;
  let warmup: string | null = null;
  if (anchor?.open && !anchor.state && !deferred.has(anchor.id) && (!anchor.goalId || anchor.goalId === activeGoal) &&
      !unresolvedLock && freeWindows.length > 0 && budgetMinutes >= reserved + schoolMinutes && budgetMinutes > 0) {
    const heldIndex = protectedItems.findIndex(item => item.id === anchor.id);
    const window = freeWindows.findIndex(minutes => minutes >= anchor.minutes);
    if (heldIndex >= 0 || (window >= 0 && reserved + schoolMinutes + anchor.minutes <= budgetMinutes)) {
      if (heldIndex >= 0) protectedItems.splice(heldIndex, 1);
      else {
        freeWindows[window] = freeWindows[window]! - anchor.minutes;
        reserved += anchor.minutes;
        pendingProtected.push(anchor);
        protectedIds.add(anchor.id);
        locked.add(anchor.id);
      }
      protectedItems.unshift(anchor);
      warmup = anchor.id;
    }
  }
  const freeMinutes = unresolvedLock ? 0 : Math.max(0, budgetMinutes - reserved - schoolMinutes);
  const remaining = campaign === 'recovery' ? Math.min(10, freeMinutes) : freeMinutes;
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
      c.refused || c.excludedFromProbePool ||
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
    if (duration === '45min+' && c.minutes < durationMinutes[duration]) continue;
    if ((campaign === 'recovery') !== (c.kind === 'recovery')) continue;
    if (probing && (!isReturnProbe(c) || checkedTopics.has(c.topic))) continue;
    const info = c.information ?? (c.retention === undefined ? 0 : 4 * c.retention * (1 - c.retention));
    const why = [c.reason];
    let score = 20 + 30 * info + (1 - (c.retention ?? 1)) * 12;
    if (info > 0) {
      why.push(c.uncertainty?.kind === 'unknown' && c.uncertainty.reason === 'missing-independent-scored-evidence'
        ? '「' + c.topic + '」在这类题上的表现仍未知，可以先摸底。'
        : '本次辨别可补充对「' + c.topic + '」的判断。');
    }
    if (c.highConfidenceWrong && c.kind === 'counterexample') {
      score += 45;
      why.push('高信心错答后先做最小反例。');
    }
    if (probing) {
      score += 70 * info;
      why.push('长假后先摸底，再按结果重排。');
    }
    const probe = probeResults?.get(c.topic);
    if (probe?.returnProbeResult === 'incorrect') {
      score += 30;
      why.push('本轮摸底在「' + c.topic + '」答错，优先复查。');
    } else if (probe?.returnProbeResult === 'correct') {
      score -= 20;
      why.push('本轮摸底已独立答对「' + c.topic + '」，可把时间先给其他主题。');
    }
    if (c.open.kind === 'activity') score += 18;
    if (c.pendingCorrection) {
      score += 36;
      why.push('已提交的作答还有未订正的错题或部分正确，先补上再学新内容。');
    }
    if (c.freshMaterial) {
      const hasRedPen = (c.freshMaterial.redPenErrorCount ?? 0) > 0;
      const ageDays = Math.max(0, days(c.freshMaterial.savedAt, input.now));
      const recency = Math.max(0, 1 - ageDays / freshMaterialWindowDays);
      score += (hasRedPen ? 26 : 20) + recency;
      why.push(hasRedPen
        ? '刚交入的原件带有错题标记，优先从这里切入复盘。'
        : '刚交入的真实材料尚未衍生练习或对话，优先从这里接着学。');
    }
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
    if (campaign === 'sprint' && !probing) {
      const inScope = exam?.scope.includes(c.topic) ?? false;
      if (inScope) {
        score += 10 + (exam?.weights.find((w) => w.topic === c.topic)?.weight ?? 0) / 4;
        why.push('属于考试范围。');
      }
      const priority = sprintPriority(c, inScope, !!exam?.scope.length);
      if (priority) {
        score += priority.boost;
        why.push(priority.reason);
      }
    }
    if (campaign === 'recovery') {
      why.push('考后只安排已有复盘，最多一项、十分钟，可直接休息。');
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
    const candidate = probe ? { ...c, evidence: [...new Set([...c.evidence, ...probe.evidence])] } : c;
    pool.push({ candidate, score, why });
  }
  // Starter material fills an empty feasible inventory. It must not displace prepared work.
  const feasible = pool.filter(
    (p) => p.candidate.minutes <= remaining && freeWindows.some((w) => p.candidate.minutes <= w),
  );
  const prepared = feasible.filter(
    (p) => p.candidate.open?.kind === 'activity' || p.candidate.open?.kind === 'material' || preferred.has(p.candidate.id),
  );
  const slots = campaign === 'recovery' ? 1 : probing ? returnProbeLimit : 3;
  const freeSlots = Math.max(0, slots - pendingProtected.length);
  const limit = probing ? Math.min(probesLeft, freeSlots) : freeSlots;
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
  const scoreReview = campaign === 'recovery' ? reviewExamScore(exam, forecast, input.examScore, input.now) : null;
  return {
    day,
    campaign,
    returning,
    overview,
    forecast,
    scoreReview,
    activeGoal,
    protectedItems,
    warmup,
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
