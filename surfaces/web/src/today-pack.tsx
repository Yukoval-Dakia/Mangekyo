import {useVisibleDocument} from './workbook-presentation';
import {ActivityReentry, useCurrentDraft} from './activity-reentry';
import { answerKey, forgetPackDrafts, recoverDraft, selectDraft, pendingDraft, settleDraft, type Draft } from './today-draft';
import { useDraftWatermark } from './draft-watermark';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, deletedSubmission, remember, remembered, submissionId } from './api';
import {
  bindDeletionWatermark,
  latestKey,
  synchronizeDeletion,
  verifyGenerationReceipt,
  validWatermark,
} from './deletion-watermark';

export type ActivityRef = { kind: 'activity' | 'pack' | 'material'; id: string; rev: number };
type Pack = {
  kind: 'pack';
  id: string;
  rev: number;
  source: string;
  title: string;
  prompt: string;
  choices: string[];
};
type Activity = { kind: 'activity'; id: string; rev: number; href: string };

type Result = { id: string; rev: number; result: 'correct' | 'incorrect'; explanation: string };

export type Duration = '3min' | '15min' | '45min+';
export const durationLabels: Record<Duration, string> = {'3min': '3 分钟', '15min': '15 分钟', '45min+': '45 分钟以上'};
export function durationLabel(mode: string, duration?: Duration) {
  if (duration) return durationLabels[duration];
  return mode === 'one-hand' ? '默认时长（3 分钟）' : '默认时长';
}
export function todayParams(mode: string, duration?: Duration) {
  return new URLSearchParams({mode, ...(duration && {duration})});
}
export function openLink(ref: ActivityRef, mode: string, duration?: Duration) {
  if (ref.kind === 'material') return '/materials/saved/' + encodeURIComponent(ref.id);
  const params = todayParams(mode, duration);
  params.set('kind', ref.kind);
  params.set('id', ref.id);
  params.set('rev', String(ref.rev));
  return '/today?' + params;
}

function frozenPack(value: Pack | Activity | null, ref: ActivityRef): value is Pack {
  return (
    ref.kind === 'pack' &&
    value?.kind === 'pack' &&
    value.id === ref.id &&
    value.rev === ref.rev &&
    [value.source, value.title, value.prompt].every((field) => typeof field === 'string') &&
    Array.isArray(value.choices) &&
    value.choices.length > 0 &&
    value.choices.every((choice) => typeof choice === 'string')
  );
}

function local<T>(key: string): T | null {
  try {
    return JSON.parse(remembered(key) ?? 'null');
  } catch {
    return null;
  }
}

const packKey = ({ id, rev }: ActivityRef) => 'today-pack:' + encodeURIComponent(id) + '@' + rev;

export function cachedPack(ref: ActivityRef) {
  const value = local<Pack>(packKey(ref));
  return frozenPack(value, ref) ? value : null;
}

export function otherCachedPacks(inPlan: ActivityRef[]) {
  const packs: Pack[] = [];
  for (const storageKey of Object.keys(localStorage)) {
    if (!/^mangekyo:today-pack:[^@]+@\d+$/.test(storageKey)) continue;
    const value = local<Pack>(storageKey.slice('mangekyo:'.length));
    if (!value || value.kind !== 'pack' || !frozenPack(value, value) ||
        'mangekyo:' + packKey(value) !== storageKey) continue;
    if (!inPlan.some(ref => ref.kind === 'pack' && ref.id === value.id && ref.rev === value.rev)) packs.push(value);
  }
  return packs;
}

