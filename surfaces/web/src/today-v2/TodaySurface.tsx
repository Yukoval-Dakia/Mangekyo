import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, authorIqdbQuestions, describeAuthoringError, issueGraphQuickPaper, onboardingStatus, remember, remembered, requestId, type AuthoringUiError } from '../api';
import { AuthoringFeedback } from '../AuthoringFeedback';
import { Icon } from '../icons';
import { roomPath } from '../classroom-contract';
import { openLink, todayParams, type ActivityRef, type Duration } from '../today-pack';
import { ResearchHandoffPanel } from './ResearchHandoffPanel';
import { ResumeBreadcrumb, type ResumeBreadcrumbSnapshot } from './ResumeBreadcrumb';
import {
  BreathDot,
  Chip,
  Dot,
  filterHumanEvidence,
  handleSpaNavigation,
  humanizeConstraint,
  InlineToggle,
  isTechnicalIdentifier,
  useToggle,
} from './shared';
import './today-v2.css';

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

export type HandoffItem = {
  summary: string;
  detail?: string;
};

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

export type CompanionCitation = {
  title: string;
  text: string;
  topic?: string;
};

// 所有 pack 引用一律拦截：内置示例包已从「今天」移除，杜绝旧计划、旧缓存与 pack/reflection 再次露出。
function isBlockedCandidate(candidate: TodayCandidate): boolean {
  return candidate.open?.kind === 'pack';
}

// 图谱概念候选：id 形如 concept:<ulid>@<rev> 且 open 指向 activity 时，可 1 键抽题直达书桌。
function isConceptCandidate(candidate: TodayCandidate): boolean {
  return candidate.id.startsWith('concept:') && candidate.open?.kind === 'activity';
}

function conceptRecordHref(candidate: TodayCandidate): string {
  return '/materials/records/' + encodeURIComponent(candidate.open!.id);
}

function filterUsableCandidates<T extends { candidate: TodayCandidate }>(items: readonly T[]): T[] {
  return items.filter((item) => !isBlockedCandidate(item.candidate));
}

function freshMaterialChip(candidate: TodayCandidate): string | null {
  const fresh = candidate.freshMaterial;
  if (!fresh) return null;
  const parts = ['刚交入'];
  if (typeof fresh.questionCount === 'number' && fresh.questionCount > 0) parts.push(`含 ${fresh.questionCount} 题`);
  if (typeof fresh.redPenErrorCount === 'number' && fresh.redPenErrorCount > 0) parts.push(`${fresh.redPenErrorCount} 处错题`);
  return parts.join(' · ');
}

function FreshMaterialChip({ candidate }: { candidate: TodayCandidate }) {
  const label = freshMaterialChip(candidate);
  return label === null ? null : <Chip tone="forest">{label}</Chip>;
}

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

type PendingOperation = {
  path: '/today/rules' | '/today/goal';
  payload: object;
  requestId: string;
};

type ScheduledEntry = TodayPlanItem & { isProtected: boolean };

type AiActivitySnapshot = {
  asOf?: string;
  running?: readonly {
    id: string;
    kind: string;
    state: string;
    title: string;
  }[];
  handoffs?: readonly {
    id: string;
    channel: string;
    status: string;
    title: string;
    summary: string;
    basisCount?: number;
    href?: string | null;
  }[];
  pendingProposals?: readonly {
    id: string;
    kind: string;
    status: string;
    title: string;
    summary: string;
    actions?: {
      accept?: { method: 'POST'; path: string; body?: Record<string, unknown> };
      reject?: { method: 'POST'; path: string; body?: Record<string, unknown> };
    };
  }[];
};

const FREE_TIME_OPTIONS: readonly { value: Duration | undefined; label: string }[] = [
  { value: undefined, label: '不限' },
  { value: '3min', label: '3分' },
  { value: '15min', label: '15分' },
  { value: '45min+', label: '45分+' },
];

const ANSWER_MODE_OPTIONS: readonly { value: TodayMode; label: string }[] = [
  { value: 'any', label: '常规' },
  { value: 'one-hand', label: '单手点选' },
  { value: 'voice', label: '语音作答' },
];

function answerModeLabel(mode: TodayMode): string {
  return ANSWER_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? '常规';
}

type ActiveRoom = { id: string; topic: string; activeStepTitle?: string };

function ResumeRoomStrip({
  room,
  onNavigate,
}: {
  room: ActiveRoom;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const href = roomPath(room.id);
  return (
    <a
      className="tv2-resume"
      href={href}
      onClick={(event) => handleSpaNavigation(event, href, onNavigate)}
    >
      <Dot />
      <span className="tv2-resume-copy">
        <strong>继续课堂</strong>
        <span className="tv2-resume-sep" aria-hidden="true">·</span>
        <span>{room.topic.trim() || '未命名课堂'}{room.activeStepTitle ? ` · ${room.activeStepTitle}` : ''}</span>
      </span>
      <span className="tv2-resume-cue" aria-hidden="true">
        <Icon name="chevron" />
      </span>
    </a>
  );
}

const GOAL_LABELS: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '暂停',
  completed: '已完成',
  exited: '已退出',
};

const CAMPAIGN_LABELS: Record<string, string> = {
  sprint: '考前冲刺',
  decompress: '考后复盘减压',
  recovery: '考后复盘减压',
  return: '回来热身',
};

function nextDay(day: string): string {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function formatDayLabel(day: string | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  }
  const date = new Date(day + 'T00:00:00');
  if (!Number.isFinite(date.getTime())) return day;
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

function actionVerb(candidate: TodayCandidate): string {
  if (candidate.state === 'in-progress') return '继续';
  if (candidate.state === 'completed') return '再做一次';
  return '开始';
}

function stateChip(candidate: TodayCandidate, isProtected: boolean) {
  if (!isProtected && !candidate.state) return null;
  if (candidate.state === 'completed') return <Chip tone="neutral">已完成</Chip>;
  if (candidate.state === 'in-progress') return <Chip tone="forest">进行中</Chip>;
  return <Chip tone="forest">已锁定</Chip>;
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || isTechnicalIdentifier(trimmed)) return '';
  return trimmed;
}

