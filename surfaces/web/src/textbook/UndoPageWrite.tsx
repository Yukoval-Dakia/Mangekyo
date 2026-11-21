import { useState } from 'react';
import { api, ApiError } from '../api';

type Outcome = 'withdrawn' | 'reverted';
export function UndoPageWrite({id, rev, token, onUndo}: {
  id: string; rev: number; token: string; onUndo?: (status: Outcome) => void;
}) {
  const [outcome, setOutcome] = useState<Outcome>();
  const [busy, pending] = useState(false);
  const [error, report] = useState('');

  async function undo() {
    if (busy || outcome) return;
    pending(true);
    report('');
    try {
      const receipt = await api<{ status: 'withdrawn' | 'reverted'; ref: { id: string; rev: number } }>(
        '/textbooks/' + encodeURIComponent(id) + '/undo', { method: 'POST', body: { undo_token: token } });
      if (!['withdrawn', 'reverted'].includes(receipt.status) || receipt.ref.id !== id || !Number.isSafeInteger(receipt.ref.rev) || receipt.ref.rev <= rev)
        throw new Error('教材撤回回执不符。');
      setOutcome(receipt.status);
      onUndo?.(receipt.status);
    } catch (cause) {
      report(cause instanceof ApiError && cause.status === 409 ? '教材已变更。请刷新查看回执状态。' :
        '暂时无法确认撤回结果，请重试。');
    } finally {
      pending(false);
    }
  }
  return outcome ? <span role="status">{outcome === 'withdrawn' ? '新建教材页已撤回' : '修改已撤回，已恢复先前内容'}</span> : <>
    <button className="tonal-button" disabled={busy} onClick={undo}>{busy ? '正在撤回…' : '撤回教材写入'}</button>
    {error && <span role="alert">{error}</span>}
  </>;
}
