import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { sessionPath } from '../api';

type Permissions = { sessionId: string; ids: ReadonlySet<string> };

function readIds(data: string, sessionId: string): Set<string> | undefined {
  try {
    const message = JSON.parse(data);
    if (message?.sessionId === sessionId && Array.isArray(message.authorizedMountIds) &&
        message.authorizedMountIds.every((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)))
      return new Set(message.authorizedMountIds);
  } catch { /* An unreadable frame cannot confirm any mount. */ }
  return undefined;
}

export function useMountPermissions(sessionId: string | null, active: boolean, onWithdraw: (sessionId: string, ids: string[]) => void) {
  const [confirmed, setConfirmed] = useState<Permissions>();
  const withdraw = useEffectEvent(onWithdraw);
  const history = useRef<{sessionId: string; previous: Set<string>; withdrawn: Set<string>}>(undefined);

  useEffect(() => {
    if (!sessionId || !active) return;
    const watchedSession = sessionId;
    const endpoint = `/api${sessionPath(watchedSession)}/events?watchMounts=1`;
    let source: EventSource | undefined;
    if (history.current?.sessionId !== watchedSession)
      history.current = { sessionId: watchedSession, previous: new Set(), withdrawn: new Set() };
    const grants = history.current;

    function close() {
      source?.close();
      source = undefined;
      setConfirmed(undefined);
    }

    function connect() {
      close();
      if (document.visibilityState !== 'visible') return;
      const stream = new EventSource(endpoint);
      source = stream;
      stream.addEventListener('mount-permissions', (event: MessageEvent<string>) => {
        if (source !== stream || stream.readyState !== EventSource.OPEN) return;
        const ids = readIds(event.data, watchedSession);
        if (!ids) {
          setConfirmed(undefined);
          return;
        }
        // The two streams run independently. A permission can be withdrawn
        // before the body arrives, or while the conversation is off screen.
        for (const id of grants.withdrawn) ids.delete(id);
        const removed = [...grants.previous].filter(id => !ids.has(id));
        for (const id of removed) grants.withdrawn.add(id);
        if (removed.length) withdraw(watchedSession, removed);
        grants.previous = ids;
        setConfirmed({sessionId: watchedSession, ids});
      });
      const unconfirmed = () => {
        if (source === stream) setConfirmed(undefined);
      };
      stream.addEventListener('session-error', unconfirmed);
      stream.onerror = unconfirmed;
    }

    connect();
    document.addEventListener('visibilitychange', connect);
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', connect);
    return () => {
      document.removeEventListener('visibilitychange', connect);
      window.removeEventListener('pagehide', close);
      window.removeEventListener('pageshow', connect);
      close();
    };
  }, [sessionId, active]);

  return active && confirmed?.sessionId === sessionId ? confirmed?.ids : undefined;
}
