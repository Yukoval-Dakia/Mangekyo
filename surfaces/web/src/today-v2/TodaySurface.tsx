import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  authorIqdbQuestions,
  describeAuthoringError,
  issueGraphQuickPaper,
  onboardingStatus,
  remember,
  remembered,
  requestId,
  type AuthoringUiError,
} from '../api';
import { navigateHref } from '../shared/safe-navigation';
import { isRecord, readNumber, safeParseJson } from '../shared/safe-values';
import { todayParams } from '../today-pack';
import { ResearchHandoffPanel, type PanelHandoff, type PanelProposal } from './ResearchHandoffPanel';
import { ResumeBreadcrumb } from './ResumeBreadcrumb';
import { BreathDot, Dot, cleanHumanText, handleSpaNavigation, isTechnicalIdentifier, useToggle } from './shared';
import {
  ResumeRoomStrip,
  TodayAuxPanels,
  TodayBudgetCard,
  TodayHeroCard,
  TodayQueueCard,
} from './TodayCards';
import {
  ANSWER_MODE_OPTIONS,
  CAMPAIGN_LABELS,
  FREE_TIME_OPTIONS,
  answerModeLabel,
  conceptRecordHref,
  formatDayLabel,
  isBlockedCandidate,
  isConceptCandidate,
  kindLabel,
  type ActiveRoom,
  type CandidateKind,
  type CompanionCitation,
  type Confirmable,
  type GoalStatus,
  type HandoffItem,
  type NightHandoff,
  type PendingOperation,
  type PlanRulePayload,
  type RuleAction,
  type ScheduledEntry,
  type StoredRule,
  type TodayCandidate,
  type TodayMode,
  type TodayPlanItem,
  type TodayPlanV2,
  type TodaySurfaceProps,
} from './today-types';
import './today-v2.css';

export {
  kindLabel,
  type CandidateKind,
  type CompanionCitation,
  type Confirmable,
  type GoalStatus,
  type HandoffItem,
  type NightHandoff,
  type PlanRulePayload,
  type RuleAction,
  type StoredRule,
  type TodayCandidate,
  type TodayMode,
  type TodayPlanItem,
  type TodayPlanV2,
  type TodaySurfaceProps,
};

type AiActivitySnapshot = {
  asOf?: string;
  running?: readonly { id: string; kind: string; state: string; title: string }[];
  handoffs?: readonly PanelHandoff[];
  pendingProposals?: readonly PanelProposal[];
};

