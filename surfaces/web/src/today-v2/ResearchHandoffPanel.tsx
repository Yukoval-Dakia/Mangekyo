import { useState } from 'react';
import { api, ApiError, requestId, runResearchMaintenance } from '../api';
import { Icon } from '../icons';
import { BreathDot, Chip, Dot, handleSpaNavigation, isTechnicalIdentifier } from './shared';

export type PanelProposal = {
  id: string;
  kind: string;
  status: string;
  title: string;
  summary: string;
  actions?: {
    accept?: { method: 'POST'; path: string; body?: Record<string, unknown> };
    reject?: { method: 'POST'; path: string; body?: Record<string, unknown> };
  };
};

export type PanelHandoff = {
  id: string;
  channel: string;
  status: string;
  title: string;
  summary: string;
  basisCount?: number;
  href?: string | null;
};

export type MaintenanceRunResult =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'success'; message: string; prepNoteId?: string | null }
  | { state: 'unavailable'; message: string }
  | { state: 'error'; message: string };

function stripApiPrefix(path: string): string {
  return path.startsWith('/api/') ? path.slice(4) : path;
}

function proposalKindLabel(kind: string | undefined): string {
  switch (kind) {
    case 'relation':
    case 'knowledge_edge':
      return '图谱连边';
    case 'graph_evolution':
    case 'knowledge_evolution':
      return '图谱演进';
    case 'question_meta':
    case 'iqdb':
      return '题库元信息';
    case 'textbook':
    case 'textbook_revision':
      return '教材修订';
    default:
      return '学习建议';
  }
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || isTechnicalIdentifier(trimmed)) return '';
  return trimmed;
}

function maintenanceMessage(result: {
  ran: boolean;
  reason: string;
  rationale?: string;
  proposedEdges: number;
  prepNoteId?: string | null;
}): string {
  const parts: string[] = [];
  if (result.proposedEdges > 0) {
    parts.push(`已提出 ${result.proposedEdges} 条知识关联边待确认`);
  }
  if (result.prepNoteId) {
    parts.push('并备好 1 份复习观察');
  }
  if (parts.length === 0) {
    const reason = cleanText(result.rationale) || cleanText(result.reason);
    return reason ? `当前知识库状态良好，暂无需新增维护（${reason}）。` : '当前知识库状态良好，暂无需新增维护。';
  }
  return parts.join('，') + '。';
}

