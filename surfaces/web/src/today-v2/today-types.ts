import type { ActivityRef, Duration } from '../today-pack';
import type { ResumeBreadcrumbSnapshot } from './ResumeBreadcrumb';

export type TodayMode = 'any' | 'one-hand' | 'voice';

export const kindLabel = {
  review: '复习',
  probe: '摸底',
  counterexample: '反例练习',
  exam: '考试练习',
  recovery: '恢复练习',
  lesson: '讲义',
} as const;
export type CandidateKind = keyof typeof kindLabel;

export type TodayCandidate = {
  kind: CandidateKind;
  id: string;
  title: string;
  minutes: number;
  topic: string;
  open: ActivityRef | null;
  durationBasis: string;
  reason: string;
  evidence: string[];
  delayImpact: string;
  freshMaterial?: { savedAt: string; questionCount?: number; redPenErrorCount?: number };
  state?: 'in-progress' | 'completed';
};

export type RuleAction = 'defer' | 'replace' | 'rest' | 'lock';
export type PlanRulePayload = {
  kind: string;
  date?: string;
  activityId?: string;
  replacementId?: string;
  until?: string;
};
export type StoredRule = { id: string; rev: number; data: PlanRulePayload };
export type GoalStatus = 'active' | 'paused' | 'completed' | 'exited';

export type HandoffItem = { summary: string; detail?: string };

export type NightHandoff = {
  items?: readonly HandoffItem[];
  summary?: string;
  count?: number;
  updatedAt?: string;
  active?: boolean;
};

export type Confirmable = {
  id?: string;
  text: string;
  confirmLabel?: string;
  dismissLabel?: string;
  onConfirm?: () => void | Promise<void>;
  onDismiss?: () => void;
};

export type TodayPlanItem = {
  candidate: TodayCandidate;
  why: string[];
  actions: RuleAction[];
};

export type TodayPlanV2 = {
  day: string;
  openedAt: string;
  returning: boolean;
  overview: { retained: string[]; faded: string[]; unknown: string[] } | null;
  campaign: string;
  goal: { id: string; rev: number; text: string | null; status: GoalStatus } | null;
  protectedItems: TodayCandidate[];
  items: TodayPlanItem[];
  rules: StoredRule[];
  alternatives: TodayCandidate[];
  conflicts: { constraints: string[]; options: string[] }[];
  resting: boolean;
  paused?: boolean;
  totalMinutes: number;
  budgetMinutes: number;
  budgetBasis: string;
  schoolMinutes: number;
  actions: RuleAction[];
  handoff?: NightHandoff | null;
  pendingConfirmations?: readonly Confirmable[];
  reentry?: ResumeBreadcrumbSnapshot | null;
};

export type CompanionCitation = { title: string; text: string; topic?: string };

export type TodaySurfaceProps = {
  mode?: TodayMode;
  duration?: Duration;
  handoff?: NightHandoff | null;
  reentry?: ResumeBreadcrumbSnapshot | null;
  onNavigate?: (href: string) => void;
  onFocusDraft?: (snapshot: ResumeBreadcrumbSnapshot) => void;
  onOpenOnboarding?: () => void;
  onOpenAiActivity?: () => void;
  onCiteToCompanion?: (citation: CompanionCitation) => void;
  confirmables?: readonly Confirmable[];
  emptyLibrary?: boolean;
  noModel?: boolean;
};

export type PendingOperation = {
  path: '/today/rules' | '/today/goal';
  payload: object;
  requestId: string;
};

export type ScheduledEntry = TodayPlanItem & { isProtected: boolean };
export type ActiveRoom = { id: string; topic: string; activeStepTitle?: string };

export const FREE_TIME_OPTIONS: readonly { value: Duration | undefined; label: string }[] = [
  { value: undefined, label: '不限' },
  { value: '3min', label: '3分' },
  { value: '15min', label: '15分' },
  { value: '45min+', label: '45分+' },
];

export const ANSWER_MODE_OPTIONS: readonly { value: TodayMode; label: string }[] = [
  { value: 'any', label: '常规' },
  { value: 'one-hand', label: '单手点选' },
  { value: 'voice', label: '语音作答' },
];

export const GOAL_LABELS: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '暂停',
  completed: '已完成',
  exited: '已退出',
};

export const CAMPAIGN_LABELS: Record<string, string> = {
  sprint: '考前冲刺',
  decompress: '考后复盘减压',
  recovery: '考后复盘减压',
  return: '回来热身',
};

export function answerModeLabel(mode: TodayMode): string {
  return ANSWER_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? '常规';
}

// 所有 pack 引用一律拦截：内置示例包已从「今天」移除，杜绝旧计划、旧缓存与 pack/reflection 再次露出。
export function isBlockedCandidate(candidate: TodayCandidate): boolean {
  return candidate.open?.kind === 'pack';
}

// 图谱概念候选：id 形如 concept:<ulid>@<rev> 且 open 指向 activity 时，可 1 键抽题直达书桌。
export function isConceptCandidate(candidate: TodayCandidate): boolean {
  return candidate.id.startsWith('concept:') && candidate.open?.kind === 'activity';
}

export function conceptRecordHref(candidate: TodayCandidate): string {
  return '/materials/records/' + encodeURIComponent(candidate.open!.id);
}

export function freshMaterialChip(candidate: TodayCandidate): string | null {
  const fresh = candidate.freshMaterial;
  if (!fresh) return null;
  const parts = ['刚交入'];
  if (typeof fresh.questionCount === 'number' && fresh.questionCount > 0) parts.push(`含 ${fresh.questionCount} 题`);
  if (typeof fresh.redPenErrorCount === 'number' && fresh.redPenErrorCount > 0) parts.push(`${fresh.redPenErrorCount} 处错题`);
  return parts.join(' · ');
}

export function formatDayLabel(day: string | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  }
  const date = new Date(day + 'T00:00:00');
  if (!Number.isFinite(date.getTime())) return day;
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

export function actionVerb(candidate: TodayCandidate): string {
  if (candidate.state === 'in-progress') return '继续';
  if (candidate.state === 'completed') return '再做一次';
  return '开始';
}

export function ruleHelpersFor(
  plan: TodayPlanV2,
  usableAlternatives: readonly TodayCandidate[],
  candidate: TodayCandidate,
) {
  const lockRule = plan.rules.find(
    (rule) => rule.data.kind === 'lock' && rule.data.date === plan.day && rule.data.activityId === candidate.id,
  );
  const swapAlternatives = usableAlternatives.filter(
    (alternative) =>
      alternative.id !== candidate.id &&
      alternative.open &&
      !plan.protectedItems.some((held) => held.id === alternative.id) &&
      !plan.items.some((item) => item.candidate.id === alternative.id),
  );
  const replacementRule = plan.rules.find(
    (rule) => rule.data.kind === 'replace' && rule.data.date === plan.day && rule.data.activityId === candidate.id,
  );
  return { lockRule, swapAlternatives, replacementRule };
}
