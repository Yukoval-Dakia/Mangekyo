import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  applyOnboarding,
  onboardingStatus,
  proposeOnboarding,
  requestId,
  type OnboardingApplyResponse,
  type OnboardingCompletedExam,
  type OnboardingProposeInput,
  type OnboardingStatus,
  type OnboardingUpcomingExam,
} from '../api';
import MathText from '../math-text';
import { handleSpaNavigation } from '../today-v2/shared';
import {
  applySummary,
  countSelectedEdges,
  fromDraftProposal,
  minutesToTime,
  timeToMinutes,
  toDraftProposal,
  toQuickPrefs,
  type DraftCompletedExam,
  type DraftProposal,
  type DraftUpcomingExam,
  type QuickPrefDraft,
} from './types';
import './onboarding.css';

export type OnboardingSurfaceProps = {
  onNavigate?: (href: string) => void;
  onOpenSettings?: (() => void) | undefined;
  onApplied?: (() => void) | undefined;
};

type Step = 'intro' | 'generating' | 'review' | 'done';

const EXAMPLES = [
  {
    chip: '浙江宁波中学高二 · 物化技',
    text: '我是高二高中生，在浙江宁波中学，选科物理、化学、技术，晚自习后每天有 45 分钟，喜欢先懂原理再刷变式题',
  },
  {
    chip: '大三考研 408 冲刺',
    text: '我是计算机大三学生，准备今年年底考研 408（数据结构、计组、操作系统、计网），每天晚上可学 60 分钟，希望以真题例题与错因剖析为主',
  },
  {
    chip: '工作之余自学 Rust + 系统设计',
    text: '我是后端工程师，工作之余自学 Rust 所有权/异步运行时与分布式系统设计，每天通勤+晚间 30 分钟，偏好简洁直接少废话',
  },
];

const DAILY_MINUTES_OPTIONS = [15, 30, 45, 60] as const;

const CAMPAIGN_OPTIONS: readonly { value: 'steady' | 'sprint' | 'recovery'; label: string }[] = [
  { value: 'steady', label: '稳步' },
  { value: 'sprint', label: '冲刺' },
  { value: 'recovery', label: '轻量恢复' },
];

const TEACHING_STYLE_OPTIONS = [
  '先懂直觉再看公式',
  '例题变式驱动',
  '启发式追问',
  '简洁直接',
] as const;

const DIFFICULTY_LABELS = {
  foundation: '基础',
  core: '核心',
  stretch: '进阶',
} as const;

const GENERATE_STAGES = [
  '学制与考试节点',
  '学科语境',
  '知识图谱',
  '摸底题库',
] as const;

const MEMO_LIMIT = 780;

function localId() {
  return `local-${requestId()}`;
}

