import { useDraftWatermark } from './draft-watermark';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, deletedSubmission, remember, remembered, submissionId } from './api';
import {
  bindDeletionWatermark,
  latestKey,
  synchronizeDeletion,
  verifyGenerationReceipt,
  validWatermark,
} from './deletion-watermark';

export type ActivityRef = { kind: 'activity' | 'pack'; id: string; rev: number };
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
type Draft = { choice: number; requestId: string; pending?: boolean };
type Result = { id: string; rev: number; result: 'correct' | 'incorrect'; explanation: string };

export function openLink(ref: ActivityRef, mode: string) {
  return '/today?' + new URLSearchParams({ mode, kind: ref.kind, id: ref.id, rev: String(ref.rev) });
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

export function TodayActivity({ refValue, mode }: { refValue: ActivityRef; mode: string }) {
  const { kind, id, rev } = refValue;
  const watermark = useDraftWatermark();
  const key = 'today-pack:' + encodeURIComponent(id) + '@' + rev;
  const draftKey = key + ':answer';
  const [pack, setPack] = useState<Pack | null>(null);
  const [draft, setDraft] = useState<Draft | null>(() => local(draftKey));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
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
        throw new Error('活动版本或入口不符。');
      } catch (failure) {
        if (controller.signal.aborted) return;
        const cached = local<Pack>(key);
        if (!navigator.onLine && frozenPack(cached, ref)) {
          setPack(cached);
          setError('离线阅读已打开的内置题面。选择保存在本机。');
        } else setError(failure instanceof ApiError ? failure.message : '无法打开这个版本。请联网重试。');
      }
    }
    void read();
    return () => controller.abort();
  }, [kind, id, rev, key, reload]);

  useEffect(() => {
    const reconfirm = () => setConsent(false);
    window.addEventListener('online', reconfirm);
    window.addEventListener('offline', reconfirm);
    return () => {
      window.removeEventListener('online', reconfirm);
      window.removeEventListener('offline', reconfirm);
    };
  }, []);
  const clearStale = useCallback(
    (requestId: string) => {
      if (local<Draft>(draftKey)?.requestId === requestId) remember(draftKey, null);
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
      if (validWatermark(current) && draft && BigInt(bindDeletionWatermark(draft.requestId)) < BigInt(current)) {
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
    const next = { choice, requestId: submissionId() };
    setDraft(next);
    remember(draftKey, JSON.stringify(next));
    setConsent(false);
    setError('');
  }
  async function submit() {
    if (!pack || !draft || !consent || busy) return;
    if (!navigator.onLine) {
      setError('选择已留在本机。联网后请核对并提交。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const deletionWatermark = bindDeletionWatermark(draft.requestId);
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
      remember(draftKey, JSON.stringify({ ...draft, pending: true }));
      setDraft({ ...draft, pending: true });
      const response = await fetch('/api/today/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          rev,
          requestId: draft.requestId,
          choice: draft.choice,
          deletionWatermark,
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
      setResult(value);
      remember(draftKey, null);
    } catch (failure) {
      if (deletedSubmission(failure)) {
        clearStale(draft.requestId);
      } else {
        if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
          const editable = { ...draft, pending: false };
          setDraft(editable);
          remember(draftKey, JSON.stringify(editable));
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
      <a className="back-link" href={'/today?mode=' + mode}>
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
          <fieldset disabled={busy || !!result || draft?.pending || !watermark.ready}>
            <legend>{pack.prompt}</legend>
            {pack.choices.map((label, index) => (
              <label key={index} className="today-choice">
                <input
                  type="radio"
                  name="answer"
                  checked={draft?.choice === index}
                  onChange={() => choose(index)}
                />
                {label}
              </label>
            ))}
          </fieldset>
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
                  disabled={busy || !draft}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                同意将这次作答用于教学
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={!draft || !consent || busy}
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
