import { useCallback, useEffect, useRef, useState } from 'react';
import { discardQueued,pendingCount,queueChanged,synchronizeQueue,type SyncResult } from './offline-queue';

export function OfflineStatus() {
  const [online,setOnline] = useState(navigator.onLine);
  const [count,setCount] = useState(0);
  const [sync,setSync] = useState<SyncResult>();
  const running = useRef(false);
  const reconcile = useCallback(async (allowLegacyPosition?:number) => {
    if (!navigator.onLine || running.current) return;
    running.current = true;
    try { setSync(await synchronizeQueue(allowLegacyPosition)); }
    catch { setSync({sent:0,removed:0,reason:'暂时无法确认同步或回执。'}); }
    finally { running.current = false; }
  },[]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    function refresh() {
      const expected = ++revision;
      setOnline(navigator.onLine);
      void pendingCount().then(n => {if (active && expected === revision) setCount(n);}).catch(() => {});
    }
    function reconnect() { refresh(); void reconcile(); }
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(queueChanged);
    channel?.addEventListener('message', refresh);
    reconnect();
    window.addEventListener('online',reconnect);
    window.addEventListener('pageshow',reconnect);
    window.addEventListener('focus',reconnect);
    window.addEventListener('offline',refresh);
    window.addEventListener(queueChanged,refresh);
    return () => {
      active = false;
      channel?.close();
      window.removeEventListener('online',reconnect);
      window.removeEventListener('pageshow',reconnect);
      window.removeEventListener('offline',refresh);
      window.removeEventListener('focus',reconnect);
      window.removeEventListener(queueChanged,refresh);
    };
  },[reconcile]);
  if (online && !count && !sync?.sent && !sync?.removed) return null;
  return <div className="offline-status" role="status">
    {!online && '当前离线。'}
    {count > 0 && <>本机待发 {count} 项。{online && sync?.reason}
      {online && <button className="text-button" onClick={() => void reconcile()}>重新同步</button>}
      {online && sync?.legacy && <button className="text-button" onClick={() => void reconcile(sync.blocked)}>按旧设备水位核对</button>}
      {online && sync?.blocked !== undefined && <button className="text-button" onClick={async () => {
        if (window.confirm('丢弃这项尚未同步的本机提交？此操作无法撤回。')) {
          await discardQueued(sync.blocked!); await reconcile();
        }
      }}>丢弃受阻项</button>}
    </>}
    {!!sync?.sent && <> 已收到 {sync.sent} 项服务端回执。</>}
    {!!sync?.removed && <> 删除状态已变化，已清除 {sync.removed} 项旧提交。需要时请重新明确交入。</>}
    {!online && !count && '可读内置讲义或交入材料。'}
  </div>;
}
