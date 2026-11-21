import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { useQuestionPresentation } from './workbook-presentation';

const labels = { notion: 'Notion 块', backtrace: '错法与旧稳题', archetype: '母题覆盖' };
export type ReadingContextEntry = { kind: keyof typeof labels; ref: string };
export function capsuleLabel(kind: ReadingContextEntry['kind']) {
  return Object.hasOwn(labels, kind) ? labels[kind] : undefined;
}

// Check the text's visible portion, including clipping by the scrolling dialog.
// A dialog that has closed can stay in the DOM until its close event is handled.
function canSeeText(node: HTMLElement) {
  if (document.visibilityState !== 'visible' || !node.closest('dialog[open]') ||
      !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const rect = node.getBoundingClientRect();
  const left = Math.max(rect.left, 0), right = Math.min(rect.right, innerWidth);
  const top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, innerHeight);
  return bottom > top && right > left &&
    node.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
}

export function PaperReadingCapsule({ presentation, itemId, entry, onUnavailable }: {
  presentation: NonNullable<ReturnType<typeof useQuestionPresentation>>;
  itemId: string;
  entry: ReadingContextEntry;
  onUnavailable: () => void;
}) {
  const { paper, permit, attempt } = presentation;
  const path = '/papers/' + encodeURIComponent(paper.id) + '/reading-context';
  const attemptId = attempt?.id, attemptRev = attempt?.rev;
  const context = useMemo(() => ({
    paperRev: paper.rev, itemId, ref: entry.ref,
    ...(attemptId !== undefined && attemptRev !== undefined && { attemptRef: { id: attemptId, rev: attemptRev } }),
  }), [paper.rev, itemId, entry.ref, attemptId, attemptRev]);
  const [opened, setOpened] = useState<{ text: string; displayRef: string }>();
  const paragraph = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    const unavailable = () => { if (!controller.signal.aborted) onUnavailable(); };
    function visibilityChanged() {
      if (document.visibilityState !== 'visible') unavailable();
    }
    document.addEventListener('visibilitychange', visibilityChanged);
    if (document.visibilityState !== 'visible') unavailable();
    else void api<{ kind: unknown; text: unknown; displayRef: unknown }>(path, {
      method: 'POST', body: { ...context, permit, phase: 'opened' }, signal: controller.signal,
    }).then(result => {
      if (controller.signal.aborted) return;
      if (result?.kind !== entry.kind || typeof result.text !== 'string' || !result.text.trim() ||
          typeof result.displayRef !== 'string' || !result.displayRef.trim()) return unavailable();
      setOpened({ text: result.text, displayRef: result.displayRef });
    }).catch(unavailable);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [context, path, permit, entry.kind, onUnavailable]);

  useLayoutEffect(() => {
    const node = paragraph.current;
    if (!node || !opened) return;
    let mounted = true;
    let sent = false;
    let frame = 0;
    function confirm() {
      if (!mounted || sent || !node || !opened || !canSeeText(node)) return;
      sent = true;
      // Once the body has been painted, closing the drawer must not cancel its receipt.
      void fetch('/api' + path, {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...context, phase: 'displayed', displayRef: opened.displayRef }),
      }).then(async response => {
        if (!response.ok || (await response.json())?.recorded !== true) throw new Error();
      }).catch(() => { if (mounted) onUnavailable(); });
    }
    const hasPaintTiming = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('element');
    let painted = false;
    const timing = hasPaintTiming ? new PerformanceObserver(list => {
      if (list.getEntries().some(e => (e as PerformanceEntry & { element?: Element }).element === node)) {
        painted = true;
        confirm();
      }
    }) : undefined;
    timing?.observe({ type: 'element', buffered: true });
    const intersection = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      if (hasPaintTiming && !painted) return;
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(confirm); });
    });
    intersection.observe(node);
    return () => {
      mounted = false;
      intersection.disconnect();
      timing?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [context, path, opened, onUnavailable]);

  // Chrome reports Element Timing for a newly painted node. Reusing the loading
  // paragraph and adding the attribute after its first paint yields no entry.
  return opened
    ? <p key="body" ref={paragraph} {...{ elementtiming: 'reading-capsule-text' }}>{opened.text}</p>
    : <p role="status">正在读取参考…</p>;
}