function sortedUpcoming(exams: DraftUpcomingExam[]): DraftUpcomingExam[] {
  return [...exams].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function isModelFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 503 || error.code === 'model_unavailable' || error.code === 'model_failed')
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function OnboardingSurface({ onNavigate, onOpenSettings, onApplied }: OnboardingSurfaceProps) {
  const [step, setStep] = useState<Step>('intro');
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [profileText, setProfileText] = useState('');
  const [quickPrefs, setQuickPrefs] = useState<QuickPrefDraft>({});
  const [generateStage, setGenerateStage] = useState(0);
  const [generateError, setGenerateError] = useState<ApiError | TypeError | null>(null);
  const [draft, setDraft] = useState<DraftProposal | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applyResult, setApplyResult] = useState<OnboardingApplyResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastInputRef = useRef<OnboardingProposeInput | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    onboardingStatus()
      .then(value => {
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (step !== 'generating' || generateError) return;
    setGenerateStage(0);
    const timer = window.setInterval(() => {
      setGenerateStage(current => Math.min(current + 1, GENERATE_STAGES.length - 1));
    }, 1400);
    return () => window.clearInterval(timer);
  }, [step, generateError]);

  const timeZone = useMemo(() => {
    return status?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }, [status?.timeZone]);

  const todayLabel = useMemo(() => {
    const date = status?.currentDate ?? new Date().toISOString().slice(0, 10);
    return date;
  }, [status?.currentDate]);

  const beginPropose = useCallback(
    (mode: 'llm' | 'offline_manual') => {
      const input: OnboardingProposeInput = {
        profileText: profileText.trim(),
        timeZone,
        ...(toQuickPrefs(quickPrefs) ? { quickPrefs: toQuickPrefs(quickPrefs) } : {}),
        mode,
      };
      lastInputRef.current = input;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setGenerateError(null);
      setStep('generating');
      proposeOnboarding(input, controller.signal)
        .then(response => {
          if (controller.signal.aborted) return;
          setDraft(toDraftProposal(response.proposal, localId));
          setStep('review');
        })
        .catch((failure: unknown) => {
          if (controller.signal.aborted || isAbort(failure)) return;
          setGenerateError(
            failure instanceof ApiError || failure instanceof TypeError
              ? failure
              : new ApiError(0, '推演暂时失败，请重试。'),
          );
        });
    },
    [profileText, quickPrefs, timeZone],
  );

  function cancelGenerating() {
    abortRef.current?.abort();
    setGenerateError(null);
    setStep('intro');
  }

  function goOfflineManual() {
    const input = lastInputRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerateError(null);
    const offlineInput: OnboardingProposeInput = input
      ? { ...input, mode: 'offline_manual' }
      : {
          profileText: profileText.trim(),
          timeZone,
          ...(toQuickPrefs(quickPrefs) ? { quickPrefs: toQuickPrefs(quickPrefs) } : {}),
          mode: 'offline_manual',
        };
    lastInputRef.current = offlineInput;
    proposeOnboarding(offlineInput, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        setDraft(toDraftProposal(response.proposal, localId));
        setStep('review');
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || isAbort(failure)) return;
        setGenerateError(
          failure instanceof ApiError || failure instanceof TypeError
            ? failure
            : new ApiError(0, '离线草稿暂时不可用，请重试。'),
        );
      });
  }

  function updateDraft(mutator: (current: DraftProposal) => DraftProposal) {
    setDraft(current => (current ? mutator(current) : current));
  }

  async function confirmApply() {
    if (!draft || applyBusy) return;
    setApplyBusy(true);
    setApplyError('');
    try {
      const result = await applyOnboarding({
        requestId: requestId(),
        proposal: fromDraftProposal(draft),
      });
      setApplyResult(result);
      setStep('done');
      onApplied?.();
    } catch (failure) {
      setApplyError(
        failure instanceof ApiError
          ? failure.message || '配置暂时未能落库，请重试。'
          : '配置暂时未能落库，请检查网络后重试。',
      );
    } finally {
      setApplyBusy(false);
    }
  }

  if (step === 'intro') {
    return (
      <section className="ob" aria-label="快速设置">
        <IntroStep
          status={status}
          profileText={profileText}
          setProfileText={setProfileText}
          quickPrefs={quickPrefs}
          setQuickPrefs={setQuickPrefs}
          onSubmit={() => beginPropose('llm')}
          onOffline={() => beginPropose('offline_manual')}
          onSkip={() => onNavigate?.('/today')}
          onOpenSettings={onOpenSettings}
        />
      </section>
    );
  }

  if (step === 'generating') {
    return (
      <section className="ob" aria-label="推演中">
        <GeneratingStep
          stage={generateStage}
          todayLabel={todayLabel}
          timeZone={timeZone}
          error={generateError}
          onCancel={cancelGenerating}
          onOpenSettings={onOpenSettings}
          onOffline={goOfflineManual}
          onRetry={() => beginPropose(lastInputRef.current?.mode === 'offline_manual' ? 'offline_manual' : 'llm')}
        />
      </section>
    );
  }

  if (step === 'review' && draft) {
    return (
      <section className="ob ob--review" aria-label="确认方案">
        <ReviewStep
          draft={draft}
          updateDraft={updateDraft}
          onBack={() => setStep('intro')}
          onApply={confirmApply}
          applyBusy={applyBusy}
          applyError={applyError}
        />
      </section>
    );
  }

  if (step === 'done' && applyResult) {
    return (
      <section className="ob" aria-label="配置完成">
        <DoneStep result={applyResult} onNavigate={onNavigate} />
      </section>
    );
  }

  return null;
}

