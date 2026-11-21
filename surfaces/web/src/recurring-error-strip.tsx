import {useId, useLayoutEffect, useRef, useState} from 'react';
import {latestKey, observedDeletionWatermark} from './deletion-watermark';
import './recurring-error-strip.css';

type ErrorAnchor = {
  ref: string;
  occurredAt: string;
  sourceLabel: string;
  divergenceSummary?: string;
};

// The host binds the opaque ref to the submitted item and its evidence versions.
export type ErrorCluster = {ref: string; count: number; anchors?: ErrorAnchor[]};
type Props = {initial: ErrorCluster; reopen: (signal: AbortSignal) => Promise<ErrorCluster | undefined>};

const present = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
function hasCount(value?: ErrorCluster): value is ErrorCluster {
  return !!value && present(value.ref) && Number.isSafeInteger(value.count) && value.count >= 2;
}

function Comparison({initial, reopen}: Props) {
  const [count, setCount] = useState<number | null>(initial.count);
  const [anchors, setAnchors] = useState<ErrorAnchor[]>();
  const [opening, setOpening] = useState(false);
  const request = useRef<AbortController>(undefined);
  const panel = useId();

  function clear() {
    request.current?.abort();
    setOpening(false);
    setAnchors(undefined);
    setCount(null);
  }

  async function read(expand: boolean) {
    clear();
    if (document.visibilityState !== 'visible') return;
    const generation = observedDeletionWatermark();
    const controller = new AbortController();
    request.current = controller;
    setOpening(expand);
    try {
      const fresh = await reopen(controller.signal);
      if (controller.signal.aborted || observedDeletionWatermark() !== generation ||
          document.visibilityState !== 'visible' || !hasCount(fresh) || fresh.ref !== initial.ref) return;
      if (expand) {
        const rows = fresh.anchors?.slice(0, Math.min(3, fresh.count - 1));
        if (!rows?.length || rows.some(row => !row || !present(row.ref) ||
          !present(row.sourceLabel) || !present(row.occurredAt) || !Number.isFinite(Date.parse(row.occurredAt)) ||
          (row.divergenceSummary !== undefined && !present(row.divergenceSummary))) ||
          new Set(rows.map(row => row.ref)).size !== rows.length) return;
        setAnchors(rows);
      }
      setCount(fresh.count);
    } catch {
      // Optional history disappears when the host cannot reopen it.
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  }

  useLayoutEffect(() => {
    const resume = () => void read(false);
    const visibility = () => { if (document.visibilityState === 'visible') resume(); else clear(); };
    const stored = (event: StorageEvent) => { if (event.key === latestKey || event.key === null) clear(); };
    if (document.visibilityState !== 'visible') clear();
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    window.addEventListener(latestKey, clear);
    window.addEventListener('storage', stored);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      request.current?.abort();
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener(latestKey, clear);
      window.removeEventListener('storage', stored);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [reopen]);

  if (!opening && count === null) return null;
  return <div className="error-comparison">
    <button type="button" disabled={opening} aria-expanded={!!anchors} aria-controls={anchors ? panel : undefined} onClick={() => {
      if (anchors) setAnchors(undefined); else void read(true);
    }}>{opening ? '正在核对历史错题…' : <span {...{elementtiming: 'error-comparison-count'}}>同类栽跟头 ×{count} · 对比</span>}</button>
    {anchors && <ul id={panel}>{anchors.map(anchor => <li key={anchor.ref}>
      <time dateTime={anchor.occurredAt}>{anchor.occurredAt.slice(0, 10)}</time>
      <span {...{elementtiming: 'error-comparison-source'}}>{anchor.sourceLabel}</span>
      {anchor.divergenceSummary && <p>{anchor.divergenceSummary}</p>}
    </li>)}</ul>}
  </div>;
}

export function RecurringErrorStrip({initial, reopen}: Omit<Props, 'initial'> & {initial?: ErrorCluster | undefined}) {
  return hasCount(initial) ? <Comparison key={JSON.stringify([initial.ref, initial.count])} initial={initial} reopen={reopen}/> : null;
}
