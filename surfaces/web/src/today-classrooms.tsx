import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { roomPath, type Classroom } from './classroom-contract';

type Summary = Pick<Classroom, 'id' | 'rev' | 'topic'> & { activeStepTitle?: string };
type ListState = 'closed' | 'loading' | 'error' | 'unconfirmed' | Summary[];

export function TodayClassrooms() {
  const [list, setList] = useState<ListState>('closed');
  const pending = useRef<AbortController | null>(null);

  function close() {
    pending.current?.abort();
    pending.current = null;
    setList('closed');
  }

  useEffect(() => {
    function visibility() {
      if (document.hidden) close();
    }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', close);
    window.addEventListener('offline', close);
    return () => {
      pending.current?.abort();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', close);
      window.removeEventListener('offline', close);
    };
  }, []);

  async function open() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setList('loading');
    try {
      const { items, retryable } = await api<{ items: Summary[]; retryable?: true }>('/classrooms?status=active', {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (controller.signal.aborted) return;
      if (!Array.isArray(items)) setList('error');
      else setList(retryable && items.length === 0 ? 'unconfirmed' : items);
    } catch {
      if (!controller.signal.aborted) setList('error');
    }
  }

  return (
    <div>
      <div className="study-actions">
        <button className="tonal-button" aria-expanded={list !== 'closed'} onClick={list === 'closed' ? open : close}>
          {list === 'closed' ? '继续课堂' : '收起课堂'}
        </button>
        <a className="tonal-button" href="/classroom">开新课</a>
      </div>
      {list === 'loading' && <p role="status">正在读取进行中的课堂…</p>}
      {list === 'error' && <p role="status">暂时无法读取进行中的课堂。 <button className="text-button" onClick={open}>重试</button></p>}
      {list === 'unconfirmed' && <p role="status">暂时无法核对课堂依据。 <button className="text-button" onClick={open}>重试</button></p>}
      {Array.isArray(list) && (list.length ? (
        <ul>
          {list.map(room => <li key={room.id}>
            <a href={roomPath(room.id)}>{room.topic}{room.activeStepTitle && ' · ' + room.activeStepTitle}</a>
          </li>)}
        </ul>
      ) : <p role="status">目前没有进行中的课堂。</p>)}
    </div>
  );
}
