import { useEffect, useRef, useState } from 'react';
import { api, ApiError, requestId } from './api';

type Witness = { id: string; rev: number; accessEpoch: string };
const kinds = { preference: '偏好', claim: '自述', state: '近期状态', observation: '观察', misconception: '错因', playbook: '学习方法' };
const directions = { support: '支持证据', contradict: '相反证据', unresolved: '未决证据' };
const outcomes = { supported: '有证据支持', contradicted: '有相反证据', unresolved: '未决' };
type Citation = Witness & { anchor: string; excerpt: string; direction: keyof typeof directions };
type Entry = {
  ref: Witness;
  evidenceState: 'current' | 'unavailable';
  understanding: {
    text: string | null;
    kind: keyof typeof kinds;
    scope: { kind: 'general' } | { kind: 'object'; object: string } | null;
    ttl: string | null;
    sticky: boolean;
    undo_token: string;
    evidence_refs: Citation[];
    review?: { kind: 'value'; value: { outcome: { kind: keyof typeof outcomes } } } | { kind: 'unknown'; reason: string };
  };
};
type Draft = { ref: Witness; text: string };
type Action = 'correct' | 'forget' | 'undo';
const path = '/memory/claims';

export function LearningUnderstandings() {
  const [entries, setEntries] = useState<Entry[]>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [version, setVersion] = useState(0);
  const [readError, setReadError] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const intent = useRef<{ key: string; id: string } | null>(null);

  function refresh() {
    setEntries(undefined);
    setReadError(false);
    setVersion(current => current + 1);
  }

  useEffect(() => {
    function onShow(event: PageTransitionEvent) { if (event.persisted) refresh(); }
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<{ understandings: Entry[] }>(path, { signal: controller.signal }).then(({ understandings }) => {
      if (controller.signal.aborted) return;
      setEntries(understandings);
      setDraft(old => old && understandings.some(item => item.ref.id === old.ref.id && item.evidenceState === 'current') ? old : null);
    }).catch(() => { if (!controller.signal.aborted) setReadError(true); });
    return () => controller.abort();
  }, [version]);

  async function manage(entry: Entry, action: Action) {
    const { id, rev, accessEpoch } = entry.ref;
    const change = { action, rev, accessEpoch, ...(action === 'correct' && { text: draft!.text.trim() }) };
    const key = JSON.stringify([id, change]);
    if (intent.current?.key !== key) intent.current = { key, id: requestId() };
    setBusy(true);
    setStatus('');
    try {
      if (action === 'undo') {
        await api(path + '/' + id + '/undo', { method: 'POST', body: { undo_token: entry.understanding.undo_token } });
      } else {
        await api(path + '/' + id, { method: 'POST', body: { ...change, requestId: intent.current.id } });
      }
      if (draft?.ref.id === id) setDraft(null);
      intent.current = null;
      setStatus({ correct: '更正已保存。', forget: '已忘掉这条理解。', undo: '已撤回这次后台记录。' }[action]);
      refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setStatus('记录或依据已变化。请核对刷新后的记录再操作。');
        refresh();
      } else {
        setStatus('操作结果暂时无法确认。请刷新查看，或重试。');
      }
    } finally { setBusy(false); }
  }

  return <section className="surface-section memory-panel" aria-labelledby="understandings-heading">
    <div className="subhead"><h2 id="understandings-heading">同伴对我的理解</h2>
      <button className="text-button" disabled={busy || (!entries && !readError)} onClick={refresh}>刷新理解</button>
    </div>
    {status && <p role="status">{status}</p>}
    {readError ? <p role="alert">暂时无法读取学习理解，请刷新重试。</p>
      : !entries ? <p role="status">正在读取学习理解…</p>
      : !entries.length && <p>尚无来自已获准学习活动的理解。</p>}
    {entries?.map(entry => {
      const { ref, understanding: data } = entry;
      const readable = entry.evidenceState === 'current' && data.text !== null;
      const editing = readable && draft?.ref.id === ref.id;
      const changed = editing && (draft.ref.rev !== ref.rev || draft.ref.accessEpoch !== ref.accessEpoch);
      return <article className="review-item understanding-entry" key={ref.id}>
        {readable ? <>
          <p className="muted">{kinds[data.kind]} · {data.review?.kind === 'value' ? outcomes[data.review.value.outcome.kind] : '证据待核实'}
            {data.sticky && ' · 本人已更正'}</p>
          <h3>{data.text}</h3>
          <p className="muted">{data.scope?.kind === 'object' ? '适用于活动 ' + data.scope.object : '通用理解'}
            {data.ttl && ' · 有效至 ' + new Date(data.ttl).toLocaleString()}</p>
          <details><summary>查看活动依据（{data.evidence_refs.length}）</summary>
            {data.evidence_refs.map(source => <figure key={source.id}>
              <figcaption>{directions[source.direction]} · {source.anchor}</figcaption>
              <blockquote>{source.excerpt}</blockquote>
            </figure>)}
          </details>
        </> : <><h3>活动依据已不可用</h3><p>这条理解的正文与引用已隐藏。</p></>}
        {editing ? <form onSubmit={event => { event.preventDefault(); if (!busy && !changed && draft.text.trim()) void manage(entry, 'correct'); }}>
          <label className="field"><span>我的更正</span><textarea rows={3} maxLength={600} disabled={busy} value={draft.text}
            onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
          <div className="study-actions">
            {changed && <button className="tonal-button" type="button" onClick={() => setDraft({ ...draft, ref })}>已核对新版，保留草稿</button>}
            <button className="primary-button" disabled={busy || changed || !draft.text.trim()}>保存更正</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button>
          </div>
        </form> : <div className="study-actions">
          {readable && <button className="tonal-button" disabled={busy || !!draft} onClick={() => { setStatus(''); setDraft({ ref, text: data.text! }); }}>更正</button>}
          <button className="text-button" disabled={busy} onClick={() => void manage(entry, 'forget')}>忘掉这条理解</button>
          {!data.sticky && data.undo_token && <button className="text-button" disabled={busy} onClick={() => void manage(entry, 'undo')}>撤回后台记录</button>}
        </div>}
      </article>;
    })}
  </section>;
}
