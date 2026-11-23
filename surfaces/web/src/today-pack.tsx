import {useVisibleDocument} from './workbook-presentation';
import {ActivityReentry, useCurrentDraft} from './activity-reentry';
import { answerKey, forgetPackDrafts, recoverDraft, selectDraft, pendingDraft, settleDraft, type Draft } from './today-draft';
import { useDraftWatermark } from './draft-watermark';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, deletedSubmission, remember, remembered, submissionId } from './api';
import MathText from './math-text';
import { citeToCompanionDrawer } from './shell/AppShell';
import {
  bindDeletionWatermark,
  latestKey,
  synchronizeDeletion,
  verifyGenerationReceipt,
  validWatermark,
} from './deletion-watermark';
import './today-pack.css';

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
  const choices = useRef<HTMLDivElement>(null);
  const covering = !!redo && redo.requestId === draft?.requestId && currentGeneration;
  const selectedId = useRef(draft?.requestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [reload, setReload] = useState(0);
  const [scratch, setScratch] = useState(() => remembered(scratchKey(refValue)) ?? '');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [paused, setPaused] = useState(false);
  const resetForm = useCallback(() => {
    selectedId.current = undefined;
    setRedo(null);
    setDraft(null);
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
    function invalidated(event: StorageEvent) {
      if (event.key !== 'mangekyo:' + key || event.newValue !== null) return;
      resetForm();
      setError('这份题包需要联网重新核对。');
    }
    window.addEventListener('storage', invalidated);
    return () => {
      window.removeEventListener('storage', invalidated);
    };
  }, [key, resetForm]);

  useEffect(() => {
    if (result || paused) return;
    const timer = window.setInterval(() => setElapsedSeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [result, paused]);

  useEffect(() => {
    setElapsedSeconds(0);
    setPaused(false);
    setScratch(remembered(scratchKey(refValue)) ?? '');
  }, [key, id, rev]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!pack || result || busy) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === 'TEXTAREA' || tag === 'INPUT' || Boolean(target?.isContentEditable);
      if (!typing && /^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (index < pack.choices.length) {
          event.preventDefault();
          if (covering) setRedo({ requestId: draft!.requestId, choice: index });
          else choose(index);
        }
        return;
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void submit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const clearStale = useCallback(
    (requestId: string) => {
      settleDraft(draftKey, requestId, true);
      if (selectedId.current !== requestId) return;
      selectedId.current = undefined;
      setDraft((current) => (current?.requestId === requestId ? null : current));
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
      setError('');
    } catch {
      setError('无法保存这次选择，请检查浏览器的本机存储。');
    }
  }

  function updateScratch(value: string) {
    setScratch(value);
    remember(scratchKey(refValue), value || null);
  }

  function citePack() {
    if (!pack) return;
    citeToCompanionDrawer({
      title: pack.title,
      topic: pack.source,
      text: `题目：${pack.prompt}\n选项：\n${pack.choices.map((label, index) => `${String.fromCharCode(65 + index)}. ${label}`).join('\n')}`,
    });
  }

  function citeResult() {
    if (!pack || !result) return;
    const mine = draft?.choice !== null && draft?.choice !== undefined ? pack.choices[draft.choice] : '（未记录）';
    citeToCompanionDrawer({
      title: `讲透：${pack.title}`,
      topic: pack.source,
      text: `题目：${pack.prompt}\n选项：\n${pack.choices.map((label, index) => `${String.fromCharCode(65 + index)}. ${label}`).join('\n')}\n我的作答：${mine}\n判定：${result.result === 'correct' ? '答对' : '需要核对'}\n解析：${result.explanation}`,
    });
  }

  async function submit() {
    if (!pack || !draft || busy || covering || !currentGeneration) return;
    if (!navigator.onLine) {
      setError('选择已留在本机。联网后请核对并提交。');
      return;
    }
    setBusy(true);
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

  const answeredIndex = covering ? redo.choice : draft && currentGeneration && watermark.ready ? draft.choice : null;
  const focusSeconds = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;

  return (
    <section className="study-desk" aria-label="答题书桌">
      <div className="study-desk-topbar">
        <a className="study-desk-back" href={'/today?' + todayParams(mode, duration)}>
          ‹ 返回今天
        </a>
        {pack && (
          <span className="study-desk-meta">
            <span className="study-desk-chip">{pack.source}</span>
            <span className="study-desk-chip study-desk-chip--rev">第 {rev} 版</span>
          </span>
        )}
        {pack && !result && (
          <div className="study-desk-tools">
            <button
              type="button"
              className="study-desk-timer"
              onClick={() => setPaused(value => !value)}
              aria-pressed={paused}
              title={paused ? '继续计时' : '暂停计时'}
            >
              <span className="study-desk-timer-dot" aria-hidden="true" />
              {focusSeconds}
            </button>
            <button type="button" className="study-desk-companion" onClick={citePack}>
              卡住了？问同伴
            </button>
          </div>
        )}
      </div>

      <h1 className="study-desk-title">{pack?.title ?? '打开活动'}</h1>
      {error && <p role="status" className="study-desk-error">{error}</p>}
      {!pack &&
        (error ? (
          <button className="tonal-button" onClick={() => setReload((n) => n + 1)}>
            重新打开
          </button>
        ) : (
          <p className="study-desk-loading">正在核对活动版本…</p>
        ))}
      {pack && (
        <>
          {watermark.notice}
          {requested && !draft && !result && (
            <p className="study-desk-note">
              这份本机作答已清除。 <a href={openLink(refValue, mode, duration)}>打开题包</a>
            </p>
          )}
          {draft && !result && !draft.pending && watermark.ready && currentGeneration && (
            <ActivityReentry
              slot={'pack:' + id}
              binding={JSON.stringify([id, rev, draft.requestId])}
              itemId={id}
              label="上次停在这道短练"
              onContinue={() => choices.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()}
              onCover={() => setRedo({ requestId: draft.requestId, choice: null })}
            />
          )}

          <section className="study-desk-prompt" aria-label="题干">
            <MathText text={pack.prompt} />
          </section>

          <div
            ref={choices}
            className="study-desk-choices"
            role="radiogroup"
            aria-label="选项"
            aria-disabled={busy || !!result || draft?.pending || (!!requested && !draft) || !watermark.ready}
          >
            {pack.choices.map((label, index) => {
              const letter = String.fromCharCode(65 + index);
              const selected = answeredIndex === index;
              const isMine = draft?.choice === index;
              const state = result
                ? result.result === 'correct'
                  ? isMine
                    ? 'correct'
                    : 'idle'
                  : isMine
                    ? 'wrong'
                    : 'idle'
                : selected
                  ? 'selected'
                  : 'idle';
              return (
                <button
                  key={index}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy || !!result || draft?.pending || (!!requested && !draft) || !watermark.ready}
                  className={`study-desk-choice study-desk-choice--${state}`}
                  onClick={() => (covering ? setRedo({ requestId: draft!.requestId, choice: index }) : choose(index))}
                >
                  <span className="study-desk-choice-letter" aria-hidden="true">{letter}</span>
                  <span className="study-desk-choice-text"><MathText text={label} /></span>
                  <span className="study-desk-choice-key" aria-hidden="true">{index + 1}</span>
                </button>
              );
            })}
          </div>

          {covering && (
            <div className="study-desk-redo" role="status">
              <span>正在盖住原选择。</span>
              <button type="button" className="text-button" onClick={() => setRedo(null)}>保留原选择</button>
              <button
                type="button"
                className="tonal-button"
                disabled={redo.choice === null || !watermark.ready}
                onClick={() => { if (redo.choice !== null) choose(redo.choice); }}
              >
                采用新选择
              </button>
            </div>
          )}

          {!result && (
            <details className="study-desk-scratch">
              <summary>
                草稿区 / 解题思路
                {scratch.trim() ? <span className="study-desk-scratch-badge">有草稿</span> : null}
              </summary>
              <div className="study-desk-scratch-body">
                <textarea
                  rows={5}
                  value={scratch}
                  maxLength={4000}
                  placeholder="在这里推演、列式、记疑点…（仅保存在这台电脑上）"
                  onChange={event => updateScratch(event.currentTarget.value)}
                />
                <div className="study-desk-scratch-actions">
                  <span className="study-desk-scratch-hint">{scratch.trim() ? `${scratch.trim().length} 字 · 本机自动保存` : '本机自动保存'}</span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!scratch}
                    onClick={() => updateScratch('')}
                  >
                    清空草稿
                  </button>
                </div>
              </div>
            </details>
          )}

          {result ? (
            <section className={`study-desk-result study-desk-result--${result.result}`} aria-live="polite" aria-label="核对结果">
              <div className="study-desk-result-band" aria-hidden="true" />
              <div className="study-desk-result-body">
                <p className="study-desk-result-title">
                  {result.result === 'correct' ? '答对了' : '再核对一下'}
                </p>
                <div className="study-desk-result-explanation">
                  <MathText text={result.explanation} />
                </div>
                <div className="study-desk-result-actions">
                  <button type="button" className="primary-button" onClick={citeResult}>
                    让同伴深入讲透这道题
                  </button>
                  <a className="tonal-button" href={'/today?' + todayParams(mode, duration)}>
                    返回今天继续下一项
                  </a>
                </div>
              </div>
            </section>
          ) : (
            <div className="study-desk-submitbar">
              {draft?.pending && <p className="study-desk-note">上次提交有待核对，本次将沿用原请求。</p>}
              <button
                type="button"
                className="primary-button study-desk-submit"
                disabled={!draft || draft.choice === null || busy || covering || !currentGeneration}
                onClick={() => void submit()}
              >
                {busy ? '正在提交…' : '提交并核对'}
              </button>
              <span className="study-desk-submit-hint">⌘ / Ctrl + Enter 提交 · 1–{pack.choices.length} 快选</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function scratchKey(ref: ActivityRef) {
  return 'today-pack-scratch:' + encodeURIComponent(ref.id) + '@' + ref.rev;
}
