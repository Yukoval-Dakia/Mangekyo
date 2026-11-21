import {limitMs, workbookTimingParts, type PaperTiming} from './workbook-pacing';

const idleMs = 60_000;

export function observePaperTime(form: HTMLFormElement, paperId: string, requestId: string,
  tracking?: {current: () => boolean}) {
  const parts = tracking && workbookTimingParts(paperId, requestId);
  const storageKey = parts?.clockKey ?? `mangekyo:paper-time:${paperId}`;
  let elapsed = 0;
  const itemTimes = new Map<string, number>();
  const items = new Set(Array.from(form.querySelectorAll<HTMLElement>('[data-item-id]'), node => node.dataset.itemId!));
  try {
    const storage = parts ? localStorage : sessionStorage;
    const saved = JSON.parse(storage.getItem(storageKey) ?? 'null');
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
    if (activeItem && since !== undefined) itemTimes.set(activeItem, Math.min(limitMs, (itemTimes.get(activeItem) ?? 0) + itemDelta(now)));
    activeItem = next;
    itemSince = now;
  }

  function countUntil(now: number) {
    if (since !== undefined) elapsed = Math.min(limitMs, elapsed + Math.min(idleMs, Math.max(0, now - since)));
    since = undefined;
  }
  function checkpoint(now: number, requireSave = false) {
    try {
      if (tracking && !tracking.current()) return;
      const storage = parts ? localStorage : sessionStorage;
      const pending = since === undefined ? 0 : Math.max(0, Math.min(idleMs, now - since));
      const times = new Map(itemTimes);
      if (activeItem && since !== undefined) times.set(activeItem, (times.get(activeItem) ?? 0) + itemDelta(now));
      storage.setItem(storageKey, JSON.stringify({requestId, elapsed: Math.floor(Math.min(limitMs, elapsed + pending)),
        items: Object.fromEntries(Array.from(times, ([id, ms]) => [id, Math.floor(Math.min(limitMs, ms))]))}));
    } catch {
      if (requireSave) throw new Error('无法保存本次卷面计时。');
      // Keep the in-memory estimate if storage is unavailable.
    }
  }
  function pause(requireSave = false) {
    const now = performance.now();
    switchItem(undefined, now);
    countUntil(now);
    checkpoint(now, requireSave);
  }
  function activity(event?: Event) {
    if (submitting || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const now = performance.now();
    const id = itemAt(event?.target instanceof Element ? event.target : document.activeElement);
    if (id && id !== activeItem && event?.type === 'pointerdown' && tracking?.current()) parts?.revisit(id);
    switchItem(id, now);
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
  form.addEventListener('focusin', event => {
    const id = itemAt(event.target);
    if (submitting || !document.hasFocus() || document.visibilityState !== 'visible') return;
    switchItem(id, performance.now());
    if (parts && id && itemAt(event.relatedTarget) !== id && tracking?.current()) parts.revisit(id);
  }, { signal });
  form.addEventListener('focusout', () => switchItem(undefined, performance.now()), { signal });
  window.addEventListener('focus', activity, { signal });
  window.addEventListener('blur', () => pause(), { signal });
  window.addEventListener('pagehide', () => pause(), { signal });
  window.addEventListener('pageshow', activity, { signal });
  document.addEventListener('visibilitychange', visibilityChanged, { signal });
  activity();
  return {
    itemElapsed(id: string) {
      return Math.floor(Math.min(limitMs, (itemTimes.get(id) ?? 0) + (activeItem === id ? itemDelta(performance.now()) : 0)));
    },
    skip(id: string) {
      if (parts && items.has(id) && tracking?.current() && document.hasFocus() && document.visibilityState === 'visible') {
        parts.skip(id);
        if (!itemTimes.has(id)) itemTimes.set(id, 0);
        checkpoint(performance.now(), true);
      }
    },
    submit(): PaperTiming {
      submitting = true;
      pause(!!parts);
      if (parts) return parts.snapshot([...items]);
      return elapsed >= 1 ? {effectiveDurationMs: Math.floor(elapsed)} : {};
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
