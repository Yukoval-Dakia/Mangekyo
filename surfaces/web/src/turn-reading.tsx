import { useEffectEvent, useLayoutEffect, useState } from 'react';
import { api, sessionPath, type Session, type Turn } from './api';
import { ReadingDrawer } from './reading-drawer';

// Only show the fragment the session host actually released for this turn.
// A tool read alone does not establish that the model cited it in its reply.
function readings(turn: Turn) {
  const basis = turn.workspaceBasis;
  if (turn.action !== 'companion_reply' || !Array.isArray(basis)) return [];
  return turn.reads.flatMap(read => {
    if (read.workspace !== true || !read.text || !read.title) return [];
    const witnesses = basis.filter(w => w.id === read.id);
    const witness = witnesses[0];
    if (!witness || !witness.type || !Number.isSafeInteger(witness.rev) || witness.rev < 1 ||
        typeof witness.epoch !== 'string' || !witness.epoch ||
        witnesses.some(w => w.type !== witness.type || w.rev !== witness.rev || w.epoch !== witness.epoch)) return [];
    return [{key: JSON.stringify([read.id, witness.type, witness.rev, witness.epoch]), read}];
  });
}

function OpenReading({sessionId, turnId, identity, expectedText, expectedTitle, unavailable, reload}: {
  sessionId: string; turnId: string; identity: string; expectedText: string; expectedTitle: string; unavailable: () => void; reload: (() => void) | undefined;
}) {
  const stale = useEffectEvent(() => { unavailable(); reload?.(); });
  const [read, show] = useState<Turn['reads'][number]>();
  useLayoutEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const current = await api<Session>(sessionPath(sessionId), {cache: 'no-store', signal: controller.signal});
        if (controller.signal.aborted) return;
        const turn = current.id === sessionId && current.turns.find(t => t.turnId === turnId);
        const entry = turn && readings(turn).find(entry => entry.key === identity);
        if (document.hidden) return unavailable();
        if (!entry || entry.read.text !== expectedText || entry.read.title !== expectedTitle) return stale();
        show(entry.read);
        timer = setTimeout(refresh, 5000);
      } catch {
        if (!controller.signal.aborted) stale();
      }
    }
    function visibility() { if (document.hidden) unavailable(); }
    document.addEventListener('visibilitychange', visibility);
    if (document.hidden) unavailable();
    else void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [identity, expectedText, expectedTitle, sessionId, turnId, unavailable]);
  return read ? <><strong>{read.title}</strong><p>{read.text}</p></> : <p role="status">正在核对本轮阅读记录…</p>;
}

export function TurnReading({sessionId, turn, reload}: {sessionId: string; turn: Turn; reload: (() => void) | undefined}) {
  const [original] = useState(() => new Set(readings(turn).map(entry => entry.key)));
  const turnId = turn.turnId;
  if (!turnId) return null;
  const items = readings(turn).filter(entry => original.has(entry.key)).map(({key, read}, index) => ({
    id: key, label: '本轮读过 · ' + (index + 1),
    content: (unavailable: () => void) => <OpenReading sessionId={sessionId} turnId={turnId} identity={key} expectedText={read.text} expectedTitle={read.title} unavailable={unavailable} reload={reload} />,
  }));
  return <ReadingDrawer items={items} label="同伴本轮阅读" closeLabel="返回对话" />;
}
