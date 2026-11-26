import type { GoalStatus } from './goal-values.ts';
import type { Campaign, PlanRule } from './rules.ts';

export type CampaignPhase = 'steady' | 'sprint' | 'decompress';
export type MicroTimeBucket = '3min' | '15min' | '45min+';
export type MicroInputMode = 'one_hand' | 'any';

export type CampaignStateInput = {
  readonly now: string;
  readonly timeZone?: string;
  readonly rules?: readonly PlanRule[];
  readonly deadlines?: readonly { readonly ref: string; readonly at: string; readonly title?: string }[];
  readonly goals?: readonly { readonly id: string; readonly text: string | null; readonly status: GoalStatus }[];
  readonly manualOverride?: CampaignPhase | 'recovery' | null;
  readonly sprintWindowDays?: number;
  readonly decompressWindowDays?: number;
};

export type CampaignStateView = {
  readonly phase: CampaignPhase;
  readonly source: 'manual' | 'rule' | 'deadline' | 'default';
  readonly label: string;
  readonly description: string;
  readonly daysToExam: number | null;
  readonly daysSinceExam: number | null;
  readonly activeExamRef?: string;
  readonly activeExamDate?: string;
  readonly policy: {
    readonly maxNewLoad: 'normal' | 'restricted' | 'paused';
    readonly focusKinds: readonly string[];
    readonly suppressHeavyNewTasks: boolean;
    readonly prioritizeCheatsheetAndArchetypes: boolean;
  };
};

export type MicroActivityCandidate = {
  readonly id: string;
  readonly minutes: number;
  readonly input?: 'tap' | 'voice' | 'write';
  readonly oneHandFriendly?: boolean;
  readonly kind?: string;
  readonly title?: string;
};

type ExamDate = { readonly date: string; readonly ref: string; readonly priority: number };

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const LABELS: Readonly<Record<CampaignPhase, string>> = {
  steady: '日常稳步',
  sprint: '考前冲刺',
  decompress: '考后复盘减压',
};
const DESCRIPTIONS: Readonly<Record<CampaignPhase, string>> = {
  steady: '按当前节奏推进，保留适量新内容与巩固练习。',
  sprint: '聚焦考试范围内的高频母题、急救卡与限时模拟，收紧新增负荷。',
  decompress: '先复盘预料内与意外失分，暂缓高负荷新任务，恢复稳定节奏。',
};
const POLICIES: Readonly<Record<CampaignPhase, CampaignStateView['policy']>> = {
  steady: {
    maxNewLoad: 'normal',
    focusKinds: ['review', 'practice', 'lesson'],
    suppressHeavyNewTasks: false,
    prioritizeCheatsheetAndArchetypes: false,
  },
  sprint: {
    maxNewLoad: 'restricted',
    focusKinds: ['archetype', 'first-aid', 'timed'],
    suppressHeavyNewTasks: false,
    prioritizeCheatsheetAndArchetypes: true,
  },
  decompress: {
    maxNewLoad: 'paused',
    focusKinds: ['recovery', 'review', 'reflection'],
    suppressHeavyNewTasks: true,
    prioritizeCheatsheetAndArchetypes: false,
  },
};

function validDay(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1] ?? '');
  const month = Number(match[2] ?? '');
  const day = Number(match[3] ?? '');
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function localDay(value: string, timeZone: string): string | undefined {
  const trimmed = value.trim();
  if (validDay(trimmed)) return trimmed;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return validDay(day) ? day : undefined;
}

function dayDistance(from: string, to: string): number {
  const fromParts = from.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const toParts = to.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const fromYear = Number(fromParts?.[1] ?? '0');
  const fromMonth = Number(fromParts?.[2] ?? '0');
  const fromDay = Number(fromParts?.[3] ?? '0');
  const toYear = Number(toParts?.[1] ?? '0');
  const toMonth = Number(toParts?.[2] ?? '0');
  const toDay = Number(toParts?.[3] ?? '0');
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000);
}

function phaseOf(value: Campaign | CampaignPhase): CampaignPhase {
  return value === 'recovery' ? 'decompress' : value;
}

function windowDays(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function dedupeExamDates(values: readonly ExamDate[]): ExamDate[] {
  const byDate = new Map<string, ExamDate>();
  for (const value of values) {
    const previous = byDate.get(value.date);
    if (!previous || value.priority > previous.priority || (value.priority === previous.priority && value.ref < previous.ref)) byDate.set(value.date, value);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date) || b.priority - a.priority || a.ref.localeCompare(b.ref));
}

