import { filterMicroActivities, resolveCampaignState, type CampaignStateView, type MicroTimeBucket } from './campaign-and-micro.ts';
import { buildLongBreakReentryPlan, type LongBreakReentryPlan } from './exam-pacing-and-reentry.ts';
import type { GoalStatus } from './goal-values.ts';
import type { PlanRule } from './rules.ts';

type ReentryConceptSource = { readonly id: string; readonly title: string; readonly retrievability: number | null };

/** ISO calendar day in the given zone (organizer `dayOf` uses locale formatting, which is not ISO-safe). */
export function isoDayAt(instant: string, timeZone: string): string | undefined {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(ms));
    const pick = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  } catch { return undefined; }
}

export function inactiveDaysBetween(earlierIso: string | undefined, nowIso: string, timeZone: string): number {
  if (earlierIso === undefined) return 0;
  const earlier = isoDayAt(earlierIso, timeZone), now = isoDayAt(nowIso, timeZone);
  if (!earlier || !now) return 0;
  const ms = Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 1, Number(now.slice(8, 10))) -
    Date.UTC(Number(earlier.slice(0, 4)), Number(earlier.slice(5, 7)) - 1, Number(earlier.slice(8, 10)));
  return Math.max(0, Math.round(ms / 86400000));
}

export type TodayHostInput = {
  readonly now: string; readonly timeZone?: string; readonly day?: string; readonly paused?: boolean;
  readonly mode?: string | null; readonly duration?: string | null;
  readonly lastOpenedAt?: string; readonly latestActivityAt?: string;
};

export type TodayHostView = {
  readonly campaignState: CampaignStateView;
  readonly reentryPlan: LongBreakReentryPlan;
  readonly today: string | undefined;
  readonly lockedActivityIds: readonly string[];
  readonly filter: { bucket?: MicroTimeBucket; inputMode: 'one_hand' | 'any' } | undefined;
};

const HEAVY_KINDS = new Set(['exam', 'simulation', 'mock', 'timed', 'lesson', 'practice', 'drill']);

/** Campaign, micro-filter selection and long-break reentry inputs shared by the today host. */
export function resolveTodayHostView(
  settings: TodayHostInput,
  rules: readonly PlanRule[],
  goals: readonly { id: string; text: string | null; status: GoalStatus }[],
  graphSources: readonly ReentryConceptSource[],
): TodayHostView {
  const timeZone = settings.timeZone ?? 'Asia/Shanghai';
  const campaignState = resolveCampaignState({
    now: settings.now, timeZone, rules, deadlines: [], goals,
  });
  const bucket: MicroTimeBucket | undefined =
    settings.duration === '3min' || settings.duration === '15min' || settings.duration === '45min+'
      ? settings.duration : undefined;
  const filtering = settings.mode === 'one-hand' || bucket !== undefined || campaignState.phase === 'decompress';
  const filter = filtering
    ? { ...(bucket !== undefined ? { bucket } : {}), inputMode: settings.mode === 'one-hand' ? 'one_hand' as const : 'any' as const }
    : undefined;
  const today = settings.day ?? isoDayAt(settings.now, timeZone);
  const lockedActivityIds = rules
    .filter((rule): rule is Extract<PlanRule, { kind: 'lock' }> =>
      rule.kind === 'lock' && !rule.warmup && rule.date === today)
    .map(rule => rule.activityId);
  const deferredIds = new Set<string>();
  const addDeferred = (id: string) => {
    deferredIds.add(id);
    const stripped = id.replace(/@\d+$/, '');
    if (stripped !== id) deferredIds.add(stripped);
  };
  for (const rule of rules) {
    if (rule.kind === 'defer' && today !== undefined && today < rule.until) addDeferred(rule.activityId);
    if (rule.kind === 'replace' && rule.date === today) addDeferred(rule.activityId);
  }
  const inactiveDays = settings.paused ? 0
    : settings.lastOpenedAt !== undefined ? inactiveDaysBetween(settings.lastOpenedAt, settings.now, timeZone)
    : settings.latestActivityAt !== undefined ? inactiveDaysBetween(settings.latestActivityAt, settings.now, timeZone)
    : 0;
  const reentryPlan = buildLongBreakReentryPlan({
    inactiveDays,
    concepts: settings.paused ? [] : graphSources.map(source => ({
      conceptId: source.id, title: source.title, retentionProbability: source.retrievability, examWeight: 1,
      ...(deferredIds.has(source.id) || deferredIds.has(`concept:${source.id}`) ? { refused: true as const } : {}),
    })),
    lockedActivityIds: settings.paused ? [] : lockedActivityIds,
  });
  return { campaignState, reentryPlan, today, lockedActivityIds, filter };
}

/** Apply the optional micro filter while strictly preserving protected (locked/in-progress/today-completed) items. */
export function applyMicroFilter<T extends {
  id: string; minutes: number; kind?: string; input?: 'tap' | 'voice' | 'write';
  oneHandFriendly?: boolean; state?: string; date?: string;
}>(
  candidates: readonly T[], view: TodayHostView,
): readonly T[] {
  if (!view.filter) return candidates;
  const locked = new Set(view.lockedActivityIds);
  const isProtected = (item: T) =>
    locked.has(item.id) || item.state === 'in-progress' || (item.state === 'completed' && item.date === view.today);
  const kept: T[] = [];
  const filterable: T[] = [];
  for (const item of candidates) {
    if (isProtected(item)) kept.push(item);
    else filterable.push(item);
  }
  if (view.filter.bucket !== undefined) {
    const { admitted } = filterMicroActivities(filterable, {
      bucket: view.filter.bucket, inputMode: view.filter.inputMode, campaignPhase: view.campaignState.phase,
    });
    return [...kept, ...admitted];
  }
  // When no explicit duration bucket was requested, only enforce the active mode / decompress heavy-load guard.
  const admitted = filterable.filter(item => {
    if (view.filter!.inputMode === 'one_hand') {
      const ok = item.oneHandFriendly !== false &&
        (item.oneHandFriendly === true || item.input === 'tap' || item.input === 'voice');
      if (!ok) return false;
    }
    if (view.campaignState.phase === 'decompress') {
      const heavy = item.kind === 'exam' || (item.kind !== undefined && HEAVY_KINDS.has(item.kind) && item.minutes > 20);
      if (heavy) return false;
    }
    return true;
  });
  return [...kept, ...admitted];
}
