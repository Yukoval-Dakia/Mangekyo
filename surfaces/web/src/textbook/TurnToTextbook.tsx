import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { UndoPageWrite } from './UndoPageWrite';

import type { TurnPagePreview as Preview, TurnPageReceipt as Receipt } from '../../../shared/textbook-request';

export function TurnToTextbook({id}: {id:string}) {
  const [preview, setPreview] = useState<Preview>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [undone, setUndone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const path = '/study-turns/' + encodeURIComponent(id) + '/textbook';
  useEffect(() => {
    if (!preview || pending) return;
    const controller = new AbortController();
    const hide = () => { if (document.hidden) setPreview(undefined); };
    const timer = setTimeout(async () => {
      try {
        const current = await api<Preview>(path, {method:'POST', body:{action:'preview'}, signal:controller.signal});
        if (!controller.signal.aborted) setPreview(current.confirmationId === preview.confirmationId ? current : undefined);
      } catch {
        if (!controller.signal.aborted) setPreview(undefined);
      }
    }, 5000);
    document.addEventListener('visibilitychange', hide);
    return () => {
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', hide);
    };
  }, [preview, pending, path]);
  async function submit() {
    setPending(true);
    setError('');
    try {
      if (!preview) setPreview(await api<Preview>(path,{method:'POST', body:{action:'preview'}}));
      else {
        const result = await api<Receipt>(path,{method:'POST', body:{action:'confirm', page:preview.page, confirmationId:preview.confirmationId}});
        if (result.status !== 'applied' || result.ref.id !== preview.page || result.ref.rev !== preview.rev + 1 || !result.undo_token)
          throw new Error('暂时无法确认教材写入回执，请重试。');
        setReceipt(result);
        setPreview(undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法核对这条原话。');
      if (cause instanceof ApiError && [400,403,404,409].includes(cause.status)) setPreview(undefined);
    } finally { setPending(false); }
  }
  if (undone) return <p role="status">已撤回本次写入，保留其他教材编辑。</p>;
  if (receipt) return <div><p role="status">已写入教材</p>
    <UndoPageWrite id={receipt.ref.id} rev={receipt.ref.rev} token={receipt.undo_token} onUndo={() => setUndone(true)} />
  </div>;
  return <div>
    {preview && <section aria-label="教材写入预览">
      <strong>{preview.title} · 第 {preview.rev} 版</strong><blockquote>{preview.answer}</blockquote>
      <p>将原话与本轮反向链接一起写到页末。</p>
    </section>}
    <button className="text-button" disabled={pending} onClick={submit}>
      {pending ? '正在核对…' : preview ? '确认写入教材' : '预览写入教材'}
    </button>
    {preview && <button className="text-button" disabled={pending} onClick={() => setPreview(undefined)}>取消</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
