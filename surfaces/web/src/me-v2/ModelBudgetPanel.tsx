import { useEffect, useState } from 'react';
import { api, ApiError, requestId } from '../api';
import { Icon } from '../icons';
import { taskLabels, type ModelTask } from '../model-route';
import type { ModelBudgetPanelProps } from './types';

type ResearchReceipt = {
  revision: number;
  enabled: boolean;
  scoutBudget?: { route: string; limitMicros: number; maxPerCallMicros: number; maxRetentionDays: number; expiresAtMs: number } | null;
  settledUsdMicros?: string;
  heldUsdMicros?: string;
};

function useResearchSettings() {
  const [receipt, setReceipt] = useState<ResearchReceipt>();
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load(signal?: AbortSignal) {
    try {
      const result = await api<ResearchReceipt>('/research/settings', signal ? { signal, cache: 'no-store' } : { cache: 'no-store' });
      if (!signal?.aborted) setReceipt(result);
    } catch {
      if (!signal?.aborted) setReadFailed(true);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function toggle(enabled: boolean) {
    if (!receipt || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const updated = await api<ResearchReceipt>('/research/settings', {
        method: 'PUT',
        body: { revision: receipt.revision, enabled, scoutBudget: enabled ? receipt.scoutBudget ?? null : null, requestId: requestId() },
      });
      setReceipt(updated);
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 409
        ? '版本已更新，请刷新后重试。'
        : '未能确认保存结果。请稍后重试。');
      void load();
    } finally {
      setBusy(false);
    }
  }

  return { receipt, readFailed, busy, message, toggle, reload: () => void load() };
}

function CompanionModelCard({ settings, onOpenSettings }: { settings: ModelBudgetPanelProps['settings']; onOpenSettings: (() => void) | undefined }) {
  const active = settings?.providers.find(p => p.id === settings.activeProviderId);
  return (
    <article className="me-v2-card" aria-labelledby="me-v2-model">
      <div className="me-v2-card-head">
        <div>
          <h3 id="me-v2-model">前台同伴模型</h3>
          <p className="me-v2-card-sub">对话、备课、诊断与批改使用的模型提供方。</p>
        </div>
        {onOpenSettings && (
          <button type="button" className="me-v2-pill-button" onClick={onOpenSettings}>
            <Icon name="settings" /> 打开详细设置
          </button>
        )}
      </div>
      {settings ? (
        <>
          <p className="me-v2-copy">
            当前使用：<strong>{active?.label || active?.model || '未命名配置'}</strong>
            {active?.model && ` · ${active.model}`}
            {settings.reasoningEffort && settings.reasoningEffort !== 'default' && ` · 思考强度 ${settings.reasoningEffort}`}
          </p>
          {settings.routes && Object.keys(settings.routes).length > 0 && (
            <ul className="me-v2-routes">
              {(Object.entries(taskLabels) as [ModelTask, string][]).map(([task, label]) => {
                const routed = settings.routes?.[task];
                const name = routed
                  ? (settings.providers.find(p => p.id === routed)?.label || settings.providers.find(p => p.id === routed)?.model || '未命名')
                  : '跟随当前模型';
                return <li key={task}><span>{label}</span><strong>{name}</strong></li>;
              })}
            </ul>
          )}
          <p className="me-v2-foot">修改模型、密钥、按用途分配与 MCP 服务，请打开详细设置。</p>
        </>
      ) : (
        <div className="me-v2-empty">
          <h3>尚未配置模型</h3>
          <p>本地离线、基础复习与已保存材料仍可照常使用。配置同伴模型后，对话与备课体验会更完整。</p>
          {onOpenSettings && (
            <button type="button" className="me-v2-tonal" onClick={onOpenSettings}>
              去配置同伴模型
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function ResearchBudgetCard() {
  const { receipt, readFailed, busy, message, toggle, reload } = useResearchSettings();
  return (
    <article className="me-v2-card" aria-labelledby="me-v2-budget">
      <div className="me-v2-card-head">
        <div>
          <h3 id="me-v2-budget">后台教研与维护双预算</h3>
          <p className="me-v2-card-sub">后台教研（复习单、摘要、前哨）与例行维护共享一条预算上限。</p>
        </div>
      </div>
      {readFailed ? (
        <div className="me-v2-empty">
          <p>暂时无法读取预算状态。</p>
          <button type="button" className="me-v2-tonal" onClick={reload}>重新读取</button>
        </div>
      ) : !receipt ? (
        <p className="me-v2-empty-inline">正在读取预算状态…</p>
      ) : (
        <>
          <label className="me-v2-check">
            <input
              type="checkbox"
              checked={receipt.enabled}
              disabled={busy}
              onChange={e => void toggle(e.target.checked)}
            />
            <span>
              <strong>启用后台教研</strong>
              <small>关闭时同时撤回付费前哨授权；本地离线仍可正常复习。</small>
            </span>
          </label>
          {receipt.scoutBudget && (
            <dl className="me-v2-budget-detail">
              <div><dt>接收方</dt><dd>{receipt.scoutBudget.route}</dd></div>
              <div><dt>累计上限</dt><dd>{receipt.scoutBudget.limitMicros} USD 微元</dd></div>
              <div><dt>单次上限</dt><dd>{receipt.scoutBudget.maxPerCallMicros} USD 微元</dd></div>
              <div><dt>留存上限</dt><dd>{receipt.scoutBudget.maxRetentionDays} 天</dd></div>
              <div><dt>到期</dt><dd>{new Date(receipt.scoutBudget.expiresAtMs).toLocaleString()}</dd></div>
            </dl>
          )}
          {(receipt.settledUsdMicros !== undefined || receipt.heldUsdMicros !== undefined) && (
            <p className="me-v2-foot">
              前哨累计实付 {receipt.settledUsdMicros ?? '0'} USD 微元，待核占用 {receipt.heldUsdMicros ?? '0'} USD 微元。
            </p>
          )}
          <p className="me-v2-foot">详细的每次开放授权与额度配置，请打开「学习设置 → 后台教研」。</p>
        </>
      )}
      {message && <p role="alert" className="me-v2-alert">{message}</p>}
    </article>
  );
}

export function ModelBudgetPanel({ settings, onOpenSettings }: ModelBudgetPanelProps) {
  return (
    <div className="me-v2-stack">
      <CompanionModelCard settings={settings} onOpenSettings={onOpenSettings} />
      <ResearchBudgetCard />
    </div>
  );
}
