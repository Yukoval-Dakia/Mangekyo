import { useEffect } from 'react';
import { api } from './api';

/** Confirm the learner view after commit. Loading data or opening a hidden tab is insufficient. */
export function useWorkbookPresentation(
  paperId: string,
  revision: number | undefined,
  items: readonly string[],
  solution?: { id: string; rev: number },
) {
  const itemKey = JSON.stringify(items);
  const attemptId = solution?.id;
  const attemptRev = solution?.rev;
  useEffect(() => {
    if (revision === undefined || itemKey === '[]') return;
    let frame = 0;
    let sent = false;
    function confirm() {
      if (sent || document.visibilityState !== 'visible') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.visibilityState !== 'visible') return;
        sent = true;
        void api('/papers/' + encodeURIComponent(paperId) + '/presentation', {
          method: 'POST',
          body: {
            paper: { id: paperId, rev: revision }, items: JSON.parse(itemKey),
            ...(attemptId && attemptRev
              ? { kind: 'solution', submission: { id: attemptId, rev: attemptRev } }
              : { kind: 'question' }),
          },
        }).catch(() => { sent = false; });
      });
    }
    document.addEventListener('visibilitychange', confirm);
    confirm();
    return () => {
      document.removeEventListener('visibilitychange', confirm);
      cancelAnimationFrame(frame);
    };
  }, [paperId, revision, itemKey, attemptId, attemptRev]);
}