export function ResearchHandoffPanel({
  pendingProposals,
  handoffs,
  runningCount,
  canRunMaintenance,
  onOpenAiActivity,
  onNavigate,
  onRefresh,
}: {
  pendingProposals: readonly PanelProposal[];
  handoffs: readonly PanelHandoff[];
  runningCount: number;
  canRunMaintenance: boolean;
  onOpenAiActivity?: (() => void) | undefined;
  onNavigate?: ((href: string) => void) | undefined;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busyProposalId, setBusyProposalId] = useState('');
  const [proposalError, setProposalError] = useState('');
  const [proposalNote, setProposalNote] = useState('');
  const [maintenance, setMaintenance] = useState<MaintenanceRunResult>({ state: 'idle' });

  const visibleProposals = pendingProposals
    .filter((item) => item && item.status === 'pending')
    .filter((item) => cleanText(item.title) || cleanText(item.summary));

  const visibleHandoffs = handoffs
    .filter((item) => item && (cleanText(item.title) || cleanText(item.summary)))
    .slice(0, 2);

  const displayed = expanded ? visibleProposals : visibleProposals.slice(0, 3);
  const extraCount = Math.max(0, visibleProposals.length - 3);
  const busyMaintenance = maintenance.state === 'running';
  const busy = busyProposalId !== '' || busyMaintenance;

  const hasBody =
    visibleProposals.length > 0 ||
    visibleHandoffs.length > 0 ||
    runningCount > 0 ||
    maintenance.state !== 'idle' ||
    canRunMaintenance;

  if (!hasBody) return null;

  async function invokeProposal(proposal: PanelProposal, action: 'accept' | 'reject') {
    if (busyProposalId) return;
    const spec = proposal.actions?.[action];
    if (!spec || spec.method !== 'POST' || typeof spec.path !== 'string' || !spec.path) return;
    setBusyProposalId(proposal.id);
    setProposalError('');
    setProposalNote('');
    try {
      const body: Record<string, unknown> = { ...(spec.body ?? {}) };
      if (typeof body.requestId !== 'string' || !body.requestId) body.requestId = requestId();
      await api(stripApiPrefix(spec.path), { method: 'POST', body });
      setProposalNote(action === 'accept' ? '已采纳该条建议。' : '已忽略该条建议。');
      onRefresh();
    } catch (failure) {
      setProposalError(
        failure instanceof ApiError && failure.message
          ? failure.message
          : '这条建议暂时未能处理，请重试。',
      );
    } finally {
      setBusyProposalId('');
    }
  }

  async function triggerMaintenance() {
    if (busy) return;
    setMaintenance({ state: 'running' });
    setProposalError('');
    setProposalNote('');
    try {
      const result = await runResearchMaintenance();
      setMaintenance({
        state: 'success',
        message: maintenanceMessage(result),
        ...(result.prepNoteId ? { prepNoteId: result.prepNoteId } : {}),
      });
      onRefresh();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        setMaintenance({
          state: 'unavailable',
          message: '后台知识库自主巡检服务尚未启用，稍后即可使用。',
        });
      } else {
        setMaintenance({
          state: 'error',
          message:
            failure instanceof ApiError && failure.message
              ? failure.message
              : '巡检未能完成，请稍后再试。',
        });
      }
    }
  }

  const headMeta: string[] = [];
  if (visibleProposals.length > 0) headMeta.push(`${visibleProposals.length} 条待确认`);
  if (visibleHandoffs.length > 0) headMeta.push(`${visibleHandoffs.length} 份新成果`);
  if (runningCount > 0) headMeta.push(`${runningCount} 项进行中`);

  return (
    <section className="tv2-research" aria-label="后台教研交班">
      <div className="tv2-research-head">
        <div className="tv2-research-title">
          {runningCount > 0 ? <BreathDot /> : <Dot />}
          <div className="tv2-research-title-copy">
            <strong>后台教研交班</strong>
            {headMeta.length > 0 && <span className="tv2-research-meta">{headMeta.join(' · ')}</span>}
          </div>
        </div>
        <div className="tv2-research-tools">
          {canRunMaintenance && (
            <button
              type="button"
              className="tv2-btn tv2-btn--tonal tv2-btn--sm"
              disabled={busy}
              onClick={() => void triggerMaintenance()}
            >
              {busyMaintenance ? '正在巡检…' : '立即巡检知识库'}
            </button>
          )}
          {onOpenAiActivity && (
            <button
              type="button"
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              onClick={onOpenAiActivity}
            >
              查看运作明细
            </button>
          )}
        </div>
      </div>

      {busyMaintenance && (
        <div className="tv2-research-status" role="status">
          <BreathDot />
          <span>教研团正在巡检知识图谱与近期学习记录…</span>
        </div>
      )}

      {(maintenance.state === 'success' ||
        maintenance.state === 'unavailable' ||
        maintenance.state === 'error') && (
        <div
          className={
            'tv2-research-status' +
            (maintenance.state === 'error' ? ' tv2-research-status--problem' : '')
          }
          role={maintenance.state === 'error' ? 'alert' : 'status'}
        >
          <Dot tone={maintenance.state === 'error' ? 'amber' : 'forest'} />
          <span className="tv2-research-status-copy">
            <span>{maintenance.message}</span>
            {maintenance.state === 'success' && maintenance.prepNoteId && (
              <a
                className="tv2-research-link"
                href={`/materials/records/${encodeURIComponent(maintenance.prepNoteId)}`}
                onClick={(event) =>
                  handleSpaNavigation(
                    event,
                    `/materials/records/${encodeURIComponent(maintenance.prepNoteId!)}`,
                    onNavigate,
                  )
                }
              >
                查看备课观察 →
              </a>
            )}
          </span>
        </div>
      )}

      {proposalNote && (
        <div className="tv2-research-status" role="status">
          <Dot />
          <span>{proposalNote}</span>
        </div>
      )}
      {proposalError && (
        <div className="tv2-research-status tv2-research-status--problem" role="alert">
          <Dot tone="amber" />
          <span>{proposalError}</span>
        </div>
      )}

      {visibleProposals.length > 0 && (
        <ul className="m3e-seg-list tv2-research-list" aria-label="待确认的教研建议">
          {displayed.map((proposal) => {
            const title = cleanText(proposal.title);
            const summary = cleanText(proposal.summary);
            const showSummary = Boolean(summary && summary !== title);
            const canAccept = Boolean(
              proposal.actions?.accept &&
                proposal.actions.accept.method === 'POST' &&
                proposal.actions.accept.path,
            );
            const canReject = Boolean(
              proposal.actions?.reject &&
                proposal.actions.reject.method === 'POST' &&
                proposal.actions.reject.path,
            );
            const proposalBusy = busyProposalId === proposal.id;
            return (
              <li className="m3e-seg-item tv2-research-item" key={proposal.id}>
                <div className="tv2-research-item-copy">
                  <div className="tv2-research-item-head">
                    <strong>{title || summary || '一条待确认建议'}</strong>
                    <Chip tone="neutral">{proposalKindLabel(proposal.kind)}</Chip>
                  </div>
                  {showSummary && <p className="tv2-research-item-summary">{summary}</p>}
                </div>
                {(canAccept || canReject) && (
                  <div className="tv2-research-item-actions">
                    {canAccept && (
                      <button
                        type="button"
                        className="tv2-btn tv2-btn--tonal tv2-btn--sm"
                        disabled={busy}
                        onClick={() => void invokeProposal(proposal, 'accept')}
                      >
                        {proposalBusy ? '处理中…' : '采纳'}
                      </button>
                    )}
                    {canReject && (
                      <button
                        type="button"
                        className="tv2-btn tv2-btn--ghost tv2-btn--sm"
                        disabled={busy}
                        onClick={() => void invokeProposal(proposal, 'reject')}
                      >
                        忽略
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {extraCount > 0 && (
        <div className="tv2-research-more">
          <button
            type="button"
            className="tv2-btn tv2-btn--ghost tv2-btn--sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? '收起' : `展开全部 ${visibleProposals.length} 条`}
          </button>
          {onOpenAiActivity && (
            <button
              type="button"
              className="tv2-btn tv2-btn--ghost tv2-btn--sm"
              onClick={onOpenAiActivity}
            >
              查看全部
            </button>
          )}
        </div>
      )}

      {visibleHandoffs.length > 0 && (
        <div className="tv2-research-handoffs" aria-label="后台刚备好的成果">
          {visibleHandoffs.map((item) => {
            const title = cleanText(item.title);
            const summary = cleanText(item.summary);
            const heading = title || summary || '一份教研成果';
            const meta: string[] = [];
            if (typeof item.basisCount === 'number' && item.basisCount > 0) {
              meta.push(`依据 ${item.basisCount} 条`);
            }
            const href =
              typeof item.href === 'string' && item.href.startsWith('/') && !item.href.startsWith('/api/')
                ? item.href
                : null;
            return (
              <div className="tv2-research-handoff" key={item.id}>
                {href ? (
                  <a
                    className="tv2-research-handoff-link"
                    href={href}
                    onClick={(event) => handleSpaNavigation(event, href, onNavigate)}
                  >
                    <strong>{heading}</strong>
                    <Icon name="chevron" />
                  </a>
                ) : (
                  <strong className="tv2-research-handoff-heading">{heading}</strong>
                )}
                {summary && summary !== heading && (
                  <span className="tv2-research-handoff-summary">{summary}</span>
                )}
                {meta.length > 0 && <span className="tv2-research-handoff-meta">{meta.join(' · ')}</span>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
