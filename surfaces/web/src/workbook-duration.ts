const idleMs = 60_000;
const limitMs = 86_400_000;

export function observePaperTime(form: HTMLFormElement, paperId: string, requestId: string) {
  const storageKey = `mangekyo:paper-time:${paperId}`;
  let elapsed = 0;
  const itemTimes = new Map<string, number>();
  const items = new Set(Array.from(form.querySelectorAll<HTMLElement>('[data-item-id]'), node => node.dataset.itemId));
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (saved?.requestId === requestId && Number.isSafeInteger(saved.elapsed) &&
        saved.elapsed > 0 && saved.elapsed <= limitMs) elapsed = saved.elapsed;
    if (saved?.requestId === requestId && saved.items && typeof saved.items === 'object') {
      for (const [id, ms] of Object.entries(saved.items)) {
        if (items.has(id) && typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 0 && ms <= limitMs)
          itemTimes.set(id, ms);
      }
    }
  } catch {
    // Measurement still works for this visit without session storage.
  }
  let since: number | undefined;
  let submitting = false;
  let activeItem: string | undefined;
  let itemSince = 0;

  function itemAt(target: EventTarget | null) {
    return target instanceof Element && form.contains(target)
      ? target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId : undefined;
  }

  function itemDelta(now: number) {
    return since === undefined ? 0 : Math.max(0, Math.min(now, since + idleMs) - itemSince);
  }

  function switchItem(next: string | undefined, now: number) {
    if (activeItem) itemTimes.set(activeItem, Math.min(limitMs, (itemTimes.get(activeItem) ?? 0) + itemDelta(now)));
    activeItem = next;
    itemSince = now;
  }

  function countUntil(now: number) {
    if (since !== undefined) elapsed = Math.min(limitMs, elapsed + Math.min(idleMs, Math.max(0, now - since)));
    since = undefined;
  }
  function pause() {
    const now = performance.now();
    switchItem(undefined, now);
    countUntil(now);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ requestId, elapsed: Math.floor(elapsed),
        items: Object.fromEntries(Array.from(itemTimes, ([id, ms]) => [id, Math.floor(ms)])) }));
    } catch {
      // Keep the in-memory estimate if storage is unavailable.
    }
  }
  function activity(event?: Event) {
    if (submitting || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const now = performance.now();
    switchItem(itemAt(event?.target instanceof Element ? event.target : document.activeElement), now);
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
  // Moving keyboard focus attributes the rest of the existing interval, without restarting its idle deadline.
  form.addEventListener('focusin', event => switchItem(itemAt(event.target), performance.now()), { signal });
  form.addEventListener('focusout', event => switchItem(itemAt(event.relatedTarget), performance.now()), { signal });
  window.addEventListener('focus', activity, { signal });
  window.addEventListener('blur', pause, { signal });
  window.addEventListener('pagehide', pause, { signal });
  window.addEventListener('pageshow', activity, { signal });
  document.addEventListener('visibilitychange', visibilityChanged, { signal });
  activity();
  return {
    itemElapsed(id: string) {
      return Math.floor(Math.min(limitMs, (itemTimes.get(id) ?? 0) + (activeItem === id ? itemDelta(performance.now()) : 0)));
    },
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
