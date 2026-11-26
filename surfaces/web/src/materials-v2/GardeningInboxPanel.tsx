import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestId } from '../api';
import { Icon } from '../icons';
import { readTrimmed } from '../shared/safe-values';
import {
  ASSET_KIND_LABELS,
  CATEGORY_META,
  DANGLING_REASON_LABELS,
  DEFAULT_ACTIONS_ENDPOINT,
  DEFAULT_GARDENING_ENDPOINT,
  DEFAULT_UNDO_ENDPOINT,
  fetchOptionalGardeningPlan,
  formatGreenPreview,
  formatScorePercent,
  GREEN_ACTION_LABELS,
  normalizeGardeningInbox,
  postGardeningJsonAction,
  RED_RULE_LABELS,
} from './gardening-inbox-model';
import type {
  GardeningActionDecision,
  GardeningInboxPanelProps,
  GardeningInboxPlan,
  NormalizedGardeningGreenAction,
  NormalizedGardeningProposal,
} from './types';

export { normalizeGardeningInbox };

const CATEGORY_TONE_CLASS = {
  amber: 'mv2-pill-due',
  weak: 'mv2-pill-weak',
  steady: 'mv2-pill-steady',
  info: 'mv2-pill-unknown',
} as const;

function GardenSparkIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3m0 12v3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M3 12h3m12 0h3M4.9 19.1 7 17m10-10 2.1-2.1" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Z" />
      <path d="M9.5 12.2 11.3 14l3.5-3.8" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function ProposalDetailPreview({ proposal }: { readonly proposal: NormalizedGardeningProposal }) {
  const { category, detail, appendOnly } = proposal;

  if (category === 'merge_duplicate_concepts') {
    const fromLabel =
      readTrimmed(detail.mergeEntityName) ?? readTrimmed(detail.fromTitle) ?? readTrimmed(detail.mergeEntityId) ?? '来源概念';
    const toLabel =
      readTrimmed(detail.keepEntityName) ?? readTrimmed(detail.toTitle) ?? readTrimmed(detail.keepEntityId) ?? '目标概念';
    const scoreText = formatScorePercent(detail.similarityScore);
    const reasons = detail.reasons?.filter(Boolean) ?? [];
    const sources = detail.sources?.filter(Boolean) ?? [];

    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-redirect">
          <span className="mv2-garden-node mv2-garden-node-from">{fromLabel}</span>
          <span className="mv2-garden-arrow" aria-hidden="true">→</span>
          <span className="mv2-garden-node mv2-garden-node-to">{toLabel}</span>
          <span className="mv2-pill mv2-pill-steady">301 永久重定向</span>
        </div>
        <div className="mv2-garden-meta-row">
          {scoreText && <span className="mv2-origin-chip">重合度 {scoreText}</span>}
          {detail.crossSource && <span className="mv2-pill mv2-pill-due">跨来源对齐</span>}
          {sources.map((src) => (
            <span key={src} className="mv2-origin-chip">来源：{src}</span>
          ))}
        </div>
        {reasons.length > 0 && (
          <ul className="mv2-garden-bullets">
            {reasons.slice(0, 3).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <p className="mv2-garden-assurance">旧引用自动 301 重定向不丢失，既有笔记、错题与母题连边将自动指向保留概念。</p>
      </div>
    );
  }

  if (category === 'cleanup_dangling_reference') {
    const reasonLabel = detail.danglingReason
      ? DANGLING_REASON_LABELS[detail.danglingReason] ?? detail.danglingReason
      : '引用断链';
    const chain = detail.redirectChain?.filter(Boolean) ?? [];
    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-meta-row">
          <span className="mv2-pill mv2-pill-weak">{reasonLabel}</span>
          {detail.holderTitle && <span className="mv2-origin-chip">所在节点：{detail.holderTitle}</span>}
          {detail.field && <span className="mv2-origin-chip">字段：{detail.field}</span>}
          {detail.resolvedTargetId && <span className="mv2-pill mv2-pill-steady">可改指至有效目标</span>}
        </div>
        {chain.length > 1 && <p className="mv2-garden-assurance">重定向链：{chain.join(' → ')}</p>}
        {!detail.resolvedTargetId && (
          <p className="mv2-garden-assurance">采纳后将安全清理失效断链标记，不会删除承载正文内容。</p>
        )}
      </div>
    );
  }

  if (category === 'stale_draft') {
    const kindLabel = detail.assetKind ? ASSET_KIND_LABELS[detail.assetKind] ?? detail.assetKind : '草稿';
    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-meta-row">
          <span className="mv2-origin-chip">{kindLabel}</span>
          {typeof detail.ageDays === 'number' && Number.isFinite(detail.ageDays) && (
            <span className="mv2-pill mv2-pill-due">已静置 {detail.ageDays} 天未使用</span>
          )}
        </div>
        <p className="mv2-garden-assurance">仅归档收纳未发布草稿，绝不执行永久删除，后续随时可恢复。</p>
      </div>
    );
  }

  if (category === 'propose_emergency_card') {
    const artifactLabel = detail.recommendedArtifact === 'decision_tree' ? '题型决策树' : '考前 3 分钟急救卡';
    const summaries = detail.noteSummaries?.filter(Boolean) ?? [];
    const targetKindLabel = detail.compressionTargetKind
      ? ASSET_KIND_LABELS[detail.compressionTargetKind] ?? detail.compressionTargetKind
      : '章节';
    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-meta-row">
          <span className="mv2-pill mv2-pill-steady">拟生成：{artifactLabel}</span>
          <span className="mv2-origin-chip">范围：{targetKindLabel}</span>
          {typeof detail.noteCount === 'number' && detail.noteCount > 0 && (
            <span className="mv2-pill mv2-pill-due">累计 {detail.noteCount} 条错因/碎笔记</span>
          )}
          {appendOnly && <span className="mv2-pill mv2-pill-rep">仅追加 · 不覆盖原稿</span>}
        </div>
        {summaries.length > 0 && (
          <ul className="mv2-garden-bullets">
            {summaries.slice(0, 4).map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        )}
        <p className="mv2-garden-assurance">
          {appendOnly
            ? '以追加草案方式生成急救卡，严格保留你的原始手写笔记与教材页面。'
            : '将高频错因与碎笔记压缩为考前速查要点，便于考前 3 分钟快速复盘。'}
        </p>
      </div>
    );
  }

  if (category === 'propose_split_coarse_concept') {
    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-meta-row">
          {typeof detail.linkedQuestionCount === 'number' && (
            <span className="mv2-pill mv2-pill-due">已关联 {detail.linkedQuestionCount} 道题</span>
          )}
          <span className="mv2-origin-chip">建议拆分为细粒度子概念</span>
        </div>
        <p className="mv2-garden-assurance">拆分后既有题目的概念映射会自动细分，提升薄弱点定位与母题聚合精度。</p>
      </div>
    );
  }

  return (
    <div className="mv2-garden-preview">
      <div className="mv2-garden-meta-row">
        {proposal.rawKind && <span className="mv2-origin-chip">类型：{proposal.rawKind}</span>}
        {proposal.targetIds.length > 0 && (
          <span className="mv2-origin-chip">涉及 {proposal.targetIds.length} 项记录</span>
        )}
      </div>
      <p className="mv2-garden-assurance">该项提案须经你确认后才会落地执行，绝不静默修改既有学习内容。</p>
    </div>
  );
}

