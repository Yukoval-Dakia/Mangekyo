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
  readonly now: string; readonly timeZone?: string;
  readonly mode?: string | null; readonly duration?: string | null;
  readonly lastOpenedAt?: string; readonly latestActivityAt?: string;
};

export type TodayHostView = {
  readonly campaignState: CampaignStateView;
  readonly reentryPlan: LongBreakReentryPlan;
  readonly filter: { bucket: MicroTimeBucket; inputMode: 'one_hand' | 'any' } | undefined;
};

/** Campaign, micro-filter selection and long-break reentry inputs shared by the today host. */
export function resolveTodayHostView(
  settings: TodayHostInput,
  rules: readonly PlanRule[],
  goals: readonly { id: string; text: string | null; status: GoalStatus }[],
  graphSources: readonly ReentryConceptSource[],
): TodayHostView {
  const campaignState = resolveCampaignState({
    now: settings.now, ...(settings.timeZone !== undefined ? { timeZone: settings.timeZone } : {}), rules, deadlines: [], goals,
  });
  const bucket: MicroTimeBucket | undefined = settings.duration === '3min' || settings.duration === '15min' || settings.duration === '45min+'
    ? settings.duration : campaignState.phase === 'decompress' ? '15min' : undefined;
  const filtering = settings.mode === 'one-hand' || settings.duration != null || campaignState.phase === 'decompress';
  const filter = filtering
    ? { bucket: bucket ?? '15min' as MicroTimeBucket, inputMode: settings.mode === 'one-hand' ? 'one_hand' as const : 'any' as const }
    : undefined;
  const inactiveDays = settings.lastOpenedAt !== undefined
    ? inactiveDaysBetween(settings.lastOpenedAt, settings.now, settings.timeZone ?? 'Asia/Tokyo')
    : settings.latestActivityAt !== undefined
      ? inactiveDaysBetween(settings.latestActivityAt, settings.now, settings.timeZone ?? 'Asia/Tokyo')
      : 0;
  const today = isoDayAt(settings.now, settings.timeZone ?? 'Asia/Tokyo');
  const lockedActivityIds = rules
    .filter(rule => rule.kind === 'lock' && rule.date === today)
    .map(rule => (rule as Extract<PlanRule, { kind: 'lock' }>).activityId);
  const reentryPlan = buildLongBreakReentryPlan({
    inactiveDays,
    concepts: graphSources.map(source => ({
      conceptId: source.id, title: source.title, retentionProbability: source.retrievability, examWeight: 1,
    })),
    lockedActivityIds,
  });
  return { campaignState, reentryPlan, filter };
}

/** Apply the optional micro filter without disturbing the unfiltered candidate list. */
export function applyMicroFilter<T extends { id: string; minutes: number }>(
  candidates: readonly T[], view: TodayHostView,
): readonly T[] {
  if (!view.filter) return candidates;
  const { admitted } = filterMicroActivities(candidates, {
    bucket: view.filter.bucket, inputMode: view.filter.inputMode, campaignPhase: view.campaignState.phase,
  });
  return admitted;
}
