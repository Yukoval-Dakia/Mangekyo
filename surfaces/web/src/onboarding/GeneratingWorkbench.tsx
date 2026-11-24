import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { OnboardingStreamStageId } from '../api';
import {
  ONBOARDING_FINDING_KIND_LABELS,
  ONBOARDING_STAGE_LABELS,
  countFindings,
  mapErrorNext,
  stageDurationSeconds,
  type OnboardingFindingItem,
  type OnboardingStageState,
  type OnboardingWorkbenchState,
} from './stream-types';

export type GeneratingWorkbenchError = {
  message: string;
  code?: string | undefined;
  next?: string | undefined;
  stage?: OnboardingStreamStageId | undefined;
};

export interface GeneratingWorkbenchProps {
  state: OnboardingWorkbenchState;
  error: GeneratingWorkbenchError | null;
  running: boolean;
  runStartedAt: number | null;
  currentDate?: string | undefined;
  timeZone?: string | undefined;
  onCancel: () => void;
  onRetry: () => void;
  onOffline: () => void;
  onOpenSettings?: (() => void) | undefined;
}

function useNow(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatStageDuration(seconds: number): string {
  return seconds >= 60 ? formatClock(seconds) : `${seconds.toFixed(1)}s`;
}

const STAGE_STATUS_LABELS: Record<OnboardingStageState['status'], string> = {
  pending: '待开始',
  active: '运行中',
  done: '已完成',
  error: '异常',
};

function findingCountLabel(stage: OnboardingStageState): string | null {
  const counts = new Map<string, number>();
  for (const finding of stage.findings) {
    const label = ONBOARDING_FINDING_KIND_LABELS[finding.kind] ?? finding.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(' · ');
}

function StageBadge({ status }: { status: OnboardingStageState['status'] }) {
  if (status === 'done') {
    return <span className="ob-node-badge ob-node-badge--done" aria-label="已完成">✓</span>;
  }
  if (status === 'active') {
    return <span className="ob-node-badge ob-node-badge--active" aria-label="运行中"><i /></span>;
  }
  if (status === 'error') {
    return <span className="ob-node-badge ob-node-badge--error" aria-label="异常">!</span>;
  }
  return <span className="ob-node-badge ob-node-badge--pending" aria-label="待开始" />;
}

function FindingCard({ finding }: { finding: OnboardingFindingItem }) {
  const kindLabel = ONBOARDING_FINDING_KIND_LABELS[finding.kind] ?? finding.kind;
  return (
    <li className={`ob-finding ob-finding--${finding.kind}`}>
      <span className="ob-finding-kind">{kindLabel}</span>
      <span className="ob-finding-body">
        <span className="ob-finding-label">{finding.label}</span>
        {finding.detail && <span className="ob-finding-detail">{finding.detail}</span>}
      </span>
    </li>
  );
}

export function GeneratingWorkbench({
  state,
  error,
  running,
  runStartedAt,
  currentDate,
  timeZone,
  onCancel,
  onRetry,
  onOffline,
  onOpenSettings,
}: GeneratingWorkbenchProps) {
  const [focusedStageId, setFocusedStageId] = useState<OnboardingStreamStageId | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const thinkingRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  const now = useNow(running || state.activeStage != null);

  const focusedStage = useMemo(() => {
    const id = focusedStageId ?? state.activeStage ?? state.stages[0]?.id;
    return state.stages.find(stage => stage.id === id) ?? state.stages[0];
  }, [focusedStageId, state.activeStage, state.stages]);

  const totals = useMemo(() => countFindings(state.stages), [state.stages]);
  const totalsLabel = useMemo(() => {
    const parts: string[] = [];
    if (totals.subject > 0) parts.push(`${totals.subject} 学科`);
    if (totals.exam > 0) parts.push(`${totals.exam} 考试`);
    if (totals.concept > 0) parts.push(`${totals.concept} 概念`);
    if (totals.edge > 0) parts.push(`${totals.edge} 关系`);
    if (totals.question > 0) parts.push(`${totals.question} 摸底题`);
    if (totals.goal > 0) parts.push(`${totals.goal} 目标`);
    if (totals.repair > 0) parts.push(`${totals.repair} 修复`);
    return parts.join(' · ');
  }, [totals]);

  const elapsed = runStartedAt != null ? Math.max(0, (now - runStartedAt) / 1000) : 0;

  useEffect(() => {
    const node = thinkingRef.current;
    if (node && stickBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [focusedStage?.thinking, focusedStage?.id, thinkingOpen]);

  function handleThinkingScroll() {
    const node = thinkingRef.current;
    if (!node) return;
    stickBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  }

  function selectStage(id: OnboardingStreamStageId) {
    stickBottomRef.current = true;
    setFocusedStageId(id);
  }

  function followLatest() {
    stickBottomRef.current = true;
    setFocusedStageId(null);
  }

  const autoFollowing = focusedStageId == null;
  const errorNextText = error ? mapErrorNext(error.next ?? undefined) : null;

  return (
    <div className="ob-workbench">
      <aside className="ob-rail" aria-label="推演工作流节点">
        <ol className="ob-rail-list">
          {state.stages.map((stage, index) => {
            const countLabel = findingCountLabel(stage);
            const duration = stageDurationSeconds(stage, now);
            const lit = stage.status === 'done';
            const focused = focusedStage?.id === stage.id;
            return (
              <li
                key={stage.id}
                className={`ob-node ob-node--${stage.status}${lit ? ' ob-node--lit' : ''}${focused ? ' ob-node--focused' : ''}`}
                style={{ '--idx': index } as CSSProperties}
              >
                <button
                  type="button"
                  className="ob-node-button"
                  aria-pressed={focused}
                  {...(stage.status === 'active' ? { 'aria-current': 'step' } : {})}
                  onClick={() => selectStage(stage.id)}
                >
                  <StageBadge status={stage.status} />
                  <span className="ob-node-copy">
                    <span className="ob-node-title">{ONBOARDING_STAGE_LABELS[stage.id]}</span>
                    <span className="ob-node-sub">
                      {stage.detail ?? STAGE_STATUS_LABELS[stage.status]}
                    </span>
                    {(countLabel || duration != null) && (
                      <span className="ob-node-meta">
                        {countLabel && <span className="ob-node-count">{countLabel}</span>}
                        {duration != null && stage.status !== 'pending' && (
                          <span className="ob-node-time">{formatStageDuration(duration)}</span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </aside>

      <section className="ob-console" aria-label="Agent 工作控制台">
        <header className="ob-console-head">
          <div className="ob-console-title">
            <span className="ob-console-stage-name">
              {focusedStage ? ONBOARDING_STAGE_LABELS[focusedStage.id] : '推演工作台'}
            </span>
            {focusedStage && (
              <span className={`ob-console-status ob-console-status--${focusedStage.status}`}>
                {STAGE_STATUS_LABELS[focusedStage.status]}
              </span>
            )}
          </div>
          <div className="ob-console-meta">
            {state.meta.model && <span className="ob-console-chip">{state.meta.model}</span>}
            <span className="ob-console-chip ob-console-chip--quiet">
              {[state.meta.currentDate ?? currentDate, state.meta.timeZone ?? timeZone]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <span className="ob-console-timer" aria-label="运行计时">
              {formatClock(elapsed)}
            </span>
            {!autoFollowing && (
              <button type="button" className="ob-btn ob-btn--tonal ob-btn--sm" onClick={followLatest}>
                跟随最新
              </button>
            )}
          </div>
        </header>

        {totalsLabel && (
          <p className="ob-console-totals" role="status">
            已识别 {totalsLabel}
          </p>
        )}

        <div className={`ob-thinking${thinkingOpen ? ' ob-thinking--open' : ''}`}>
          <button
            type="button"
            className="ob-thinking-toggle"
            aria-expanded={thinkingOpen}
            onClick={() => setThinkingOpen(open => !open)}
          >
            <span className="ob-thinking-caret" aria-hidden="true" />
            实时思考流
            {focusedStage?.status === 'active' && <span className="ob-thinking-live" aria-label="生成中" />}
          </button>
          {thinkingOpen && (
            <div
              ref={thinkingRef}
              className="ob-thinking-body"
              onScroll={handleThinkingScroll}
              aria-live="polite"
            >
              {focusedStage?.thinking ? (
                <p className="ob-thinking-text">
                  {focusedStage.thinking}
                  {focusedStage.status === 'active' && <span className="ob-thinking-cursor" aria-hidden="true" />}
                </p>
              ) : (
                <p className="ob-thinking-empty">
                  {focusedStage?.status === 'active'
                    ? `${focusedStage.detail ?? ONBOARDING_STAGE_LABELS[focusedStage.id]}——AI 正在推演学制、知识图谱与摸底题，通常需要 30–60 秒，请稍候…`
                    : focusedStage?.status === 'pending'
                      ? '该阶段尚未开始。'
                      : '该阶段未返回思考流。'}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="ob-findings">
          <p className="ob-findings-title">实时产出</p>
          {focusedStage && focusedStage.findings.length > 0 ? (
            <ul className="ob-findings-list">
              {focusedStage.findings.map(finding => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
            </ul>
          ) : (
            <p className="ob-findings-empty">该阶段暂无落盘产出。</p>
          )}
        </div>

        {error && (
          <div className="ob-fail" role="alert">
            <p className="ob-fail-title">推演没能完成</p>
            <p className="ob-fail-message">{error.message || '推演暂时失败，请重试。'}</p>
            {errorNextText && <p className="ob-fail-next">{errorNextText}</p>}
            <div className="ob-actions">
              <button type="button" className="ob-btn ob-btn--primary" onClick={onRetry}>
                重试
              </button>
              {onOpenSettings && (
                <button type="button" className="ob-btn ob-btn--tonal" onClick={onOpenSettings}>
                  打开模型设置
                </button>
              )}
              <button type="button" className="ob-btn ob-btn--tonal" onClick={onOffline}>
                改用离线手动配置
              </button>
              <button type="button" className="ob-btn ob-btn--ghost" onClick={onCancel}>
                返回重填
              </button>
            </div>
          </div>
        )}

        <footer className="ob-console-foot">
          <button type="button" className="ob-btn ob-btn--ghost" onClick={onCancel}>
            取消并返回
          </button>
        </footer>
      </section>
    </div>
  );
}