export function TodaySurface({
  mode = 'any',
  duration,
  handoff,
  reentry,
  onNavigate,
  onFocusDraft,
  onOpenOnboarding,
  onOpenAiActivity,
  onCiteToCompanion,
  confirmables,
  emptyLibrary,
  noModel,
}: TodaySurfaceProps) {
  const [onboardingNudge, setOnboardingNudge] = useState<'hidden' | 'checking' | 'show'>('checking');
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [plan, setPlan] = useState<TodayPlanV2 | null>(null);
  const [aiActivity, setAiActivity] = useState<AiActivitySnapshot | null>(null);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [swapTargetId, setSwapTargetId] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [dismissedConfirmKeys, setDismissedConfirmKeys] = useState<string[]>([]);
  const [confirmingKey, setConfirmingKey] = useState('');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);
  const [basisOpen, toggleBasis] = useToggle();
  const [goalOpen, toggleGoal] = useToggle();
  const [overviewOpen, toggleOverview] = useToggle();
  const [conflictsOpen, toggleConflicts] = useToggle();
  const [issuingConceptId, setIssuingConceptId] = useState('');
  const [authoringToday, setAuthoringToday] = useState(false);
  const [authoringTodayError, setAuthoringTodayError] = useState<AuthoringUiError | null>(null);
  const busyLockRef = useRef(false);
  const issuingConceptLockRef = useRef(false);
  const authoringTodayLockRef = useRef(false);
  const confirmingKeyLockRef = useRef('');
  const lastVisitRef = useRef(remembered('today-last-open'));
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(() => {
    try {
      const saved = JSON.parse(remembered('today-pending-rule') ?? 'null');
      return saved &&
        ['/today/rules', '/today/goal'].includes(saved.path) &&
        typeof saved.requestId === 'string' &&
        saved.payload
        ? saved
        : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const refreshOnResume = () => {
      if (!document.hidden) setReloadTick((count) => count + 1);
    };
    window.addEventListener('online', refreshOnResume);
    document.addEventListener('visibilitychange', refreshOnResume);
    return () => {
      window.removeEventListener('online', refreshOnResume);
      document.removeEventListener('visibilitychange', refreshOnResume);
    };
  }, []);

  useEffect(() => {
    if (!navigator.onLine) {
      setOnboardingNudge('hidden');
      return;
    }
    if (sessionStorage.getItem('mangekyo:onboarding-dismissed') === '1') {
      setOnboardingNudge('hidden');
      return;
    }
    const controller = new AbortController();
    onboardingStatus()
      .then(value => {
        if (controller.signal.aborted) return;
        setOnboardingCompleted(value.completed === true);
        setOnboardingNudge(value.completed ? 'hidden' : 'show');
      })
      .catch(() => {
        if (!controller.signal.aborted) setOnboardingNudge('hidden');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!navigator.onLine) {
      setAiActivity(null);
      return;
    }
    const controller = new AbortController();
    void api<AiActivitySnapshot>('/ai/activity', { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setAiActivity(value && typeof value === 'object' ? value : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAiActivity(null);
      });
    return () => controller.abort();
  }, [reloadTick]);

  useEffect(() => {
    if (!navigator.onLine) {
      setActiveRoom(null);
      return;
    }
    const controller = new AbortController();
    void api<{ items?: ActiveRoom[] }>('/classrooms?status=active', {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        const room = Array.isArray(value?.items)
          ? value.items.find((item) => item && typeof item.id === 'string' && item.id.length > 0)
          : undefined;
        setActiveRoom(room ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setActiveRoom(null);
      });
    return () => controller.abort();
  }, [reloadTick]);

  useEffect(() => {
    if (!modeMenuOpen) return;
    function dismiss(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.tv2-mode-menu')) {
        setModeMenuOpen(false);
      }
    }
    document.addEventListener('click', dismiss);
    return () => document.removeEventListener('click', dismiss);
  }, [modeMenuOpen]);

  useEffect(() => {
    const controller = new AbortController();
    const params = todayParams(mode, duration);
    params.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    if (lastVisitRef.current) params.set('lastOpenedAt', lastVisitRef.current);
    if (!navigator.onLine) {
      setPlan(null);
      setOffline(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    void api<TodayPlanV2>('/today?' + params, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          !Array.isArray(value?.items) ||
          !Array.isArray(value.protectedItems) ||
          !Array.isArray(value.rules) ||
          !Array.isArray(value.alternatives) ||
          !Number.isFinite(value.totalMinutes)
        ) {
          throw new Error('今日安排回执不完整。');
        }
        setOffline(false);
        setPlan({
          ...value,
          campaign: typeof value.campaign === 'string' ? value.campaign : '',
          conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
          actions: Array.isArray(value.actions) ? value.actions : [],
          schoolMinutes:
            typeof value.schoolMinutes === 'number' && Number.isFinite(value.schoolMinutes)
              ? value.schoolMinutes
              : 0,
          budgetMinutes:
            typeof value.budgetMinutes === 'number' && Number.isFinite(value.budgetMinutes)
              ? value.budgetMinutes
              : 0,
          budgetBasis: typeof value.budgetBasis === 'string' ? value.budgetBasis : '',
        });
        if (typeof value.openedAt === 'string') remember('today-last-open', value.openedAt);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setPlan(null);
        setOffline(failure instanceof TypeError);
        setError(
          failure instanceof ApiError && failure.status !== 404
            ? failure.message
            : '暂时读不到今天的安排。',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode, duration, reloadTick]);

  async function commitOperation(operation: PendingOperation) {
    if (busy || busyLockRef.current) return;
    busyLockRef.current = true;
    setBusy(true);
    setMutationError('');
    setPendingOperation(operation);
    remember('today-pending-rule', JSON.stringify(operation));
    const clearPending = () => {
      setPendingOperation(null);
      remember('today-pending-rule', null);
    };
    try {
      await api(operation.path, { method: 'POST', body: { ...operation.payload, requestId: operation.requestId } });
      clearPending();
      setSwapTargetId('');
      setReloadTick((count) => count + 1);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        clearPending();
        setReloadTick((count) => count + 1);
        setMutationError(failure.message + ' 请核对最新安排。');
      } else {
        setMutationError('结果尚未确认，可用原请求继续核对。');
      }
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  }

  function changeRule(data: PlanRulePayload | null, previous?: StoredRule) {
    void commitOperation({
      path: '/today/rules',
      requestId: requestId(),
      payload: { ...(previous && { id: previous.id }), expectedRev: previous?.rev ?? null, data },
    });
  }

  const titleByActivityId = useMemo(() => {
    const map = new Map<string, string>();
    if (!plan) return map;
    for (const item of plan.protectedItems) map.set(item.id, item.title);
    for (const item of plan.items) map.set(item.candidate.id, item.candidate.title);
    for (const item of plan.alternatives) map.set(item.id, item.title);
    return map;
  }, [plan]);

  const activeHandoff =
    handoff !== undefined
      ? handoff
      : (plan?.handoff ?? null);

  const pendingProposals = Array.isArray(aiActivity?.pendingProposals)
    ? aiActivity!.pendingProposals
    : [];
  const activityHandoffs = Array.isArray(aiActivity?.handoffs) ? aiActivity!.handoffs : [];
  const activityRunning = Array.isArray(aiActivity?.running) ? aiActivity!.running : [];
  const hasPanelContent =
    pendingProposals.some((item) => item && item.status === 'pending') ||
    activityHandoffs.length > 0 ||
    activityRunning.length > 0 ||
    activeHandoff !== null;
  const canRunMaintenance = Boolean(
    onboardingCompleted && plan && !plan.resting && !plan.paused && !offline && navigator.onLine,
  );
  const showResearchPanel = hasPanelContent || (onboardingCompleted && !offline);

  if (loading && !plan) {
    return (
      <section className="tv2" aria-busy="true" aria-label="今天">
        <div className="tv2-loading-shell" role="status">
          <BreathDot />
          <span>正在整理今天的安排…</span>
        </div>
      </section>
    );
  }

  if (!plan) {
    return (
      <section className="tv2" aria-label="今天">
        {showResearchPanel && (
          <ResearchHandoffPanel
            pendingProposals={pendingProposals}
            handoffs={activityHandoffs}
            runningCount={activityRunning.length}
            canRunMaintenance={false}
            onOpenAiActivity={onOpenAiActivity}
            onNavigate={onNavigate}
            onRefresh={() => setReloadTick((count) => count + 1)}
          />
        )}
        <div className="tv2-hero tv2-hero--calm">
          <h2>{offline ? '当前处于离线状态' : '暂时读不到今天的安排'}</h2>
          <p className="tv2-why">
            {offline ? '连网后会自动刷新今天的组合，也可以先交入一份讲义或试卷。' : error}
          </p>
          {!offline && (
            <div className="tv2-hero-actions">
              <button
                type="button"
                className="tv2-btn tv2-btn--primary"
                onClick={() => setReloadTick((count) => count + 1)}
              >
                重新读取
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  const locked = busy || loading || !!pendingOperation;
  const restRule = plan.rules.find((rule) => rule.data.kind === 'rest' && rule.data.date === plan.day);
  const usableProtected = plan.protectedItems.filter((candidate) => !isBlockedCandidate(candidate));
  const usableItems = filterUsableCandidates(plan.items);
  const usableAlternatives = plan.alternatives.filter((candidate) => !isBlockedCandidate(candidate));
  const activeProtected = usableProtected.filter((candidate) => candidate.state !== 'completed');
  const completedProtected = usableProtected.filter((candidate) => candidate.state === 'completed');
  const scheduledCandidates = [...usableProtected, ...usableItems.map((item) => item.candidate)];

  let heroEntry: ScheduledEntry | null = null;
  let backupEntries: ScheduledEntry[] = [];

  if (!plan.resting) {
    if (activeProtected.length > 0) {
      const primaryProtected = activeProtected[0]!;
      heroEntry = { candidate: primaryProtected, why: [], actions: [], isProtected: true };
      backupEntries = [
        ...activeProtected.slice(1).map((candidate) => ({
          candidate,
          why: [],
          actions: [] as RuleAction[],
          isProtected: true,
        })),
        ...usableItems.map((item) => ({ ...item, isProtected: false })),
      ].slice(0, 2);
    } else if (usableItems.length > 0) {
      heroEntry = { ...usableItems[0]!, isProtected: false };
      backupEntries = usableItems.slice(1, 3).map((item) => ({ ...item, isProtected: false }));
    }
  }

  function navigateTo(target: string) {
    if (onNavigate) onNavigate(target);
    else window.location.assign(target);
  }

  async function startConceptPractice(candidate: TodayCandidate) {
    const open = candidate.open;
    if (!open || issuingConceptId || issuingConceptLockRef.current) return;
    issuingConceptLockRef.current = true;
    setIssuingConceptId(open.id);
    try {
      const result = await issueGraphQuickPaper(open.id);
      if (result.kind === 'paper' && result.href) {
        navigateTo(result.href);
        return;
      }
      navigateTo(conceptRecordHref(candidate));
    } catch {
      navigateTo(conceptRecordHref(candidate));
    } finally {
      issuingConceptLockRef.current = false;
      setIssuingConceptId('');
    }
  }

  async function authorTodayPaper() {
    if (authoringToday || authoringTodayLockRef.current) return;
    const concept = scheduledCandidates.find(isConceptCandidate)?.open?.id;
    authoringTodayLockRef.current = true;
    setAuthoringToday(true);
    setAuthoringTodayError(null);
    try {
      const result = await authorIqdbQuestions({
        requestId: requestId(),
        mode: 'concept_gap',
        ...(concept ? { conceptId: concept } : {}),
        count: 2,
        issuePaper: true,
      });
      const href = result.paperHref || (result.paperId ? `/papers/${encodeURIComponent(result.paperId)}` : '');
      if (!href) throw new Error('组卷回执未包含可开练的试卷。');
      navigateTo(href);
    } catch (failure) {
      setAuthoringTodayError(describeAuthoringError(failure));
    } finally {
      authoringTodayLockRef.current = false;
      setAuthoringToday(false);
    }
  }

  const budgetPercent =
    plan.budgetMinutes > 0 ? Math.min(100, Math.round((plan.totalMinutes / plan.budgetMinutes) * 100)) : 0;
  const overBudget = plan.budgetMinutes > 0 && plan.totalMinutes > plan.budgetMinutes;
  const campaignText = CAMPAIGN_LABELS[plan.campaign] ?? '';

  const allConfirmables: { key: string; entry: Confirmable }[] = [];
  const rawConfirmables = [
    ...(confirmables ?? []),
    ...(plan.pendingConfirmations ?? []),
  ];
  rawConfirmables.forEach((entry, index) => {
    if (!entry?.text || isTechnicalIdentifier(entry.text)) return;
    const key = entry.id ?? `confirm-${index}-${entry.text}`;
    if (!dismissedConfirmKeys.includes(key) && !allConfirmables.some((item) => item.key === key)) {
      allConfirmables.push({ key, entry });
    }
  });
  if (
    allConfirmables.length === 0 &&
    plan.returning &&
    plan.overview &&
    plan.overview.unknown.some((item) => Boolean(cleanText(item))) &&
    !dismissedConfirmKeys.includes('auto-unknown-probe')
  ) {
    const cleanUnknown = plan.overview.unknown.map(cleanText).filter(Boolean);
    const topics = cleanUnknown.slice(0, 2).join('、');
    const moreCount = cleanUnknown.length > 2 ? ` 等 ${cleanUnknown.length} 项` : '';
    allConfirmables.push({
      key: 'auto-unknown-probe',
      entry: {
        text: `「${topics}」${moreCount}的表现仍待核对，可以用 3 分钟短摸底先摸清现状。`,
        confirmLabel: '切到 3 分钟摸底',
        dismissLabel: '稍后',
        onConfirm: () => {
          const target = '/today?' + todayParams('one-hand', '3min');
          if (onNavigate) onNavigate(target);
          else window.location.assign(target);
        },
      },
    });
  }

  const visibleConfirmables = allConfirmables.slice(0, 2);
  const extraConfirmCount = Math.max(0, allConfirmables.length - visibleConfirmables.length);

  function ruleHelpersFor(candidate: TodayCandidate) {
    const lockRule = plan!.rules.find(
      (rule) => rule.data.kind === 'lock' && rule.data.date === plan!.day && rule.data.activityId === candidate.id,
    );
    const swapAlternatives = usableAlternatives.filter(
      (alternative) =>
        alternative.id !== candidate.id &&
        alternative.open &&
        !plan!.protectedItems.some((held) => held.id === alternative.id) &&
        !plan!.items.some((item) => item.candidate.id === alternative.id),
    );
    const replacementRule = plan!.rules.find(
      (rule) => rule.data.kind === 'replace' && rule.data.date === plan!.day && rule.data.activityId === candidate.id,
    );
    return { lockRule, swapAlternatives, replacementRule };
  }

  function renderBasisDetails(candidate: TodayCandidate, whyList: readonly string[]) {
    const extraReasons = whyList.filter(
      (line) =>
        typeof line === 'string' &&
        line.trim().length > 0 &&
        line.trim() !== candidate.reason.trim() &&
        !isTechnicalIdentifier(line),
    );
    const { readable, hiddenRecordCount } = filterHumanEvidence(candidate.evidence ?? []);
    const durationText =
      candidate.durationBasis && !isTechnicalIdentifier(candidate.durationBasis) ? candidate.durationBasis : '';
    const hasDetails = Boolean(durationText || extraReasons.length > 0 || readable.length > 0 || hiddenRecordCount > 0);
    if (!hasDetails) return null;

    return (
      <div className="tv2-basis-wrap">
        <InlineToggle open={basisOpen} onToggle={toggleBasis} closed="查看安排依据" opened="收起依据" />
        {basisOpen && (
          <div className="tv2-why-basis" role="region" aria-label="安排依据">
            {durationText && <p>{durationText}</p>}
            {extraReasons.map((reasonLine, index) => (
              <p key={index}>{reasonLine}</p>
            ))}
            {readable.length > 0 && <p>{readable.join(' · ')}</p>}
            {readable.length === 0 && hiddenRecordCount > 0 && (
              <p>依据来自已保存的 {hiddenRecordCount} 份学习记录与当前安排节奏。</p>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderHero() {
    if (plan!.resting) {
      return (
        <article className="tv2-hero tv2-hero--calm" aria-label="今晚休息">
          <div className="tv2-hero-kicker">
            <Chip tone="neutral">休整模式</Chip>
          </div>
          <h2>今晚先休息</h2>
          <p className="tv2-why">今天已标记为休息，不会计入任何欠账；有精神时随时可以把今天的组合找回来。</p>
          {restRule && (
            <div className="tv2-hero-actions">
              <button
                type="button"
                className="tv2-btn tv2-btn--primary"
                disabled={locked}
                onClick={() => changeRule(null, restRule)}
              >
                恢复今天的组合
              </button>
            </div>
          )}
        </article>
      );
    }

    if (!heroEntry) {
      const allDone = completedProtected.length > 0;
      const aiPracticeButton = !allDone ? (
        <button
          type="button"
          className="tv2-btn tv2-btn--tonal"
          disabled={authoringToday}
          onClick={() => void authorTodayPaper()}
        >
          {authoringToday ? '正在生成并组卷…' : 'AI 生成今日概念题并组卷开练'}
        </button>
      ) : null;
      const aiPracticeFeedback = authoringTodayError && !allDone ? (
        <AuthoringFeedback error={authoringTodayError} className="tv2-error tv2-authoring-error" linkClassName="tv2-inline-link" onNavigate={navigateTo} />
      ) : null;
      const coldStart = emptyLibrary === true && scheduledCandidates.length === 0;
      if (coldStart) {
        return (
          <article className="tv2-hero tv2-hero--onboard" aria-label="30 秒配置学习画像">
            <div className="tv2-hero-kicker">
              <Chip tone="forest">30 秒起步</Chip>
            </div>
            <h2 className="m3e-display">告诉 Mangekyō 你在学什么</h2>
            <p className="tv2-why">
              用几句话介绍你的阶段与目标，自动配好考试日程、知识图谱与第一批摸底练习；也可以先随手交入一份试卷或笔记。
            </p>
            <div className="tv2-hero-actions">
              <button
                type="button"
                className="tv2-btn tv2-btn--primary"
                onClick={onOpenOnboarding}
              >
                <span>30 秒配置学习画像与考试日程</span>
                <Icon name="arrow" />
              </button>
              <a
                className="tv2-btn tv2-btn--tonal"
                href="/intake"
                onClick={(event) => handleSpaNavigation(event, '/intake', onNavigate)}
              >
                随手交入一份试卷或笔记
              </a>
              {aiPracticeButton}
            </div>
            {aiPracticeFeedback}
          </article>
        );
      }
      return (
        <article className="tv2-hero tv2-hero--calm" aria-label={allDone ? '今日安排已完成' : '今天暂无待办活动'}>
          <div className="tv2-hero-kicker">
            <Chip tone={allDone ? 'forest' : 'neutral'}>{allDone ? '已完成今日组合' : '空白起步'}</Chip>
          </div>
          <h2>{allDone ? '今天的安排已经完成' : '今天还没有待安排的活动'}</h2>
          <p className="tv2-why">
            {allDone
              ? `今天完成了 ${completedProtected.length} 项学习任务，可以轻松收尾休息，或再挑一份材料练手。`
              : '随手交入一份讲义、错题卷或一句话，今天的学习就会从这里开始。'}
          </p>
          <div className="tv2-hero-actions">
            <a
              className="tv2-btn tv2-btn--primary"
              href="/intake"
              onClick={(event) => handleSpaNavigation(event, '/intake', onNavigate)}
            >
              交入第一份材料
            </a>
            {aiPracticeButton}
          </div>
          {aiPracticeFeedback}
        </article>
      );
    }

    const { candidate, why, actions, isProtected } = heroEntry;
    const { lockRule, swapAlternatives, replacementRule } = ruleHelpersFor(candidate);
    const primaryHref = candidate.open ? openLink(candidate.open, mode, duration) : null;
    const conceptPractice = isConceptCandidate(candidate);
    const conceptHref = conceptPractice ? conceptRecordHref(candidate) : null;
    const conceptIssuing = conceptPractice && issuingConceptId === candidate.open!.id;
    const leadWhy =
      candidate.reason || why.find((line) => line.trim().length > 0 && !isTechnicalIdentifier(line)) || '';
    const showTopic = candidate.topic && candidate.topic.trim() !== candidate.title.trim();
    const canCite = Boolean(onCiteToCompanion);

    return (
      <article className="tv2-hero" aria-label="今日主推荐">
        <div className="tv2-hero-kicker">
          <Chip tone="forest">{kindLabel[candidate.kind] ?? '今日推荐'}</Chip>
          <Chip>约 {candidate.minutes} 分钟</Chip>
          {showTopic && <Chip tone="neutral">{candidate.topic}</Chip>}
          {stateChip(candidate, isProtected)}
        </div>

        <h2>{candidate.title}</h2>
        {freshMaterialChip(candidate) !== null && (
          <p className="tv2-fresh-material"><FreshMaterialChip candidate={candidate} /></p>
        )}

        {leadWhy && <p className="tv2-why">{leadWhy}</p>}

        {renderBasisDetails(candidate, why)}

        {candidate.delayImpact && !isTechnicalIdentifier(candidate.delayImpact) && (
          <p className="tv2-impact">
            <span>推迟影响：</span>
            {candidate.delayImpact}
          </p>
        )}

        <div className="tv2-hero-actions">
          {conceptPractice ? (
            <div className="m3e-split-btn">
              <button
                type="button"
                className="tv2-btn tv2-btn--primary"
                disabled={issuingConceptId !== ''}
                onClick={() => void startConceptPractice(candidate)}
              >
                <span>{conceptIssuing ? '正在组题…' : actionVerb(candidate)}</span>
                <Icon name="arrow" />
              </button>
              {canCite && (
                <button
                  type="button"
                  className="tv2-btn tv2-btn--primary tv2-btn--sm"
                  title="带到同伴讨论"
                  onClick={() =>
                    onCiteToCompanion?.({
                      title: candidate.title,
                      text: leadWhy || candidate.title,
                      ...(showTopic ? { topic: candidate.topic } : {}),
                    })
                  }
                >
                  <Icon name="chat" />
                </button>
              )}
            </div>
          ) : primaryHref ? (
            <div className="m3e-split-btn">
              <a
                className="tv2-btn tv2-btn--primary"
                href={primaryHref}
                onClick={(event) => handleSpaNavigation(event, primaryHref, onNavigate)}
              >
                <span>{actionVerb(candidate)}</span>
                <Icon name="arrow" />
              </a>
              {canCite && (
                <button
                  type="button"
                  className="tv2-btn tv2-btn--primary tv2-btn--sm"
                  title="带到同伴讨论"
                  onClick={() =>
                    onCiteToCompanion?.({
                      title: candidate.title,
                      text: leadWhy || candidate.title,
                      ...(showTopic ? { topic: candidate.topic } : {}),
                    })
                  }
                >
                  <Icon name="chat" />
                </button>
              )}
            </div>
          ) : (
            <Chip tone="neutral">材料准备中</Chip>
          )}
          {conceptHref && (
            <a
              className="tv2-btn tv2-btn--tonal tv2-btn--sm"
              href={conceptHref}
              onClick={(event) => handleSpaNavigation(event, conceptHref, onNavigate)}
            >
              看概念脉络
            </a>
          )}
          <div className="m3e-btn-group" role="group" aria-label="今日主推荐次操作">
            {lockRule ? (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                disabled={locked}
                onClick={() => changeRule(null, lockRule)}
              >
                解除锁定
              </button>
            ) : (
              actions.includes('lock') && (
                <button
                  type="button"
                  className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                  disabled={locked}
                  onClick={() => changeRule({ kind: 'lock', date: plan!.day, activityId: candidate.id })}
                >
                  锁定
                </button>
              )
            )}
            {!isProtected && actions.includes('replace') && (
              <button
                type="button"
                className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                disabled={locked}
                aria-expanded={swapTargetId === candidate.id}
                onClick={() => setSwapTargetId(swapTargetId === candidate.id ? '' : candidate.id)}
              >
                换一项
              </button>
            )}
            {!isProtected && actions.includes('defer') && (
              <button
                type="button"
                className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                disabled={locked}
                onClick={() =>
                  changeRule({ kind: 'defer', activityId: candidate.id, until: nextDay(plan!.day) })
                }
              >
                推迟
              </button>
            )}
          </div>
        </div>

        {swapTargetId === candidate.id && (
          <div className="tv2-swap" role="group" aria-label="可替换的备选活动">
            {swapAlternatives.length > 0 ? (
              swapAlternatives.map((alternative) => (
                <button
                  key={alternative.id}
                  type="button"
                  className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                  disabled={locked}
                  onClick={() =>
                    changeRule(
                      {
                        kind: 'replace',
                        date: plan!.day,
                        activityId: candidate.id,
                        replacementId: alternative.id,
                      },
                      replacementRule ?? undefined,
                    )
                  }
                >
                  {alternative.title} · {alternative.minutes} 分钟
                </button>
              ))
            ) : (
              <p className="tv2-muted">目前没有其他可替换的活动。</p>
            )}
          </div>
        )}
      </article>
    );
  }

  function renderQueueCard(entry: ScheduledEntry) {
    const { candidate, actions, isProtected } = entry;
    const { lockRule, swapAlternatives, replacementRule } = ruleHelpersFor(candidate);
    const openHref = candidate.open ? openLink(candidate.open, mode, duration) : null;
    const conceptPractice = isConceptCandidate(candidate);
    const conceptHref = conceptPractice ? conceptRecordHref(candidate) : null;
    const conceptIssuing = conceptPractice && issuingConceptId === candidate.open!.id;
    const showTopic = candidate.topic && candidate.topic.trim() !== candidate.title.trim();
    const metaSegments = [
      kindLabel[candidate.kind] ?? '活动',
      showTopic ? candidate.topic : undefined,
      `约 ${candidate.minutes} 分钟`,
      isProtected
        ? candidate.state === 'completed'
          ? '已完成'
          : candidate.state === 'in-progress'
            ? '进行中'
            : '已锁定'
        : undefined,
    ].filter(Boolean);

    return (
      <li className="tv2-queue-item m3e-seg-item" key={candidate.id}>
        <div className="tv2-queue-card">
          <div className="tv2-queue-copy">
            <strong>{candidate.title}</strong>
            <FreshMaterialChip candidate={candidate} />
            <small className="tv2-queue-meta">{metaSegments.join(' · ')}</small>
            {candidate.reason && !isTechnicalIdentifier(candidate.reason) && (
              <small className="tv2-queue-reason">{candidate.reason}</small>
            )}
          </div>
          <div className="tv2-queue-actions">
            {conceptPractice ? (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                disabled={issuingConceptId !== ''}
                onClick={() => void startConceptPractice(candidate)}
              >
                {conceptIssuing ? '正在组题…' : actionVerb(candidate)}
              </button>
            ) : openHref && (
              <a
                className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                href={openHref}
                onClick={(event) => handleSpaNavigation(event, openHref, onNavigate)}
              >
                {actionVerb(candidate)}
              </a>
            )}
            {conceptHref && (
              <a
                className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                href={conceptHref}
                onClick={(event) => handleSpaNavigation(event, conceptHref, onNavigate)}
              >
                看概念脉络
              </a>
            )}
            {lockRule ? (
              <button
                type="button"
                className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                disabled={locked}
                onClick={() => changeRule(null, lockRule)}
              >
                解除锁定
              </button>
            ) : !isProtected && actions.includes('replace') ? (
              <button
                type="button"
                className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                disabled={locked}
                aria-expanded={swapTargetId === candidate.id}
                onClick={() => setSwapTargetId(swapTargetId === candidate.id ? '' : candidate.id)}
              >
                换一项
              </button>
            ) : null}
          </div>
        </div>
        {swapTargetId === candidate.id && (
          <div className="tv2-swap" role="group" aria-label="可替换的备选活动">
            {swapAlternatives.length > 0 ? (
              swapAlternatives.map((alternative) => (
                <button
                  key={alternative.id}
                  type="button"
                  className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                  disabled={locked}
                  onClick={() =>
                    changeRule(
                      {
                        kind: 'replace',
                        date: plan!.day,
                        activityId: candidate.id,
                        replacementId: alternative.id,
                      },
                      replacementRule ?? undefined,
                    )
                  }
                >
                  {alternative.title} · {alternative.minutes} 分钟
                </button>
              ))
            ) : (
              <p className="tv2-muted">目前没有其他可替换的活动。</p>
            )}
          </div>
        )}
      </li>
    );
  }

  const undoableRules = plan.rules.filter(
    (rule) =>
      (rule.data.kind === 'defer' && Boolean(rule.data.until) && rule.data.until! > plan.day) ||
      (rule.data.kind === 'replace' && rule.data.date === plan.day),
  );

  return (
    <section className="tv2" aria-busy={loading} aria-label="今天">
      {showResearchPanel && (
        <ResearchHandoffPanel
          pendingProposals={pendingProposals}
          handoffs={activityHandoffs}
          runningCount={activityRunning.length}
          canRunMaintenance={canRunMaintenance}
          onOpenAiActivity={onOpenAiActivity}
          onNavigate={onNavigate}
          onRefresh={() => setReloadTick((count) => count + 1)}
        />
      )}

      {onboardingNudge === 'show' && (
        <div className="tv2-onboard" role="status">
          <span className="tv2-onboard-copy">
            <strong>30 秒告诉 Mangekyō 你在学什么</strong>
            <span className="tv2-onboard-sep" aria-hidden="true">·</span>
            <span>自动配好考试日程、知识图谱与摸底题库</span>
          </span>
          <span className="tv2-onboard-actions">
            <button type="button" className="tv2-btn tv2-btn--primary tv2-btn--sm" onClick={onOpenOnboarding}>
              开始配置
            </button>
            <button
              type="button"
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              onClick={() => {
                try { sessionStorage.setItem('mangekyo:onboarding-dismissed', '1'); } catch {}
                setOnboardingNudge('hidden');
              }}
            >
              先自己逛逛
            </button>
          </span>
        </div>
      )}

      <header className="tv2-bar">
        <div className="tv2-bar-title">
          <h1>今天</h1>
          <span className="tv2-muted">
            {formatDayLabel(plan.day)}
            {campaignText && ` · ${campaignText}`}
            {mode === 'one-hand' && ' · 单手模式'}
            {mode === 'voice' && ' · 语音模式'}
          </span>
        </div>
        {activeRoom && !plan.paused && (
          <div className="tv2-bar-actions">
            <span className="tv2-muted" role="status">有进行中的课堂</span>
          </div>
        )}
      </header>

      {activeRoom && !plan.paused && <ResumeRoomStrip room={activeRoom} onNavigate={onNavigate} />}

      <div className="tv2-filterline">
        <span className="tv2-filterline-label">现在有空：</span>
        <nav className="tv2-seg tv2-seg--compact" aria-label="可用时间">
          {FREE_TIME_OPTIONS.map((option) => {
            const href = '/today?' + todayParams(mode, option.value);
            const active = duration === option.value;
            return (
              <a
                key={option.value ?? 'any'}
                href={href}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => handleSpaNavigation(event, href, onNavigate)}
              >
                {option.label}
              </a>
            );
          })}
        </nav>
        <div className="tv2-mode-menu">
          <button
            type="button"
            className="tv2-btn tv2-btn--ghost tv2-btn--sm"
            aria-haspopup="listbox"
            aria-expanded={modeMenuOpen}
            onClick={() => setModeMenuOpen((current) => !current)}
          >
            作答方式：{answerModeLabel(mode)} ▾
          </button>
          {modeMenuOpen && (
            <div className="tv2-mode-menu-pop" role="listbox" aria-label="作答方式">
              {ANSWER_MODE_OPTIONS.map((option) => {
                const href = '/today?' + todayParams(option.value, duration);
                return (
                  <a
                    key={option.value}
                    role="option"
                    aria-selected={mode === option.value}
                    href={href}
                    onClick={(event) => {
                      setModeMenuOpen(false);
                      handleSpaNavigation(event, href, onNavigate);
                    }}
                  >
                    {option.label}
                  </a>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {mutationError && (
        <p className="tv2-error" role="alert">
          {mutationError}
        </p>
      )}
      {pendingOperation && !offline && (
        <div className="tv2-confirm" role="status">
          <Dot tone="amber" />
          <span>上一次安排调整尚未确认，可以用原请求继续核对。</span>
          <button
            type="button"
            className="tv2-btn tv2-btn--tonal tv2-btn--sm"
            disabled={busy}
            onClick={() => void commitOperation(pendingOperation)}
          >
            核对安排
          </button>
        </div>
      )}

      {visibleConfirmables.map(({ key, entry }) => (
        <div className="tv2-confirm" key={key} role="status">
          <Dot tone="amber" />
          <span className="tv2-confirm-copy">{entry.text}</span>
          <div className="tv2-confirm-actions">
            {entry.onConfirm && (
              <button
                type="button"
                className="tv2-btn tv2-btn--primary tv2-btn--sm"
                disabled={confirmingKey === key}
                onClick={() => {
                  if (confirmingKeyLockRef.current) return;
                  confirmingKeyLockRef.current = key;
                  setConfirmingKey(key);
                  setMutationError('');
                  Promise.resolve(entry.onConfirm?.())
                    .then(() => {
                      setDismissedConfirmKeys((previous) =>
                        previous.includes(key) ? previous : [...previous, key],
                      );
                    })
                    .catch((failure) => {
                      setMutationError(
                        failure instanceof ApiError && failure.message
                          ? failure.message
                          : '这项确认暂时未能完成，请重试。',
                      );
                    })
                    .finally(() => {
                      confirmingKeyLockRef.current = '';
                      setConfirmingKey('');
                    });
                }}
              >
                {entry.confirmLabel ?? '确认'}
              </button>
            )}
            <button
              type="button"
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              disabled={confirmingKey === key}
              onClick={() => {
                setDismissedConfirmKeys((previous) =>
                  previous.includes(key) ? previous : [...previous, key],
                );
                entry.onDismiss?.();
              }}
            >
              {entry.dismissLabel ?? '稍后'}
            </button>
          </div>
        </div>
      ))}
      {extraConfirmCount > 0 && onOpenAiActivity && (
        <div className="tv2-confirm tv2-confirm--more" role="status">
          <Dot tone="amber" />
          <span className="tv2-confirm-copy">还有 {extraConfirmCount} 项教研提议等待你的确认。</span>
          <button
            type="button"
            className="tv2-btn tv2-btn--ghost tv2-btn--sm"
            onClick={onOpenAiActivity}
          >
            查看全部
          </button>
        </div>
      )}

      {!plan.paused && !plan.resting && (
        <ResumeBreadcrumb
          reentry={reentry !== undefined ? reentry : (plan.reentry ?? undefined)}
          activeRoom={activeRoom}
          candidateTitles={titleByActivityId}
          onNavigate={onNavigate}
          onFocusDraft={onFocusDraft}
        />
      )}

      {renderHero()}

      {backupEntries.length > 0 && (
        <section className="tv2-section" aria-label="备选队列">
          <div className="tv2-section-head">
            <h3>接下来 · 备选</h3>
            <span className="tv2-muted">{backupEntries.length} 项</span>
          </div>
          <ul className="m3e-seg-list">{backupEntries.map((entry) => renderQueueCard(entry))}</ul>
        </section>
      )}

      {completedProtected.length > 0 && (
        <section className="tv2-section" aria-label="今日已完成">
          <div className="tv2-section-head">
            <h3>今日已完成</h3>
            <span className="tv2-muted">{completedProtected.length} 项</span>
          </div>
          <ul className="m3e-seg-list">
            {completedProtected.map((candidate) =>
              renderQueueCard({ candidate, why: [], actions: [], isProtected: true }),
            )}
          </ul>
        </section>
      )}

      <section className="tv2-budget-card" aria-label="今日时间预算与出口">
        <div className="tv2-budget">
          <div className="tv2-budget-line">
            <span>
              今日约 <strong>{plan.totalMinutes} 分钟</strong>
              {plan.budgetMinutes > 0 && ` / 预算 ${plan.budgetMinutes} 分钟`}
            </span>
            <span className="tv2-muted">
              {scheduledCandidates.length} 项
              {plan.schoolMinutes > 0 && ` · 学校作业 ${plan.schoolMinutes} 分钟`}
              {plan.budgetBasis && !isTechnicalIdentifier(plan.budgetBasis) && ` · ${plan.budgetBasis}`}
            </span>
          </div>
          {plan.budgetMinutes > 0 && (
            <div
              className="tv2-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={plan.budgetMinutes}
              aria-valuenow={Math.min(plan.totalMinutes, plan.budgetMinutes)}
              aria-label={`今日时间预算 ${plan.totalMinutes}/${plan.budgetMinutes} 分钟`}
            >
              <span
                className={overBudget ? 'tv2-track-fill tv2-track-fill--over' : 'tv2-track-fill'}
                style={{ width: budgetPercent + '%' }}
              />
            </div>
          )}
        </div>

        <div className="tv2-exits" role="group" aria-label="快速切换与休息">
          {plan.resting ? (
            restRule && (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal"
                disabled={locked}
                onClick={() => changeRule(null, restRule)}
              >
                恢复今天的组合
              </button>
            )
          ) : (
            plan.actions.includes('rest') && (
              <button
                type="button"
                className="tv2-btn tv2-btn--tonal"
                disabled={locked}
                onClick={() => changeRule({ kind: 'rest', date: plan.day })}
              >
                今晚休息
              </button>
            )
          )}
        </div>
        {undoableRules.length > 0 && (
          <div className="tv2-rule-undos" role="group" aria-label="撤销今天的调整">
            {undoableRules.map((rule) => {
              const targetTitle = rule.data.activityId
                ? titleByActivityId.get(rule.data.activityId)
                : undefined;
              const verb = rule.data.kind === 'defer' ? '撤回推迟' : '撤回换选';
              const label = targetTitle ? `${verb} · ${targetTitle}` : `${verb} · 原安排项`;
              return (
                <button
                  key={rule.id}
                  type="button"
                  className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                  disabled={locked}
                  onClick={() => changeRule(null, rule)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {(plan.conflicts.length > 0 || plan.goal || (plan.returning && plan.overview)) && (
        <div className="tv2-aux">
          {plan.conflicts.length > 0 && (
            <div className="tv2-aux-item">
              <InlineToggle
                open={conflictsOpen}
                onToggle={toggleConflicts}
                closed={`${plan.conflicts.length} 处安排冲突`}
                opened="收起冲突说明"
              />
              {conflictsOpen && (
                <div className="tv2-why-basis">
                  {plan.conflicts.map((conflict, index) => {
                    const readableConstraints = conflict.constraints
                      .map((entry) => humanizeConstraint(entry, titleByActivityId))
                      .filter((value): value is string => Boolean(value));
                    const readableOptions = conflict.options.filter(
                      (option) => !isTechnicalIdentifier(option),
                    );
                    return (
                      <p className="tv2-muted" role="status" key={index}>
                        {readableConstraints.join(' · ')}
                        {readableOptions.length > 0 ? `。可选：${readableOptions.join(' / ')}` : ''}
                      </p>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {plan.goal && (
            <div className="tv2-aux-item">
              <InlineToggle
                open={goalOpen}
                onToggle={toggleGoal}
                closed={`当前目标 · ${GOAL_LABELS[plan.goal.status]}`}
                opened="收起目标"
              />
              {goalOpen && (
                <div className="tv2-why-basis">
                  {plan.goal.text && <p className="tv2-muted">{plan.goal.text}</p>}
                  <div className="tv2-swap">
                    {(Object.keys(GOAL_LABELS) as GoalStatus[])
                      .filter((status) => status !== plan.goal!.status)
                      .map((status) => (
                        <button
                          key={status}
                          type="button"
                          className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                          disabled={locked}
                          onClick={() =>
                            void commitOperation({
                              path: '/today/goal',
                              requestId: requestId(),
                              payload: { id: plan.goal!.id, expectedRev: plan.goal!.rev, status },
                            })
                          }
                        >
                          标记为{GOAL_LABELS[status]}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {plan.returning && plan.overview && (
            <div className="tv2-aux-item">
              <InlineToggle
                open={overviewOpen}
                onToggle={toggleOverview}
                closed="回来后的掌握概况"
                opened="收起概况"
              />
              {overviewOpen && (
                <div className="tv2-why-basis">
                  <p className="tv2-muted">
                    保留较稳：{plan.overview.retained.map(cleanText).filter(Boolean).join('、') || '暂无'}
                  </p>
                  <p className="tv2-muted">
                    有所减弱：{plan.overview.faded.map(cleanText).filter(Boolean).join('、') || '暂无'}
                  </p>
                  <p className="tv2-muted">
                    尚待核对：{plan.overview.unknown.map(cleanText).filter(Boolean).join('、') || '暂无'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default TodaySurface;