function IntroStep({
  status,
  profileText,
  setProfileText,
  quickPrefs,
  setQuickPrefs,
  onSubmit,
  onOffline,
  onSkip,
  onOpenSettings,
}: {
  status: OnboardingStatus | null;
  profileText: string;
  setProfileText: (value: string) => void;
  quickPrefs: QuickPrefDraft;
  setQuickPrefs: (updater: (current: QuickPrefDraft) => QuickPrefDraft) => void;
  onSubmit: () => void;
  onOffline: () => void;
  onSkip: () => void;
  onOpenSettings?: (() => void) | undefined;
}) {
  const textLength = profileText.trim().length;
  const canSubmit = textLength >= 8;
  return (
    <div className="ob-intro">
      <header className="ob-hero">
        <p className="ob-kicker">30 秒认识你</p>
        <h1>告诉 Mangekyō 你在学什么</h1>
        <p className="ob-hero-sub">
          一小段自然语言就够。后台教研会推演出你的考试日程、知识图谱与第一批摸底题，确认后再落库。
        </p>
      </header>

      <div className="ob-examples" role="group" aria-label="示例">
        {EXAMPLES.map(example => (
          <button
            key={example.chip}
            type="button"
            className="ob-example-chip"
            onClick={() => setProfileText(example.text)}
          >
            {example.chip}
          </button>
        ))}
      </div>

      <div className="ob-input-card">
        <label className="ob-input-label" htmlFor="ob-profile">
          你是谁、在准备什么、每天能挤出多少时间、喜欢怎么被讲明白
        </label>
        <textarea
          id="ob-profile"
          className="ob-textarea"
          rows={5}
          value={profileText}
          placeholder="例如：我是高二高中生，在浙江宁波中学，选科物理、化学、技术，晚自习后每天有 45 分钟，喜欢先懂原理再刷变式题"
          onChange={event => setProfileText(event.target.value)}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <div className="ob-input-meta">
          <span>{textLength > 0 ? `${textLength} 字` : '⌘ / Ctrl + Enter 直接推演'}</span>
          {textLength > 0 && textLength < 8 && <span>再多写一点点（≥8 字）</span>}
        </div>
      </div>

      <div className="ob-prefs">
        <div className="ob-pref-group" role="group" aria-label="每日可用时间">
          <span className="ob-pref-label">每日可用时间</span>
          <div className="ob-pref-chips">
            {DAILY_MINUTES_OPTIONS.map(minutes => (
              <button
                key={minutes}
                type="button"
                className="ob-chip"
                aria-pressed={quickPrefs.dailyMinutes === minutes}
                onClick={() =>
                  setQuickPrefs(current => ({
                    ...current,
                    dailyMinutes: current.dailyMinutes === minutes ? undefined : minutes,
                  }))
                }
              >
                {minutes === 60 ? '60+ 分钟' : `${minutes} 分钟`}
              </button>
            ))}
          </div>
        </div>
        <div className="ob-pref-group" role="group" aria-label="当前节奏">
          <span className="ob-pref-label">当前节奏</span>
          <div className="ob-pref-chips">
            {CAMPAIGN_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                className="ob-chip"
                aria-pressed={quickPrefs.campaign === option.value}
                onClick={() =>
                  setQuickPrefs(current => ({
                    ...current,
                    campaign: current.campaign === option.value ? undefined : option.value,
                  }))
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ob-pref-group" role="group" aria-label="讲解偏好">
          <span className="ob-pref-label">讲解偏好</span>
          <div className="ob-pref-chips">
            {TEACHING_STYLE_OPTIONS.map(style => (
              <button
                key={style}
                type="button"
                className="ob-chip"
                aria-pressed={quickPrefs.teachingStyle === style}
                onClick={() =>
                  setQuickPrefs(current => ({
                    ...current,
                    teachingStyle: current.teachingStyle === style ? undefined : style,
                  }))
                }
              >
                {style}
              </button>
            ))}
          </div>
        </div>
      </div>

      {status && !status.hasModel && (
        <p className="ob-model-hint" role="status">
          尚未配置模型，可以先
          {onOpenSettings && (
            <button type="button" className="ob-inline-button" onClick={onOpenSettings}>
              打开模型设置
            </button>
          )}
          或直接用「离线手动配置」起草一份可编辑方案。
        </p>
      )}

      {status?.completed && (
        <p className="ob-model-hint" role="status">
          你已做过一次初始配置，这次运行会在现有学习画像上继续补充。
        </p>
      )}

      <div className="ob-actions">
        <button
          type="button"
          className="ob-btn ob-btn--primary"
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          AI 为我推演专属方案
        </button>
        <button type="button" className="ob-btn ob-btn--tonal" onClick={onOffline}>
          离线手动配置
        </button>
        <button type="button" className="ob-btn ob-btn--ghost" onClick={onSkip}>
          先自己逛逛
        </button>
      </div>
    </div>
  );
}

function GeneratingStep({
  stage,
  todayLabel,
  timeZone,
  error,
  onCancel,
  onOpenSettings,
  onOffline,
  onRetry,
}: {
  stage: number;
  todayLabel: string;
  timeZone: string;
  error: ApiError | TypeError | null;
  onCancel: () => void;
  onOpenSettings?: (() => void) | undefined;
  onOffline: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="ob-generating">
      <p className="ob-kicker">今天是 {todayLabel} · {timeZone}</p>
      <h1>正在为你推演初始方案</h1>

      {!error ? (
        <>
          <ol className="ob-stages">
            {GENERATE_STAGES.map((label, index) => (
              <li
                key={label}
                className={
                  index < stage ? 'ob-stage ob-stage--done' : index === stage ? 'ob-stage ob-stage--active' : 'ob-stage'
                }
              >
                <span className="ob-stage-dot" aria-hidden="true" />
                {label}
                {index === stage && <span className="ob-stage-note">推演中…</span>}
                {index < stage && <span className="ob-stage-note">已就绪</span>}
              </li>
            ))}
          </ol>
          <button type="button" className="ob-btn ob-btn--ghost" onClick={onCancel}>
            取消并返回
          </button>
        </>
      ) : (
        <div className="ob-fail" role="alert">
          <p className="ob-fail-title">
            {error instanceof TypeError
              ? '网络好像断了一下，推演没能完成。'
              : isModelFailure(error)
                ? '模型暂时不可用，推演没能完成。'
                : error.message || '推演暂时失败。'}
          </p>
          {error instanceof ApiError && error.next && <p className="ob-fail-next">{error.next}</p>}
          <div className="ob-actions">
            {onOpenSettings && (
              <button type="button" className="ob-btn ob-btn--primary" onClick={onOpenSettings}>
                打开模型设置
              </button>
            )}
            <button type="button" className="ob-btn ob-btn--tonal" onClick={onOffline}>
              改用离线手动配置
            </button>
            <button type="button" className="ob-btn ob-btn--ghost" onClick={onRetry}>
              重试
            </button>
            <button type="button" className="ob-btn ob-btn--ghost" onClick={onCancel}>
              返回重填
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewStep({
  draft,
  updateDraft,
  onBack,
  onApply,
  applyBusy,
  applyError,
}: {
  draft: DraftProposal;
  updateDraft: (mutator: (current: DraftProposal) => DraftProposal) => void;
  onBack: () => void;
  onApply: () => void;
  applyBusy: boolean;
  applyError: string;
}) {
  const [newExam, setNewExam] = useState({ subject: '', examName: '' });
  const [newNote, setNewNote] = useState('');
  const [memoOpen, setMemoOpen] = useState(false);
  const [newUpcoming, setNewUpcoming] = useState({ title: '', date: '' });

  const subjects = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const concept of draft.knowledgeGraph.concepts) {
      if (concept.selected) grouped.set(concept.subject, (grouped.get(concept.subject) ?? 0) + 1);
    }
    return grouped;
  }, [draft.knowledgeGraph.concepts]);

  const selectedEdgeCount = useMemo(() => countSelectedEdges(draft), [draft]);

  function patchCompleted(localIdValue: string, patch: Partial<DraftCompletedExam>) {
    updateDraft(current => ({
      ...current,
      examStatus: {
        ...current.examStatus,
        completedExams: current.examStatus.completedExams.map(item =>
          item.localId === localIdValue ? { ...item, ...patch } : item,
        ),
      },
    }));
  }

  function patchUpcoming(localIdValue: string, patch: Partial<DraftUpcomingExam>) {
    updateDraft(current => ({
      ...current,
      examStatus: {
        ...current.examStatus,
        upcomingExams: current.examStatus.upcomingExams.map(item =>
          item.localId === localIdValue ? { ...item, ...patch } : item,
        ),
      },
    }));
  }

  return (
    <div className="ob-review">
      <header className="ob-review-head">
        <p className="ob-kicker">{draft.meta.source === 'llm' ? 'AI 推演草稿' : '离线手动草稿'} · {draft.meta.currentDate}</p>
        <h1>{draft.learnerSummary.headline || '你的初始学习方案'}</h1>
        <p className="ob-honesty">{draft.meta.honestyNote}</p>
        <div className="ob-summary-fields">
          <label>
            <span>学段</span>
            <input
              value={draft.learnerSummary.stage}
              onChange={event =>
                updateDraft(current => ({
                  ...current,
                  learnerSummary: { ...current.learnerSummary, stage: event.target.value },
                }))
              }
            />
          </label>
          <label>
            <span>学校 / 地区</span>
            <input
              value={draft.learnerSummary.regionOrSchool}
              onChange={event =>
                updateDraft(current => ({
                  ...current,
                  learnerSummary: { ...current.learnerSummary, regionOrSchool: event.target.value },
                }))
              }
            />
          </label>
          <label>
            <span>当前学期</span>
            <input
              value={draft.learnerSummary.inferredPeriod}
              onChange={event =>
                updateDraft(current => ({
                  ...current,
                  learnerSummary: { ...current.learnerSummary, inferredPeriod: event.target.value },
                }))
              }
            />
          </label>
        </div>
      </header>

      <section className="ob-card" aria-label="学情与已考/待考科目">
        <h2>学情与已考 / 待考科目</h2>
        <p className="ob-card-sub">点一下在「已考完」↔「待考」之间切换；AI 不确定的会标注「请核对」。</p>
        <ul className="ob-exam-list">
          {draft.examStatus.completedExams.map(item => (
            <li key={item.localId} className="ob-exam-item">
              <button
                type="button"
                className={`ob-exam-status ob-exam-status--${item.status}`}
                title={item.reason || '点击切换状态'}
                onClick={() =>
                  patchCompleted(item.localId, {
                    status: item.status === 'completed' ? 'upcoming' : 'completed',
                  })
                }
              >
                {item.status === 'completed' ? '已考完 ✓' : item.status === 'upcoming' ? '待考 ⏳' : '免考'}
              </button>
              <span className="ob-exam-name">
                <strong>{item.subject}</strong>
                <span>{item.examName}</span>
              </span>
              {item.confidence === 'needs_confirm' && <span className="ob-badge">AI 推测 · 请核对</span>}
              <button
                type="button"
                className="ob-icon-remove"
                aria-label={`移除 ${item.subject} ${item.examName}`}
                onClick={() =>
                  updateDraft(current => ({
                    ...current,
                    examStatus: {
                      ...current.examStatus,
                      completedExams: current.examStatus.completedExams.filter(
                        entry => entry.localId !== item.localId,
                      ),
                    },
                  }))
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="ob-add-row">
          <input
            placeholder="科目"
            value={newExam.subject}
            onChange={event => setNewExam(current => ({ ...current, subject: event.target.value }))}
          />
          <input
            placeholder="考试名称"
            value={newExam.examName}
            onChange={event => setNewExam(current => ({ ...current, examName: event.target.value }))}
          />
          <button
            type="button"
            className="ob-btn ob-btn--tonal ob-btn--sm"
            disabled={!newExam.subject.trim() || !newExam.examName.trim()}
            onClick={() => {
              const entry: DraftCompletedExam = {
                localId: localId(),
                subject: newExam.subject.trim(),
                examName: newExam.examName.trim(),
                status: 'upcoming',
                confidence: 'high',
                reason: '手动添加',
              };
              updateDraft(current => ({
                ...current,
                examStatus: {
                  ...current.examStatus,
                  completedExams: [...current.examStatus.completedExams, entry],
                },
              }));
              setNewExam({ subject: '', examName: '' });
            }}
          >
            + 添加
          </button>
        </div>
      </section>

      <section className="ob-card" aria-label="考试时间轴">
        <h2>考试时间轴</h2>
        <p className="ob-card-sub">按日期排序。每场考试可以改名、改日期、切换「约计 ↔ 已确认」。</p>
        <ol className="ob-timeline">
          {sortedUpcoming(draft.examStatus.upcomingExams).map(item => (
            <li key={item.localId} className="ob-timeline-item">
              <span className="ob-timeline-dot" aria-hidden="true" />
              <div className="ob-timeline-body">
                <div className="ob-timeline-top">
                  <input
                    className="ob-timeline-title"
                    value={item.title}
                    onChange={event => patchUpcoming(item.localId, { title: event.target.value })}
                  />
                  <button
                    type="button"
                    className="ob-icon-remove"
                    aria-label={`删除 ${item.title}`}
                    onClick={() =>
                      updateDraft(current => ({
                        ...current,
                        examStatus: {
                          ...current.examStatus,
                          upcomingExams: current.examStatus.upcomingExams.filter(
                            entry => entry.localId !== item.localId,
                          ),
                        },
                      }))
                    }
                  >
                    ×
                  </button>
                </div>
                <div className="ob-timeline-meta">
                  <input
                    type="date"
                    value={item.date}
                    onChange={event => patchUpcoming(item.localId, { date: event.target.value })}
                  />
                  <button
                    type="button"
                    className={`ob-certainty ob-certainty--${item.dateCertainty}`}
                    onClick={() =>
                      patchUpcoming(item.localId, {
                        dateCertainty: item.dateCertainty === 'exact' ? 'estimated' : 'exact',
                      })
                    }
                  >
                    {item.dateCertainty === 'exact' ? '已确认' : '约计日期'}
                  </button>
                </div>
                {item.scope.length > 0 && (
                  <p className="ob-timeline-scope">范围：{item.scope.join('、')}</p>
                )}
                <textarea
                  rows={2}
                  value={item.note}
                  placeholder="备注"
                  onChange={event => patchUpcoming(item.localId, { note: event.target.value })}
                />
              </div>
            </li>
          ))}
        </ol>
        <div className="ob-add-row">
          <input
            placeholder="考试名称"
            value={newUpcoming.title}
            onChange={event => setNewUpcoming(current => ({ ...current, title: event.target.value }))}
          />
          <input
            type="date"
            value={newUpcoming.date}
            onChange={event => setNewUpcoming(current => ({ ...current, date: event.target.value }))}
          />
          <button
            type="button"
            className="ob-btn ob-btn--tonal ob-btn--sm"
            disabled={!newUpcoming.title.trim() || !newUpcoming.date}
            onClick={() => {
              const entry: DraftUpcomingExam = {
                localId: localId(),
                id: localId(),
                title: newUpcoming.title.trim(),
                date: newUpcoming.date,
                dateCertainty: 'estimated',
                scope: [],
                weights: [],
                note: '手动添加',
              };
              updateDraft(current => ({
                ...current,
                examStatus: {
                  ...current.examStatus,
                  upcomingExams: [...current.examStatus.upcomingExams, entry],
                },
              }));
              setNewUpcoming({ title: '', date: '' });
            }}
          >
            + 添加考试节点
          </button>
        </div>
      </section>

      <section className="ob-card" aria-label="学习目标、每日窗口与偏好">
        <h2>学习目标、每日窗口与偏好</h2>
        <label className="ob-field">
          <span>学习目标</span>
          <textarea
            rows={3}
            value={draft.studyPlan.goalText}
            onChange={event =>
              updateDraft(current => ({
                ...current,
                studyPlan: { ...current.studyPlan, goalText: event.target.value },
              }))
            }
          />
        </label>
        <div className="ob-inline-fields">
          <div className="ob-field" role="group" aria-label="节奏">
            <span>节奏</span>
            <div className="ob-pref-chips">
              {CAMPAIGN_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  className="ob-chip"
                  aria-pressed={draft.studyPlan.campaign === option.value}
                  onClick={() =>
                    updateDraft(current => ({
                      ...current,
                      studyPlan: { ...current.studyPlan, campaign: option.value },
                    }))
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="ob-field">
            <span>每日窗口</span>
            <div className="ob-window">
              <input
                value={draft.studyPlan.dailyWindow.label}
                placeholder="如：晚自习后"
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    studyPlan: {
                      ...current.studyPlan,
                      dailyWindow: { ...current.studyPlan.dailyWindow, label: event.target.value },
                    },
                  }))
                }
              />
              <input
                type="time"
                value={minutesToTime(draft.studyPlan.dailyWindow.start)}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    studyPlan: {
                      ...current.studyPlan,
                      dailyWindow: {
                        ...current.studyPlan.dailyWindow,
                        start: timeToMinutes(event.target.value) ?? current.studyPlan.dailyWindow.start,
                      },
                    },
                  }))
                }
              />
              <span aria-hidden="true">—</span>
              <input
                type="time"
                value={minutesToTime(draft.studyPlan.dailyWindow.end)}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    studyPlan: {
                      ...current.studyPlan,
                      dailyWindow: {
                        ...current.studyPlan.dailyWindow,
                        end: timeToMinutes(event.target.value) ?? current.studyPlan.dailyWindow.end,
                      },
                    },
                  }))
                }
              />
            </div>
          </div>
        </div>

        <div className="ob-field">
          <span>偏好备注</span>
          <ul className="ob-notes">
            {draft.studyPlan.preferenceNotes.map((note, index) => (
              <li key={`${index}-${note.slice(0, 12)}`}>
                <span>{note}</span>
                <button
                  type="button"
                  className="ob-icon-remove"
                  aria-label="移除这条偏好"
                  onClick={() =>
                    updateDraft(current => ({
                      ...current,
                      studyPlan: {
                        ...current.studyPlan,
                        preferenceNotes: current.studyPlan.preferenceNotes.filter((_, i) => i !== index),
                      },
                    }))
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="ob-add-row">
            <input
              placeholder="补充一条偏好，如：先讲例题再总结"
              value={newNote}
              onChange={event => setNewNote(event.target.value)}
            />
            <button
              type="button"
              className="ob-btn ob-btn--tonal ob-btn--sm"
              disabled={!newNote.trim()}
              onClick={() => {
                updateDraft(current => ({
                  ...current,
                  studyPlan: {
                    ...current.studyPlan,
                    preferenceNotes: [...current.studyPlan.preferenceNotes, newNote.trim()],
                  },
                }));
                setNewNote('');
              }}
            >
              + 添加
            </button>
          </div>
        </div>

        <div className="ob-field">
          <button
            type="button"
            className="ob-inline-button"
            aria-expanded={memoOpen}
            onClick={() => setMemoOpen(open => !open)}
          >
            {memoOpen ? '收起同伴长期备注' : '查看/微调同伴长期备注'}
          </button>
          {memoOpen && (
            <>
              <textarea
                rows={5}
                value={draft.studyPlan.companionMemo}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    studyPlan: {
                      ...current.studyPlan,
                      companionMemo: event.target.value.slice(0, MEMO_LIMIT),
                    },
                  }))
                }
              />
              <span className="ob-field-meta">{draft.studyPlan.companionMemo.length} / {MEMO_LIMIT}</span>
            </>
          )}
        </div>
      </section>

      <section className="ob-card" aria-label="初始知识图谱预览">
        <h2>初始知识图谱</h2>
        <p className="ob-card-sub">
          已选 {draft.knowledgeGraph.concepts.filter(c => c.selected).length} 个知识点 · {selectedEdgeCount} 条关联
        </p>
        {[...subjects.keys()].map(subject => {
          const concepts = draft.knowledgeGraph.concepts.filter(c => c.subject === subject);
          const selectedCount = concepts.filter(c => c.selected).length;
          const allSelected = selectedCount === concepts.length && concepts.length > 0;
          return (
            <div key={subject} className="ob-graph-group">
              <div className="ob-graph-head">
                <strong>{subject}</strong>
                <span className="ob-field-meta">已选 {selectedCount} / {concepts.length}</span>
                <button
                  type="button"
                  className="ob-inline-button"
                  onClick={() =>
                    updateDraft(current => ({
                      ...current,
                      knowledgeGraph: {
                        ...current.knowledgeGraph,
                        concepts: current.knowledgeGraph.concepts.map(c =>
                          c.subject === subject ? { ...c, selected: !allSelected } : c,
                        ),
                      },
                    }))
                  }
                >
                  {allSelected ? '全部取消' : '全选'}
                </button>
              </div>
              <div className="ob-concepts">
                {concepts.map(concept => (
                  <button
                    key={concept.key}
                    type="button"
                    className="ob-concept"
                    aria-pressed={concept.selected}
                    title={`${concept.semesterTag ? concept.semesterTag + ' · ' : ''}${concept.summary}`}
                    onClick={() =>
                      updateDraft(current => ({
                        ...current,
                        knowledgeGraph: {
                          ...current.knowledgeGraph,
                          concepts: current.knowledgeGraph.concepts.map(c =>
                            c.key === concept.key ? { ...c, selected: !c.selected } : c,
                          ),
                        },
                      }))
                    }
                  >
                    {concept.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section className="ob-card" aria-label="初始摸底题库预览">
        <h2>初始摸底题库</h2>
        <p className="ob-card-sub">
          已选 {draft.starterQuestions.filter(q => q.selected).length} / {draft.starterQuestions.length} 道，点开看题干与答案。
        </p>
        <ul className="ob-questions">
          {draft.starterQuestions.map(question => (
            <QuestionPreview
              key={question.key}
              question={question}
              conceptTitleByKey={
                new Map(draft.knowledgeGraph.concepts.map(c => [c.key, c.title]))
              }
              onToggle={() =>
                updateDraft(current => ({
                  ...current,
                  starterQuestions: current.starterQuestions.map(q =>
                    q.key === question.key ? { ...q, selected: !q.selected } : q,
                  ),
                }))
              }
            />
          ))}
        </ul>
      </section>

      <div className="ob-sticky" role="region" aria-label="确认应用">
        <span className="ob-sticky-summary">{applySummary(draft)}</span>
        <div className="ob-sticky-actions">
          {applyError && <span className="ob-sticky-error" role="alert">{applyError}</span>}
          <button type="button" className="ob-btn ob-btn--ghost" onClick={onBack} disabled={applyBusy}>
            返回重填
          </button>
          <button type="button" className="ob-btn ob-btn--primary" onClick={onApply} disabled={applyBusy}>
            {applyBusy ? '正在配置…' : '一键帮我配置好'}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuestionPreview({
  question,
  conceptTitleByKey,
  onToggle,
}: {
  question: DraftProposal['starterQuestions'][number];
  conceptTitleByKey: ReadonlyMap<string, string>;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`ob-question${question.selected ? '' : ' ob-question--off'}`}>
      <div className="ob-question-head">
        <label className="ob-question-toggle">
          <input type="checkbox" checked={question.selected} onChange={onToggle} />
          <span className="ob-question-title">{question.title}</span>
        </label>
        <span className="ob-question-meta">
          <span className="ob-badge">{question.subject}</span>
          <span className={`ob-badge ob-badge--${question.difficulty}`}>
            {DIFFICULTY_LABELS[question.difficulty]}
          </span>
          {question.conceptKeys
            .map(key => conceptTitleByKey.get(key))
            .filter(Boolean)
            .slice(0, 3)
            .map(title => <span key={title} className="ob-badge ob-badge--dim">{title}</span>)}
        </span>
        <button
          type="button"
          className="ob-inline-button"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
        >
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open && (
        <div className="ob-question-body">
          <div className="ob-question-block">
            <span className="ob-question-label">题干</span>
            <MathText text={question.prompt} />
          </div>
          <div className="ob-question-block">
            <span className="ob-question-label">参考答案</span>
            <MathText text={question.answer} />
          </div>
          {question.rubric && (
            <div className="ob-question-block">
              <span className="ob-question-label">评分要点</span>
              <MathText text={question.rubric} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function DoneStep({
  result,
  onNavigate,
}: {
  result: OnboardingApplyResponse;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const { applied, links } = result;
  const stats = [
    '1 项目标',
    `${applied.disciplineCount} 个学科`,
    `${applied.conceptCount} 个知识点`,
    `${applied.edgeCount} 条关系`,
    `${applied.questionCount} 道摸底题`,
  ];
  if (applied.ruleCount > 0) stats.splice(1, 0, `${applied.ruleCount} 场考试/规则`);
  const targets = [
    { label: '去今天开始第一项', href: links.today || '/today', primary: true },
    { label: '查看我的知识图谱', href: links.graph || '/materials?tab=graph' },
    { label: '去摸底题库开练', href: links.bank || '/materials?tab=bank' },
    { label: '跟同伴聊聊', href: links.companion || '/companion' },
  ];
  return (
    <div className="ob-done">
      <p className="ob-kicker">配置完成</p>
      <h1>你的学习空间已经就绪</h1>
      <ul className="ob-done-stats">
        {stats.map(item => (
          <li key={item}>{item}</li>
        ))}
        <li>{applied.memoryUpdated ? '同伴长期记忆已更新' : '同伴长期记忆未变'}</li>
        {applied.skippedExistingConcepts > 0 && (
          <li>{applied.skippedExistingConcepts} 个已有知识点被跳过（不重复）</li>
        )}
      </ul>
      <div className="ob-done-links">
        {targets.map(target => (
          <a
            key={target.href}
            className={target.primary ? 'ob-btn ob-btn--primary' : 'ob-btn ob-btn--tonal'}
            href={target.href}
            onClick={event => handleSpaNavigation(event, target.href, onNavigate)}
          >
            {target.label}
          </a>
        ))}
      </div>
    </div>
  );
}
