import { useEffect, useState } from 'react';
import { latestKey, synchronizeDeletion, validWatermark } from './deletion-watermark';

// Restored drafts retain their own binding. Only new drafts wait for this check.
export function useDraftWatermark(active = true) {
  const [state, setState] = useState<'waiting' | 'ready' | 'failed'>('waiting');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let sequence = 0;
    async function check() {
      const current = ++sequence;
      setState('waiting');
      try {
        if (navigator.onLine) await synchronizeDeletion();
        else if (!validWatermark(localStorage.getItem(latestKey))) throw new Error();
        if (current === sequence) setState('ready');
      } catch {
        if (current === sequence) setState('failed');
      }
    }
    void check();
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    return () => {
      sequence++;
      window.removeEventListener('online', check);
      window.removeEventListener('offline', check);
    };
  }, [active, retry]);
  const notice = state === 'waiting' ? <p role="status">正在核对删除水位…</p> :
    state === 'failed' ? <p role="status">暂时无法确认删除水位。
      <button type="button" className="text-button" onClick={() => setRetry(n => n + 1)}>重新核对</button></p> : null;
  return { ready: state === 'ready', notice };
}