function readPendingOperation(): PendingOperation | null {
  const saved = safeParseJson<unknown>(remembered('today-pending-rule'));
  if (
    isRecord(saved) &&
    (saved.path === '/today/rules' || saved.path === '/today/goal') &&
    typeof saved.requestId === 'string' &&
    isRecord(saved.payload)
  ) {
    return saved as PendingOperation;
  }
  return null;
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
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(readPendingOperation);

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
    if (!navigator.onLine || sessionStorage.getItem('mangekyo:onboarding-dismissed') === '1') {
      setOnboardingNudge('hidden');
      return;
    }
    const controller = new AbortController();
    onboardingStatus()
      .then((value) => {
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
      setActiveRoom(null);
      return;
    }
    const controller = new AbortController();
    void api<AiActivitySnapshot>('/ai/activity', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setAiActivity(isRecord(value) ? value : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAiActivity(null);
      });
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
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.tv2-mode-menu')) {
        setModeMenuOpen(false);
      }
    };
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
          schoolMinutes: readNumber(value.schoolMinutes) ?? 0,
          budgetMinutes: readNumber(value.budgetMinutes) ?? 0,
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

  const activeHandoff = handoff !== undefined ? handoff : (plan?.handoff ?? null);
  const pendingProposals = Array.isArray(aiActivity?.pendingProposals) ? aiActivity.pendingProposals : [];
  const activityHandoffs = Array.isArray(aiActivity?.handoffs) ? aiActivity.handoffs : [];
  const activityRunning = Array.isArray(aiActivity?.running) ? aiActivity.running : [];
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
  const usableItems = plan.items.filter((item) => !isBlockedCandidate(item.candidate));
  const usableAlternatives = plan.alternatives.filter((candidate) => !isBlockedCandidate(candidate));
  const activeProtected = usableProtected.filter((candidate) => candidate.state !== 'completed');
  const completedProtected = usableProtected.filter((candidate) => candidate.state === 'completed');
  const scheduledCandidates = [...usableProtected, ...usableItems.map((item) => item.candidate)];

  let heroEntry: ScheduledEntry | null = null;
  let backupEntries: ScheduledEntry[] = [];
  if (!plan.resting) {
    if (activeProtected.length > 0) {
      heroEntry = { candidate: activeProtected[0]!, why: [], actions: [], isProtected: true };
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

  const navigateTo = (target: string) => navigateHref(target, onNavigate);

  async function startConceptPractice(candidate: TodayCandidate) {
    const open = candidate.open;
    if (!open || issuingConceptId || issuingConceptLockRef.current) return;
    issuingConceptLockRef.current = true;
    setIssuingConceptId(open.id);
    try {
      const result = await issueGraphQuickPaper(open.id);
      navigateTo(result.kind === 'paper' && result.href ? result.href : conceptRecordHref(candidate));
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

  const campaignText = CAMPAIGN_LABELS[plan.campaign] ?? '';
  const allConfirmables: { key: string; entry: Confirmable }[] = [];
  for (const [index, entry] of [...(confirmables ?? []), ...(plan.pendingConfirmations ?? [])].entries()) {
    if (!entry?.text || isTechnicalIdentifier(entry.text)) continue;
    const key = entry.id ?? `confirm-${index}-${entry.text}`;
    if (!dismissedConfirmKeys.includes(key) && !allConfirmables.some((item) => item.key === key)) {
      allConfirmables.push({ key, entry });
    }
  }
  if (
    allConfirmables.length === 0 &&
    plan.returning &&
    plan.overview &&
    !dismissedConfirmKeys.includes('auto-unknown-probe')
  ) {
    const cleanUnknown = plan.overview.unknown.map(cleanHumanText).filter((v): v is string => Boolean(v));
    if (cleanUnknown.length > 0) {
      const moreCount = cleanUnknown.length > 2 ? ` 等 ${cleanUnknown.length} 项` : '';
      allConfirmables.push({
        key: 'auto-unknown-probe',
        entry: {
          text: `「${cleanUnknown.slice(0, 2).join('、')}」${moreCount}的表现仍待核对，可以用 3 分钟短摸底先摸清现状。`,
          confirmLabel: '切到 3 分钟摸底',
          dismissLabel: '稍后',
          onConfirm: () => navigateTo('/today?' + todayParams('one-hand', '3min')),
        },
      });
    }
  }

  const visibleConfirmables = allConfirmables.slice(0, 2);
  const extraConfirmCount = Math.max(0, allConfirmables.length - visibleConfirmables.length);
  const undoableRules = plan.rules.filter(
    (rule) =>
      (rule.data.kind === 'defer' && Boolean(rule.data.until) && rule.data.until! > plan.day) ||
      (rule.data.kind === 'replace' && rule.data.date === plan.day),
  );

  const dismissConfirmKey = (key: string) =>
    setDismissedConfirmKeys((previous) => (previous.includes(key) ? previous : [...previous, key]));

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
                try {
                  sessionStorage.setItem('mangekyo:onboarding-dismissed', '1');
                } catch {}
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
            return (
              <a
                key={option.value ?? 'any'}
                href={href}
                aria-current={duration === option.value ? 'page' : undefined}
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

      {mutationError && <p className="tv2-error" role="alert">{mutationError}</p>}
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
                    .then(() => dismissConfirmKey(key))
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
                dismissConfirmKey(key);
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
          <button type="button" className="tv2-btn tv2-btn--ghost tv2-btn--sm" onClick={onOpenAiActivity}>
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

      <TodayHeroCard
        plan={plan}
        heroEntry={heroEntry}
        restRule={restRule}
        usableAlternatives={usableAlternatives}
        completedProtectedCount={completedProtected.length}
        scheduledCount={scheduledCandidates.length}
        emptyLibrary={emptyLibrary}
        mode={mode}
        duration={duration}
        locked={locked}
        basisOpen={basisOpen}
        onToggleBasis={toggleBasis}
        swapTargetId={swapTargetId}
        onSwapTargetChange={setSwapTargetId}
        issuingConceptId={issuingConceptId}
        authoringToday={authoringToday}
        authoringTodayError={authoringTodayError}
        onChangeRule={changeRule}
        onStartConceptPractice={(candidate) => void startConceptPractice(candidate)}
        onAuthorTodayPaper={() => void authorTodayPaper()}
        onOpenOnboarding={onOpenOnboarding}
        onNavigate={onNavigate}
        navigateTo={navigateTo}
        onCiteToCompanion={onCiteToCompanion}
      />

      {backupEntries.length > 0 && (
        <section className="tv2-section" aria-label="备选队列">
          <div className="tv2-section-head">
            <h3>接下来 · 备选</h3>
            <span className="tv2-muted">{backupEntries.length} 项</span>
          </div>
          <ul className="m3e-seg-list">
            {backupEntries.map((entry) => (
              <TodayQueueCard
                key={entry.candidate.id}
                plan={plan}
                entry={entry}
                usableAlternatives={usableAlternatives}
                mode={mode}
                duration={duration}
                locked={locked}
                swapTargetId={swapTargetId}
                onSwapTargetChange={setSwapTargetId}
                issuingConceptId={issuingConceptId}
                onChangeRule={changeRule}
                onStartConceptPractice={(candidate) => void startConceptPractice(candidate)}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </section>
      )}

      {completedProtected.length > 0 && (
        <section className="tv2-section" aria-label="今日已完成">
          <div className="tv2-section-head">
            <h3>今日已完成</h3>
            <span className="tv2-muted">{completedProtected.length} 项</span>
          </div>
          <ul className="m3e-seg-list">
            {completedProtected.map((candidate) => (
              <TodayQueueCard
                key={candidate.id}
                plan={plan}
                entry={{ candidate, why: [], actions: [], isProtected: true }}
                usableAlternatives={usableAlternatives}
                mode={mode}
                duration={duration}
                locked={locked}
                swapTargetId={swapTargetId}
                onSwapTargetChange={setSwapTargetId}
                issuingConceptId={issuingConceptId}
                onChangeRule={changeRule}
                onStartConceptPractice={(item) => void startConceptPractice(item)}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </section>
      )}

      <TodayBudgetCard
        plan={plan}
        scheduledCount={scheduledCandidates.length}
        restRule={restRule}
        undoableRules={undoableRules}
        titleByActivityId={titleByActivityId}
        locked={locked}
        onChangeRule={changeRule}
      />

      <TodayAuxPanels
        plan={plan}
        titleByActivityId={titleByActivityId}
        locked={locked}
        conflictsOpen={conflictsOpen}
        onToggleConflicts={toggleConflicts}
        goalOpen={goalOpen}
        onToggleGoal={toggleGoal}
        overviewOpen={overviewOpen}
        onToggleOverview={toggleOverview}
        onCommitOperation={(operation) => void commitOperation(operation)}
      />
    </section>
  );
}

export default TodaySurface;