function examDates(input: CampaignStateInput, timeZone: string): ExamDate[] {
  const structured: ExamDate[] = [];
  for (const rule of input.rules ?? []) {
    if (rule.kind === 'exam' && validDay(rule.date)) structured.push({ date: rule.date, ref: `exam:${rule.date}`, priority: 3 });
  }
  for (const deadline of input.deadlines ?? []) {
    const date = localDay(deadline.at, timeZone);
    if (date) structured.push({ date, ref: text(deadline.ref) || `deadline:${date}`, priority: 2 });
  }
  if (structured.length) return dedupeExamDates(structured);
  const goals: ExamDate[] = [];
  for (const goal of input.goals ?? []) {
    if (goal.status !== 'active' || !goal.text) continue;
    const date = goal.text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    if (date && validDay(date)) goals.push({ date, ref: `goal:${goal.id || date}`, priority: 1 });
  }
  return dedupeExamDates(goals);
}

function lastCampaignRule(rules: readonly PlanRule[]): Extract<PlanRule, { kind: 'campaign' }> | undefined {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule?.kind === 'campaign') return rule;
  }
  return undefined;
}

export function resolveCampaignState(input: CampaignStateInput): CampaignStateView {
  const timeZone = input.timeZone ?? 'Asia/Shanghai';
  const today = localDay(input.now, timeZone) ?? input.now.slice(0, 10);
  const dates = examDates(input, timeZone);
  const upcoming = dates.filter((exam) => exam.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  const previous = dates.filter((exam) => exam.date < today).sort((a, b) => b.date.localeCompare(a.date))[0];
  const daysToExam = upcoming ? dayDistance(today, upcoming.date) : null;
  const daysSinceExam = previous ? dayDistance(previous.date, today) : null;

  let phase: CampaignPhase;
  let source: CampaignStateView['source'];
  if (input.manualOverride !== undefined && input.manualOverride !== null) {
    phase = phaseOf(input.manualOverride);
    source = 'manual';
  } else {
    const campaign = lastCampaignRule(input.rules ?? []);
    if (campaign) {
      phase = phaseOf(campaign.campaign);
      source = 'rule';
    } else if (daysToExam !== null && daysToExam <= windowDays(input.sprintWindowDays, 7)) {
      phase = 'sprint';
      source = 'deadline';
    } else if (daysSinceExam !== null && daysSinceExam >= 1 && daysSinceExam <= windowDays(input.decompressWindowDays, 3)) {
      phase = 'decompress';
      source = 'deadline';
    } else {
      phase = 'steady';
      source = 'default';
    }
  }

  const active = phase === 'sprint' ? upcoming : phase === 'decompress' ? previous : upcoming ?? previous;
  return {
    phase,
    source,
    label: LABELS[phase],
    description: DESCRIPTIONS[phase],
    daysToExam,
    daysSinceExam,
    ...(active ? { activeExamRef: active.ref, activeExamDate: active.date } : {}),
    policy: POLICIES[phase],
  };
}

export function filterMicroActivities<T extends MicroActivityCandidate>(
  candidates: readonly T[],
  filter: { readonly bucket: MicroTimeBucket; readonly inputMode: MicroInputMode; readonly campaignPhase?: CampaignPhase },
): {
  readonly admitted: readonly T[];
  readonly filteredOut: readonly { readonly id: string; readonly reason: 'over_duration' | 'requires_writing' | 'paused_by_decompress'; readonly reasonLabel: string }[];
  readonly bucketLabel: string;
  readonly inputModeLabel: string;
} {
  const limit = filter.bucket === '3min' ? 5 : filter.bucket === '15min' ? 15 : Number.POSITIVE_INFINITY;
  const filteredOut: { id: string; reason: 'over_duration' | 'requires_writing' | 'paused_by_decompress'; reasonLabel: string }[] = [];
  const admitted: T[] = [];
  for (const candidate of candidates) {
    const oneHandAllowed = candidate.oneHandFriendly === true || candidate.input === 'tap' || candidate.input === 'voice';
    const reason = filter.inputMode === 'one_hand' && !oneHandAllowed
      ? { reason: 'requires_writing' as const, reasonLabel: '需手写或完整输入' }
      : (!Number.isFinite(candidate.minutes) || candidate.minutes > limit)
        ? { reason: 'over_duration' as const, reasonLabel: '超出当前碎片时长' }
        : filter.campaignPhase === 'decompress' && (candidate.kind === 'exam' || (candidate.kind === 'lesson' && candidate.minutes > 20))
          ? { reason: 'paused_by_decompress' as const, reasonLabel: '考后减压期暂缓高负荷新任务' }
          : undefined;
    if (reason) filteredOut.push({ id: candidate.id, ...reason });
    else admitted.push(candidate);
  }
  if (filter.bucket === '3min') admitted.sort((a, b) => Number(a.minutes > 3) - Number(b.minutes > 3));
  const bucketLabel = filter.bucket === '3min' ? '3 分钟碎片' : filter.bucket === '15min' ? '15 分钟碎片' : '45 分钟以上';
  const inputModeLabel = filter.inputMode === 'one_hand' ? '单手点选/口述' : '不限输入方式';
  return { admitted, filteredOut, bucketLabel, inputModeLabel };
}