function toDecision(proposal: NormalizedGardeningProposal, action: 'accept' | 'dismiss'): GardeningActionDecision {
  return {
    proposalId: proposal.proposalId,
    proposalKind: proposal.rawKind,
    category: proposal.category,
    action,
    ...(proposal.suggestedCommand ? { suggestedCommand: proposal.suggestedCommand } : {}),
    targetIds: proposal.targetIds,
  };
}

export function GardeningInboxPanel({
  plan: providedPlan,
  radar: providedRadar,
  endpoint: providedEndpoint,
  autoFetch,
  actionsEndpoint = DEFAULT_ACTIONS_ENDPOINT,
  undoEndpoint = DEFAULT_UNDO_ENDPOINT,
  compactWhenEmpty = false,
  defaultExpanded,
  onDecision,
  onBatchDecision,
  onUndo,
}: GardeningInboxPanelProps) {
  const hasInjectedData = providedPlan !== undefined || providedRadar !== undefined;
  const endpoint = providedEndpoint === undefined ? DEFAULT_GARDENING_ENDPOINT : providedEndpoint;
  const shouldAutoFetch =
    !hasInjectedData &&
    Boolean(endpoint) &&
    (autoFetch === true || (autoFetch !== false && Boolean(readTrimmed(providedEndpoint))));
  const [fetchedPlan, setFetchedPlan] = useState<GardeningInboxPlan | null>(null);
  const [endpointAvailable, setEndpointAvailable] = useState<boolean>(hasInjectedData);
  const [loading, setLoading] = useState<boolean>(false);
  const [resolvedDecisions, setResolvedDecisions] = useState<Record<string, 'accept' | 'dismiss'>>({});
  const [undoneActions, setUndoneActions] = useState<Record<string, true>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ readonly tone: 'soft' | 'error'; readonly text: string } | null>(null);
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded ?? true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setResolvedDecisions({});
    setUndoneActions({});
    setFeedback(null);
  }, [providedPlan, providedRadar, providedEndpoint]);

  const markResolved = useCallback((ids: readonly string[], action: 'accept' | 'dismiss') => {
    setResolvedDecisions((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = action;
      return next;
    });
  }, []);

  const loadFromEndpoint = useCallback(async () => {
    if (hasInjectedData || !endpoint) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const result = await fetchOptionalGardeningPlan(endpoint, controller.signal);
      if (controller.signal.aborted) return;
      setEndpointAvailable(result.available);
      setFetchedPlan(result.available ? result.data : null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [endpoint, hasInjectedData]);

  useEffect(() => {
    if (hasInjectedData) {
      setEndpointAvailable(true);
      return;
    }
    if (!shouldAutoFetch) {
      setEndpointAvailable(false);
      setFetchedPlan(null);
      return;
    }
    void loadFromEndpoint();
    return () => abortRef.current?.abort();
  }, [hasInjectedData, shouldAutoFetch, loadFromEndpoint]);

  const normalized = useMemo(
    () => normalizeGardeningInbox(hasInjectedData ? providedPlan : fetchedPlan, providedRadar),
    [fetchedPlan, hasInjectedData, providedPlan, providedRadar],
  );
  const pendingYellow = useMemo(
    () => normalized.yellow.filter((item) => resolvedDecisions[item.proposalId] === undefined),
    [normalized.yellow, resolvedDecisions],
  );
  const activeGreenCount = useMemo(
    () => normalized.green.filter((item) => !undoneActions[item.actionId]).length,
    [normalized.green, undoneActions],
  );

  const handleSingleDecision = useCallback(
    async (proposal: NormalizedGardeningProposal, action: 'accept' | 'dismiss') => {
      if (busyKey !== null) return;
      setBusyKey(`${action}:${proposal.proposalId}`);
      setFeedback(null);
      const decision = toDecision(proposal, action);
      try {
        if (onDecision) {
          await onDecision(decision);
        } else {
          const result = await postGardeningJsonAction(actionsEndpoint, {
            requestId: requestId(),
            action,
            proposalId: decision.proposalId,
            proposalKind: decision.proposalKind,
            suggestedCommand: decision.suggestedCommand,
            targetIds: decision.targetIds,
          });
          if (!result.ok) {
            setFeedback({ tone: 'error', text: result.message });
            return;
          }
        }
        markResolved([proposal.proposalId], action);
        setFeedback({
          tone: 'soft',
          text: action === 'accept' ? `已采纳提案：${proposal.title}` : `已忽略提案：${proposal.title}`,
        });
      } catch (failure) {
        setFeedback({
          tone: 'error',
          text: failure instanceof Error ? failure.message : '操作未能完成，请稍后重试。',
        });
      } finally {
        setBusyKey(null);
      }
    },
    [actionsEndpoint, busyKey, markResolved, onDecision],
  );

  const handleBatchDecision = useCallback(
    async (action: 'accept' | 'dismiss') => {
      if (busyKey !== null || pendingYellow.length === 0) return;
      setBusyKey(`batch:${action}`);
      setFeedback(null);
      const decisions = pendingYellow.map((proposal) => toDecision(proposal, action));
      try {
        if (onBatchDecision) {
          await onBatchDecision(decisions);
          markResolved(decisions.map((d) => d.proposalId), action);
        } else if (onDecision) {
          const succeededIds: string[] = [];
          let firstError: string | null = null;
          for (const decision of decisions) {
            try {
              await onDecision(decision);
              succeededIds.push(decision.proposalId);
            } catch (itemFailure) {
              firstError = itemFailure instanceof Error ? itemFailure.message : '批量操作部分未能完成，请稍后重试。';
              break;
            }
          }
          if (succeededIds.length > 0) markResolved(succeededIds, action);
          if (firstError !== null) {
            setFeedback({
              tone: 'error',
              text:
                succeededIds.length > 0
                  ? `已完成 ${succeededIds.length} / ${decisions.length} 条，后续中断：${firstError}`
                  : firstError,
            });
            return;
          }
        } else {
          const result = await postGardeningJsonAction(actionsEndpoint, {
            requestId: requestId(),
            batch: true,
            action,
            proposals: decisions.map(({ proposalId, proposalKind, suggestedCommand, targetIds }) => ({
              proposalId,
              proposalKind,
              suggestedCommand,
              targetIds,
            })),
          });
          if (!result.ok) {
            setFeedback({ tone: 'error', text: result.message });
            return;
          }
          markResolved(decisions.map((d) => d.proposalId), action);
        }
        setFeedback({
          tone: 'soft',
          text:
            action === 'accept'
              ? `已全部采纳 ${decisions.length} 条黄灯园艺提案。`
              : `已清空忽略 ${decisions.length} 条黄灯园艺提案。`,
        });
      } catch (failure) {
        setFeedback({
          tone: 'error',
          text: failure instanceof Error ? failure.message : '批量操作未能完成，请稍后重试。',
        });
      } finally {
        setBusyKey(null);
      }
    },
    [actionsEndpoint, busyKey, markResolved, onBatchDecision, onDecision, pendingYellow],
  );

  const handleUndo = useCallback(
    async (action: NormalizedGardeningGreenAction) => {
      if (busyKey !== null || undoneActions[action.actionId]) return;
      setBusyKey(`undo:${action.actionId}`);
      setFeedback(null);
      try {
        if (onUndo) {
          await onUndo(action);
        } else {
          const result = await postGardeningJsonAction(undoEndpoint, {
            requestId: requestId(),
            actionId: action.actionId,
            undo_token: action.undoToken,
          });
          if (!result.ok) {
            setFeedback({ tone: 'error', text: result.message });
            return;
          }
        }
        setUndoneActions((prev) => ({ ...prev, [action.actionId]: true }));
        setFeedback({ tone: 'soft', text: `已撤回自动处理：${action.title}` });
      } catch (failure) {
        setFeedback({
          tone: 'error',
          text: failure instanceof Error ? failure.message : '未能撤回该条自动处理，请稍后重试。',
        });
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, onUndo, undoEndpoint, undoneActions],
  );

  const hasAnyItems = pendingYellow.length > 0 || normalized.green.length > 0 || normalized.red.length > 0;

  if (compactWhenEmpty) {
    if (!hasInjectedData && !endpointAvailable && !loading) return null;
    if (!hasAnyItems && !feedback) {
      if (loading) return null;
      return (
        <div className="mv2-garden-compact" role="region" aria-label="知识园艺状态">
          <span className="mv2-garden-compact-copy">
            <GardenSparkIcon />
            <span>知识园艺 · 当前无待审黄灯提案</span>
          </span>
          {!hasInjectedData && endpoint && (
            <button type="button" className="mv2-inline-link" onClick={() => void loadFromEndpoint()}>
              重新扫描
            </button>
          )}
        </div>
      );
    }
  }

  return (
    <section className="mv2-garden" aria-label="知识园艺待审箱">
      <header className="mv2-garden-head">
        <div className="mv2-garden-title-group">
          <div className="mv2-garden-badges">
            <span className="mv2-garden-lamp mv2-garden-lamp-yellow">
              <GardenSparkIcon />
              <span>黄灯园艺待审箱</span>
            </span>
            {pendingYellow.length > 0 && (
              <span className="mv2-pill mv2-pill-due">{pendingYellow.length} 项待确认</span>
            )}
            {normalized.green.length > 0 && (
              <span className="mv2-pill mv2-pill-steady">绿灯自动处理 {activeGreenCount}</span>
            )}
            {normalized.red.length > 0 && (
              <span className="mv2-pill mv2-pill-weak">红灯守护 {normalized.red.length}</span>
            )}
            {normalized.generatedAt && (
              <span className="mv2-anchor-date">巡检 {normalized.generatedAt}</span>
            )}
          </div>
          <p className="mv2-garden-subtitle">
            系统自动巡检重复概念、断链引用与碎笔记沉淀；绿灯动作可随时撤回，黄灯变更须你确认后才落地。
          </p>
        </div>

        <div className="mv2-garden-head-actions">
          {pendingYellow.length > 0 && expanded && (
            <>
              <button
                type="button"
                className="mv2-btn mv2-btn-primary mv2-btn-sm"
                disabled={busyKey !== null}
                onClick={() => void handleBatchDecision('accept')}
              >
                {busyKey === 'batch:accept' ? '正在采纳…' : `全部采纳 (${pendingYellow.length})`}
              </button>
              <button
                type="button"
                className="mv2-btn mv2-btn-ghost mv2-btn-sm"
                disabled={busyKey !== null}
                onClick={() => void handleBatchDecision('dismiss')}
              >
                {busyKey === 'batch:dismiss' ? '正在忽略…' : '清空忽略'}
              </button>
            </>
          )}
          <button
            type="button"
            className="mv2-btn mv2-btn-ghost mv2-btn-sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            <span>{expanded ? '收起待审箱' : '展开待审箱'}</span>
            <span className="mv2-garden-chevron" data-open={expanded ? 'true' : 'false'}>
              <Icon name="chevron" />
            </span>
          </button>
        </div>
      </header>

      {feedback && (
        <div
          className={`mv2-notice ${feedback.tone === 'error' ? 'mv2-notice-error' : 'mv2-notice-soft'}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{feedback.text}</span>
        </div>
      )}

      {expanded && (
        <div className="mv2-garden-body">
          {loading && !hasAnyItems ? (
            <div className="mv2-garden-empty" role="status">
              <p className="mv2-muted">正在巡检知识库健康度…</p>
            </div>
          ) : pendingYellow.length > 0 ? (
            <ul className="mv2-garden-list">
              {pendingYellow.map((proposal) => {
                const meta = CATEGORY_META[proposal.category];
                return (
                  <li key={proposal.proposalId} className="mv2-garden-card">
                    <div className="mv2-garden-card-top">
                      <span className={`mv2-pill ${CATEGORY_TONE_CLASS[meta.tone]}`}>{meta.label}</span>
                      {proposal.appendOnly && <span className="mv2-pill mv2-pill-rep">Append-Only</span>}
                    </div>
                    <h3 className="mv2-garden-card-title">{proposal.title}</h3>
                    {proposal.summary && <p className="mv2-garden-card-summary">{proposal.summary}</p>}
                    <ProposalDetailPreview proposal={proposal} />
                    <div className="mv2-item-actions">
                      <button
                        type="button"
                        className="mv2-btn mv2-btn-primary mv2-btn-sm"
                        disabled={busyKey !== null}
                        onClick={() => void handleSingleDecision(proposal, 'accept')}
                      >
                        {busyKey === `accept:${proposal.proposalId}` ? '正在采纳…' : '采纳'}
                      </button>
                      <button
                        type="button"
                        className="mv2-btn mv2-btn-ghost mv2-btn-sm"
                        disabled={busyKey !== null}
                        onClick={() => void handleSingleDecision(proposal, 'dismiss')}
                      >
                        {busyKey === `dismiss:${proposal.proposalId}` ? '正在忽略…' : '忽略'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mv2-garden-empty">
              <p className="mv2-muted">
                {!hasInjectedData && !endpointAvailable
                  ? '知识园艺巡检服务暂未连接，当前无待审项。'
                  : normalized.yellow.length > 0
                    ? '本轮黄灯待审提案已全部处理完毕。'
                    : '知识矿山状态清爽，当前没有需要人工确认的黄灯提案。'}
              </p>
              {!hasInjectedData && endpoint && (
                <button type="button" className="mv2-inline-link" onClick={() => void loadFromEndpoint()}>
                  重新巡检
                </button>
              )}
            </div>
          )}

          {normalized.green.length > 0 && (
            <details className="mv2-garden-details">
              <summary>
                <span className="mv2-pill mv2-pill-steady">绿灯</span>
                <span>绿灯已自动处理记录（{normalized.green.length}）</span>
              </summary>
              <ul className="mv2-garden-log-list">
                {normalized.green.map((action) => {
                  const undone = Boolean(undoneActions[action.actionId]);
                  const previewLine = formatGreenPreview(action);
                  return (
                    <li key={action.actionId} className="mv2-garden-log-item" data-undone={undone ? 'true' : 'false'}>
                      <div className="mv2-garden-log-copy">
                        <div className="mv2-card-meta">
                          <span className="mv2-pill mv2-pill-steady">
                            {GREEN_ACTION_LABELS[action.actionKind] ?? '自动维护'}
                          </span>
                          {action.targetKind && (
                            <span className="mv2-origin-chip">
                              {ASSET_KIND_LABELS[action.targetKind] ?? action.targetKind}
                            </span>
                          )}
                          {undone && <span className="mv2-pill mv2-pill-unknown">已撤回</span>}
                        </div>
                        <p className="mv2-garden-log-title">{action.title}</p>
                        {action.reason && <p className="mv2-garden-log-reason">{action.reason}</p>}
                        {previewLine && <p className="mv2-garden-log-preview">{previewLine}</p>}
                      </div>
                      <button
                        type="button"
                        className="mv2-btn mv2-btn-ghost mv2-btn-sm"
                        disabled={undone || busyKey !== null || !action.undoToken}
                        data-undo-token={action.undoToken}
                        onClick={() => void handleUndo(action)}
                      >
                        <UndoIcon />
                        <span>{undone ? '已撤回' : busyKey === `undo:${action.actionId}` ? '撤回中…' : '撤回'}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {normalized.red.length > 0 && (
            <details className="mv2-garden-details mv2-garden-red-details">
              <summary>
                <span className="mv2-pill mv2-pill-weak">
                  <ShieldIcon />
                  <span>红灯守护</span>
                </span>
                <span>红灯保护已拦截记录（{normalized.red.length}）</span>
              </summary>
              <ul className="mv2-garden-log-list">
                {normalized.red.map((guard) => (
                  <li key={guard.guardId} className="mv2-garden-log-item">
                    <div className="mv2-garden-log-copy">
                      <div className="mv2-card-meta">
                        <span className="mv2-pill mv2-pill-weak">
                          {RED_RULE_LABELS[guard.rule] ?? guard.rule}
                        </span>
                        {guard.assetKind && (
                          <span className="mv2-origin-chip">
                            {ASSET_KIND_LABELS[guard.assetKind] ?? guard.assetKind}
                          </span>
                        )}
                        <span className="mv2-origin-chip">已拦截：{guard.blockedAction}</span>
                      </div>
                      <p className="mv2-garden-log-title">{guard.title}</p>
                      <p className="mv2-garden-log-reason">{guard.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {normalized.excludedCount > 0 && (
            <p className="mv2-garden-footnote">
              本次巡检已依隐私授权自动排除 {normalized.excludedCount} 条已撤回或未授权记录。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