export function TodayActivity({ refValue, mode, duration }: { refValue: ActivityRef; mode: string; duration: Duration | undefined }) {
  const { kind, id, rev } = refValue;
  const foreground = useVisibleDocument();
  const watermark = useDraftWatermark(foreground);
  const key = packKey(refValue);
  const draftKey = answerKey(refValue);
  const requested = new URLSearchParams(location.search).get('answer');
  const [pack, setPack] = useState<Pack | null>(null);
  const [draft, setDraft] = useState<Draft | null>(() => kind === 'pack' ? recoverDraft(refValue, requested) : null);
  const currentGeneration = useCurrentDraft(draft?.requestId);
  const [redo, setRedo] = useState<{requestId: string; choice: number | null} | null>(null);
  const choices = useRef<HTMLFieldSetElement>(null);
  const covering = !!redo && redo.requestId === draft?.requestId && currentGeneration;
  const selectedId = useRef(draft?.requestId);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [reload, setReload] = useState(0);
  const resetForm = useCallback(() => {
    selectedId.current = undefined;
    setRedo(null);
    setDraft(null);
    setConsent(false);
    setPack(null);
    setResult(null);
  }, []);
  const invalidatePack = useCallback(() => {
    if (kind !== 'pack') return;
    remember(key, null);
    forgetPackDrafts(draftKey);
    resetForm();
  }, [kind, key, draftKey, resetForm]);
  useLayoutEffect(() => {
    if (!foreground) {setPack(null); return;}
    const controller = new AbortController();
    const ref = { kind, id, rev };
    setError('');
    setPack(null);
    async function read() {
      try {
        const query = new URLSearchParams({ kind, id, rev: String(rev) });
        const value = await api<Pack | Activity>('/today/open?' + query, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (frozenPack(value, ref)) {
          setPack(value);
          remember(key, JSON.stringify(value));
          return;
        }
        if (kind === 'activity' && value.kind === kind && value.id === id && value.rev === rev) {
          const target = new URL(value.href, location.origin);
          if (target.origin === location.origin && target.pathname !== '/today') {
            location.replace(target.href);
            return;
          }
        }
        invalidatePack();
        throw new Error('活动版本或入口不符。');
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [400, 401, 403, 404, 410].includes(failure.status)) {
          invalidatePack();
        }
        const cached = cachedPack(ref);
        if (failure instanceof TypeError && cached) {
          setPack(cached);
          setError('离线阅读已打开的内置题面。选择保存在本机。');
        } else setError(failure instanceof ApiError ? failure.message : '无法打开这个版本。请联网重试。');
      }
    }
    void read();
    return () => controller.abort();
  }, [foreground, kind, id, rev, key, invalidatePack, reload]);

  useEffect(() => {
    const reconfirm = () => setConsent(false);
    function invalidated(event: StorageEvent) {
      if (event.key !== 'mangekyo:' + key || event.newValue !== null) return;
      resetForm();
      setError('这份题包需要联网重新核对。');
    }
    window.addEventListener('storage', invalidated);
    window.addEventListener('online', reconfirm);
    window.addEventListener('offline', reconfirm);
    return () => {
      window.removeEventListener('storage', invalidated);
      window.removeEventListener('online', reconfirm);
      window.removeEventListener('offline', reconfirm);
    };
  }, [key, resetForm]);
  const clearStale = useCallback(
    (requestId: string) => {
      settleDraft(draftKey, requestId, true);
      if (selectedId.current !== requestId) return;
      selectedId.current = undefined;
      setDraft((current) => (current?.requestId === requestId ? null : current));
      setConsent(false);
      setError('删除状态已变化，旧选择已清除。请重新作答。');
    },
    [draftKey],
  );

  useEffect(() => {
    if (!draft || result) return;
    function reconcile() {
      const current = localStorage.getItem(latestKey);
      if (validWatermark(current) && draft && BigInt(draft.deletionWatermark ?? bindDeletionWatermark(draft.requestId)) < BigInt(current)) {
        clearStale(draft.requestId);
      }
    }
    const stored = (event: StorageEvent) => {
      if (event.key === latestKey) reconcile();
    };
    reconcile();
    window.addEventListener(latestKey, reconcile);
    window.addEventListener('storage', stored);
    return () => {
      window.removeEventListener(latestKey, reconcile);
      window.removeEventListener('storage', stored);
    };
  }, [draft, result, clearStale]);

  function choose(choice: number) {
    if (!pack || busy || !watermark.ready) return;
    try {
      const next = { choice, requestId: submissionId() };
      selectDraft(draftKey, next);
      if (requested !== null) {
        const url = new URL(location.href);
        url.searchParams.set('answer', next.requestId);
        history.replaceState(history.state, '', url);
      }
      selectedId.current = next.requestId;
      setDraft(next);
      setRedo(null);
      setConsent(false);
      setError('');
    } catch {
      setError('无法保存这次选择，请检查浏览器的本机存储。');
    }
  }
  async function submit() {
    if (!pack || !draft || !consent || busy || covering || !currentGeneration) return;
    if (!navigator.onLine) {
      setError('选择已留在本机。联网后请核对并提交。');
      return;
    }
    setBusy(true);
    setConsent(false);
    setError('');
    try {
      const deletionWatermark = draft.deletionWatermark ?? bindDeletionWatermark(draft.requestId);
      try {
        const current = BigInt(await synchronizeDeletion());
        const original = BigInt(deletionWatermark);
        if (current < original) {
          setError('本次未发送。服务端水位低于原请求，选择已保留。');
          return;
        }
        if (current > original) {
          clearStale(draft.requestId);
          return;
        }
      } catch {
        setError('本次未发送。服务端的删除水位暂时无法核对，选择已保留。');
        return;
      }
      if (selectedId.current !== draft.requestId) return;
      if (!cachedPack(refValue)) {
        setError('本机无法核对这份题包，请重新打开。本次未发送。');
        return;
      }
      let frozen;
      try {
        frozen = pendingDraft(refValue, draft, deletionWatermark);
      } catch {
        setError('待核对请求无法保存，本次未发送。');
        return;
      }
      setDraft(frozen);
      const response = await fetch('/api/today/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: frozen.id,
          rev: frozen.rev,
          requestId: frozen.requestId,
          choice: frozen.choice,
          deletionWatermark: frozen.deletionWatermark,
          consent: 'teaching',
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new ApiError(response.status, value?.error, value?.code);
      verifyGenerationReceipt(response, deletionWatermark);
      if (
        typeof value.id !== 'string' ||
        !value.id ||
        !Number.isSafeInteger(value.rev) ||
        value.rev < 1 ||
        !['correct', 'incorrect'].includes(value.result) ||
        typeof value.explanation !== 'string'
      )
        throw new Error('回执未确认');
      settleDraft(draftKey, draft.requestId, true);
      if (selectedId.current !== draft.requestId) return;
      setResult(value);
    } catch (failure) {
      if (selectedId.current !== draft.requestId) return;
      if (deletedSubmission(failure)) {
        clearStale(draft.requestId);
      } else {
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          settleDraft(draftKey, draft.requestId, true);
          resetForm();
        } else if (failure instanceof ApiError && [400, 409, 422].includes(failure.status)) {
          setDraft({ choice: draft.choice, requestId: draft.requestId });
          settleDraft(draftKey, draft.requestId, false);
        }
        setError(
          failure instanceof ApiError ? failure.message : '提交结果待核对。可以用同一选择和原请求重试。',
        );
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="day-sheet">
      <a className="back-link" href={'/today?' + todayParams(mode, duration)}>
        ‹ 返回今天
      </a>
      <h1>{pack?.title ?? '打开活动'}</h1>
      {error && <p role="status">{error}</p>}
      {!pack &&
        (error ? (
          <button className="tonal-button" onClick={() => setReload((n) => n + 1)}>
            重新打开
          </button>
        ) : (
          <p>正在核对活动版本…</p>
        ))}
      {pack && (
        <>
          <small>
            {pack.source} · 第 {rev} 版
          </small>
          {watermark.notice}
          {requested && !draft && !result && <p>这份本机作答已清除。 <a href={openLink(refValue, mode, duration)}>打开题包</a></p>}
          {draft && !result && !draft.pending && watermark.ready && currentGeneration && <ActivityReentry
            slot={'pack:' + id} binding={JSON.stringify([id,rev,draft.requestId])} itemId={id}
            label="上次停在这道短练" onContinue={() => choices.current?.querySelector<HTMLInputElement>('input:checked')?.focus()}
            onCover={() => {setConsent(false); setRedo({requestId:draft.requestId,choice:null});}}/>}
          <fieldset ref={choices} disabled={busy || !!result || draft?.pending || (!!requested && !draft) || !watermark.ready}>
            <legend>{pack.prompt}</legend>
            {pack.choices.map((label, index) => (
              <label key={index} className="today-choice">
                <input
                  type="radio"
                  name="answer"
                  checked={(covering ? redo.choice : draft && currentGeneration && watermark.ready ? draft.choice : null) === index}
                  onChange={() => covering ? setRedo({...redo,choice:index}) : choose(index)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {covering && <>
            <button type="button" className="text-button" onClick={() => setRedo(null)}>保留原选择</button>
            <button type="button" className="tonal-button" disabled={redo.choice === null || !watermark.ready}
              onClick={() => {if (redo.choice !== null) choose(redo.choice);}}>采用新选择</button>
          </>}
          {result ? (
            <section aria-live="polite">
              <h2>{result.result === 'correct' ? '答对了' : '一起核对'}</h2>
              <p>{result.explanation}</p>
            </section>
          ) : (
            <>
              {draft?.pending && <p>上次提交有待核对，本次将沿用原请求。</p>}
              <label className="today-choice">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy || !draft || covering || !currentGeneration}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                同意将这次作答用于教学
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={!draft || !consent || busy || covering || !currentGeneration}
                onClick={() => void submit()}
              >
                {busy ? '正在提交…' : '提交并核对'}
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
