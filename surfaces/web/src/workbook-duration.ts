const idleMs = 60_000;
const limitMs = 86_400_000;

export function observePaperTime(form: HTMLFormElement, paperId: string, requestId: string) {
  const storageKey = `mangekyo:paper-time:${paperId}`;
  let elapsed = 0;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (saved?.requestId === requestId && Number.isSafeInteger(saved.elapsed) &&
        saved.elapsed > 0 && saved.elapsed <= limitMs) elapsed = saved.elapsed;
  } catch {
    // Measurement still works for this visit without session storage.
  }
  let since: number | undefined;
  let submitting = false;

  function countUntil(now: number) {
    if (since !== undefined) elapsed = Math.min(limitMs, elapsed + Math.min(idleMs, Math.max(0, now - since)));
    since = undefined;
  }
  function pause() {
    countUntil(performance.now());
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ requestId, elapsed: Math.floor(elapsed) }));
    } catch {
      // Keep the in-memory estimate if storage is unavailable.
    }
  }
  function activity() {
    if (submitting || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const now = performance.now();
    countUntil(now);
    since = now;
  }
  function visibilityChanged() {
    if (document.visibilityState === 'visible') activity();
    else pause();
  }
  const listeners = new AbortController();
  const { signal } = listeners;
  for (const event of ['pointerdown', 'keydown', 'input', 'wheel', 'touchmove']) {
    form.addEventListener(event, activity, { signal, passive: true });
  }
  window.addEventListener('focus', activity, { signal });
  window.addEventListener('blur', pause, { signal });
  window.addEventListener('pagehide', pause, { signal });
  window.addEventListener('pageshow', activity, { signal });
  document.addEventListener('visibilitychange', visibilityChanged, { signal });
  activity();
  return {
    submit() {
      submitting = true;
      pause();
      return Math.floor(elapsed) || undefined;
    },
    resume() {
      submitting = false;
      activity();
    },
    stop() {
      listeners.abort();
      pause();
    },
  };
}
