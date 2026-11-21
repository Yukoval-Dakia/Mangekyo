import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Icon } from '../icons';
import type { DataSovereigntyPanelProps } from './types';

type CareSupport = {
  paused?: boolean;
  pausedUntil?: string | null;
  reason?: string | null;
};

function useCareSupport() {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'unsupported'>('loading');
  const [support, setSupport] = useState<CareSupport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(signal?: AbortSignal) {
    try {
      const result = await api<CareSupport>('/care/support', signal ? { signal, cache: 'no-store' } : { cache: 'no-store' });
      if (signal?.aborted) return;
      setSupport(result);
      setState('ready');
    } catch (failure) {
      if (signal?.aborted) return;
      if (failure instanceof ApiError && failure.status === 404) setState('unsupported');
      else setState('unavailable');
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function resume() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/care/pause/resume', { method: 'POST', body: {} });
      await load();
    } catch {
      setError('恢复尚未被确认，请稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  return { state, support, busy, error, resume };
}

function DataPurposeCard() {
  return (
    <article className="me-v2-card" aria-labelledby="me-v2-purpose">
      <div className="me-v2-card-head">
        <div>
          <h3 id="me-v2-purpose">默认用途与仅保存权限</h3>
          <p className="me-v2-card-sub">新材料默认「仅保存」。在学习设置里可逐条查看与收窄授权。</p>
        </div>
      </div>
      <p className="me-v2-copy">
        同伴对你的理解来自已获准的学习活动。你可以随时在「学习设置 → 访问与授权」中查看每个来源的用途，
        或收窄为「仅保存」。
      </p>
      <p className="me-v2-foot">当前默认：<strong>仅保存</strong>（D06）</p>
    </article>
  );
}

function NotionCard({ render }: { render?: (() => React.ReactNode) | undefined }) {
  return (
    <article className="me-v2-card" aria-labelledby="me-v2-notion">
      <div className="me-v2-card-head">
        <div>
          <h3 id="me-v2-notion">Notion 只读连接与选源</h3>
          <p className="me-v2-card-sub">授权后，只读来源可用于备课。撤销或收窄立即生效。</p>
        </div>
      </div>
      {render ? (
        <div className="me-v2-slot">{render()}</div>
      ) : (
        <p className="me-v2-empty-inline">
          Notion 授权面板尚未装配；装配后可在这里授予、查看或撤销只读来源。
        </p>
      )}
    </article>
  );
}

function ErasureCard({ render }: { render?: (() => React.ReactNode) | undefined }) {
  const { state, support, busy, error, resume } = useCareSupport();
  return (
    <article className="me-v2-card" aria-labelledby="me-v2-erasure">
      <div className="me-v2-card-head">
        <div>
          <h3 id="me-v2-erasure">导出、删除与安心暂停</h3>
          <p className="me-v2-card-sub">你可随时导出全部数据、发起不可逆永久删除，或安心暂停后台教研。</p>
        </div>
      </div>
      {state === 'ready' && support?.paused && (
        <div className="me-v2-pause" role="status">
          <p>
            <Icon name="lock" /> 当前处于「安心暂停」状态，后台教研与催练已停止。
            {support.pausedUntil && ` 预计至 ${new Date(support.pausedUntil).toLocaleString()}。`}
          </p>
          <button type="button" className="me-v2-tonal" disabled={busy} onClick={() => void resume()}>
            {busy ? '正在恢复…' : '恢复后台教研与催练'}
          </button>
          {error && <p role="alert" className="me-v2-alert">{error}</p>}
        </div>
      )}
      {render ? (
        <div className="me-v2-slot">{render()}</div>
      ) : (
        <p className="me-v2-empty-inline">
          导出与删除面板尚未装配；装配后可在这里导出数据或发起永久删除。
        </p>
      )}
    </article>
  );
}

export function DataSovereigntyPanel({ renderNotionSettings, renderErasure }: DataSovereigntyPanelProps) {
  return (
    <div className="me-v2-stack">
      <DataPurposeCard />
      <NotionCard render={renderNotionSettings} />
      <ErasureCard render={renderErasure} />
    </div>
  );
}
