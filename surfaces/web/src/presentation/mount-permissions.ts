import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { sessionPath } from '../api';

import { mountBatches, mountQuery, unresolved, type PartialMountPermissions } from './mount-coverage.ts';

type Permissions = { sessionId: string; ids: ReadonlySet<string>; connection: symbol };

function readIds(data: string, sessionId: string): (PartialMountPermissions & { authorizedMountIds: string[] }) | undefined {
  try {
    const message = JSON.parse(data);
    if (message?.sessionId === sessionId && Array.isArray(message.authorizedMountIds) &&
        message.authorizedMountIds.every((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)))
      return message;
  } catch { /* An unreadable frame cannot confirm any mount. */ }
  return undefined;
}

export function useMountPermissions(sessionId: string | null, active: boolean, known: (id: string) => string[], onFrame: (sessionId: string, removed: string[], unknown: string[], ids: ReadonlySet<string>) => void) {
  const [confirmed, setConfirmed] = useState<Permissions>();
  const frame = useEffectEvent(onFrame);
  const getKnown = useEffectEvent(known);
  const history = useRef<{sessionId: string; previous: Set<string>; withdrawn: Set<string>}>(undefined);

  useEffect(() => {
    if (!sessionId || !active) return;
    const watchedSession = sessionId;
    const endpoint = `/api${sessionPath(watchedSession)}/events?watchMounts=1`;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    if (history.current?.sessionId !== watchedSession)
      history.current = { sessionId: watchedSession, previous: new Set(), withdrawn: new Set() };
    const grants = history.current;

    function close() {
      clearTimeout(retry);
      source?.close();
      source = undefined;
      setConfirmed(undefined);
    }

    function connect() {
      close();
      if (document.visibilityState !== 'visible') return;
      const knownIds = new Set([...grants.previous, ...getKnown(watchedSession)]);
      const hints = mountBatches(knownIds)[0] ?? [];
      const covered = new Set(hints);
      const stream = new EventSource(mountQuery(endpoint, hints));
      source = stream;
      let connection = Symbol();
      function unconfirmed() {
        if (source !== stream) return;
        connection = Symbol();
        setConfirmed(undefined);
      }
      stream.addEventListener('mount-permissions', (event: MessageEvent<string>) => {
        if (source !== stream || stream.readyState !== EventSource.OPEN) return;
        const message = readIds(event.data, watchedSession);
        if (!message) return unconfirmed();
        const ids = new Set(message.authorizedMountIds);
        // The two streams run independently. A permission can be withdrawn
        // before the body arrives, or while the conversation is off screen.
        for (const id of grants.withdrawn) ids.delete(id);
        const missing = [...knownIds].filter(id => !ids.has(id) && !grants.withdrawn.has(id));
        const removed = missing.filter(id => !unresolved(message, id, covered));
        const unknown = missing.filter(id => unresolved(message, id, covered));
        for (const id of removed) grants.withdrawn.add(id);
        for (const id of removed) knownIds.delete(id);
        for (const id of ids) { knownIds.add(id); covered.add(id); }
        frame(watchedSession, removed, unknown, ids);
        grants.previous = knownIds;
        setConfirmed({sessionId: watchedSession, ids, connection});
      });
      stream.addEventListener('session-error', unconfirmed);
      stream.onerror = () => {
        if (source !== stream) return;
        close();
        retry = setTimeout(connect, 1000);
      };
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

  return active && confirmed?.sessionId === sessionId ? confirmed : undefined;
}
