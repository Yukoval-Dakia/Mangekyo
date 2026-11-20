import {useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {remember, remembered} from './api';
import {bindDeletionWatermark, latestKey, validWatermark} from './deletion-watermark';

function watchWatermark(change: () => void) {
  window.addEventListener('storage', change);
  window.addEventListener(latestKey, change);
  return () => {
    window.removeEventListener('storage', change);
    window.removeEventListener(latestKey, change);
  };
}

export function useCurrentDraft(requestId?: string) {
  return useSyncExternalStore(watchWatermark, () => {
    try {
      const current = localStorage.getItem(latestKey);
      return !!requestId && validWatermark(current) && bindDeletionWatermark(requestId) === current;
    } catch { return false; }
  });
}

type CardProps = {
  slot: string; binding: string; itemId: string; label: string;
  onContinue: () => void; onCover?: () => void;
};

// The caller supplies only currently permitted anchors. Store departure metadata
// separately from editable text so pagehide cannot overwrite another tab's edits.
export function ActivityReentry({slot, binding, itemId, label, onContinue, onCover}: CardProps) {
  const key = 'reentry:' + slot;
  const [offer, setOffer] = useState(false);
  useLayoutEffect(() => {
    let away = false;
    let lastActionAt = Date.now();
    function active(event: Event) {
      if (away) return;
      lastActionAt = Date.now();
      if (event.type === 'input') setOffer(false);
    }
    function arrive() {
      if (document.visibilityState !== 'visible') return;
      away = false;
      lastActionAt = Date.now();
      let due = false;
      try {
        const previous = JSON.parse(remembered(key) ?? 'null');
        due = previous?.binding === binding && previous.itemId === itemId &&
          Number.isSafeInteger(previous.lastActionAt) && previous.lastActionAt > 0 && Date.now() - previous.lastActionAt > 20 * 60_000;
      } catch { /* Missing metadata leaves the ordinary editor available. */ }
      setOffer(due);
    }
    function leave() {
      if (away) return;
      away = true;
      remember(key, JSON.stringify({binding, itemId, lastActionAt}));
    }
    function visibility() {
      if (document.visibilityState === 'visible') arrive();
      else leave();
    }
    arrive();
    document.addEventListener('input', active, true);
    document.addEventListener('focusin', active, true);
    document.addEventListener('pointerdown', active, true);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', arrive);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      leave();
      document.removeEventListener('input', active, true);
      document.removeEventListener('focusin', active, true);
      document.removeEventListener('pointerdown', active, true);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', arrive);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [key, binding, itemId]);
  function choose(action: () => void) {
    setOffer(false);
    remember(key, null);
    action();
  }
  return offer ? <div className="activity-reentry" aria-label="续场卡">
    <span {...{elementtiming: 'activity-reentry'}}>{label}</span>
    <button type="button" className="text-button" onClick={() => choose(onContinue)}>继续这步</button>
    {onCover && <button type="button" className="text-button" onClick={() => choose(onCover)}>盖住重做</button>}
    <button type="button" className="text-button" onClick={() => {setOffer(false); remember(key, null);}}>收起</button>
  </div> : null;
}

function focusScratch(itemId: string) {
  const target = document.getElementById('draft-' + itemId);
  if (!(target instanceof HTMLDetailsElement)) return;
  target.open = true;
  target.querySelector('textarea')?.focus();
}

export function ScratchReentry({itemId, label, slot, binding, cover}: Omit<CardProps,'onContinue'|'onCover'> & {
  cover: (item: string) => void;
}) {
  return <ActivityReentry {...{slot,binding,itemId,label}} onContinue={() => focusScratch(itemId)} onCover={() => cover(itemId)}/>;
}

function CoveredScratch({change, cancel, disabled}: {change: (value: string) => void; cancel: () => void; disabled: boolean}) {
  const [replacement, setReplacement] = useState('');
  return <>
    <label className="field">重新演算（原稿已盖住）
      <textarea autoFocus rows={3} maxLength={4000} value={replacement} disabled={disabled}
        onChange={e => setReplacement(e.currentTarget.value)}/>
    </label>
    <button type="button" className="text-button" onClick={cancel}>保留原稿</button>
    <button type="button" className="tonal-button" disabled={disabled || !replacement.trim()}
      onClick={() => {change(replacement); cancel();}}>用新演算替换本题草稿</button>
  </>;
}

export function ResumeScratch({itemId, value, change, disabled, children, covered, finish}: {
  itemId: string; value: string; change: (value: string) => void; disabled: boolean; children: ReactNode;
  covered: boolean; finish: () => void;
}) {
  const wasCovered = useRef(false);
  useLayoutEffect(() => {
    if (wasCovered.current && !covered) focusScratch(itemId);
    wasCovered.current = covered;
  }, [covered, itemId]);
  return covered ? <CoveredScratch change={change} cancel={finish} disabled={disabled}/> : <>
    <details id={'draft-' + itemId}><summary>本题草稿</summary><label className="field">演算或思路（仅本机）
      <textarea rows={3} maxLength={4000} disabled={disabled} value={value} onChange={e => change(e.target.value)}/>
    </label></details>
    {children}
  </>;
}
