import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { WorkbookQuestionView } from '../../../modules/activity/workbook-values';
import type { reconcileRetention } from '../../../modules/learner/retention';
import { api, ApiError } from './api';
import { ListLink, ReadState, useResource } from './workspace';
import { ReconciliationResearch } from './research';
import './workbook.css';

type Entry = { forecastKey: string; title: string; through: string } & (
  { state: 'ready' } | { state: 'submitted'; reconciliationKey: string }
);
type Issue = { id: string; rev: number; item: WorkbookQuestionView };
type Verdict = ReturnType<typeof reconcileRetention>;
type RecordView = { state: 'current'; value: Verdict } | { state: 'pending' | 'blocked' | 'stale' };

const verdictLabels: Record<Verdict['status'], string> = {
  matched: '与预测一致', missed: '与预测不一致', observed: '已记录观察，预测未知',
  contaminated: '受帮助影响', 'awaiting-independent': '等待独立作答证据',
};
const deadline = (through: string) => new Date(through).toLocaleString('zh-CN');

function Reconciliation({ recordKey }: { recordKey: string }) {
  const record = useResource<RecordView>('/retention/' + encodeURIComponent(recordKey));
  const { data, error, reload } = record;
  useEffect(() => {
    if (error || data?.state !== 'pending') return;
    const timer = setTimeout(reload, 1500);
    return () => clearTimeout(timer);
  }, [data, error, reload]);

  if (error || !data) return <ReadState resource={record} />;
  if (data.state === 'pending') return <p role="status">已交卷，正在等待对账结果…</p>;
  if (data.state !== 'current') return <p role="status">已交卷，当前没有可读的对账结果。 <a href={location.href}>重新读取</a></p>;
  const { status, observation } = data.value;
  return <>
    <dl id="posttest-result" tabIndex={-1}>
      <dt>作答结果</dt><dd>{{ correct: '答对', incorrect: '答错', unknown: '未知' }[observation.result] ?? '未知'}</dd>
      <dt>帮助情况</dt><dd>{{ independent: '独立作答', exposed: '接触过帮助', unknown: '未知' }[observation.exposure.kind] ?? '未知'}</dd>
      <dt>预测对账</dt><dd>{verdictLabels[status] ?? '未知'}</dd>
    </dl>
    {status === 'missed' && observation.result === 'incorrect' && observation.exposure.kind === 'independent' &&
      <ReconciliationResearch key={recordKey} recordKey={recordKey} />}
  </>;
}

function AnswerForm({ issue, path, submitted }: { issue: Issue; path: string; submitted: (key: string) => void }) {
  const draftKey = 'mangekyo:posttest:' + issue.id + ':' + issue.rev;
  const [answer, setAnswer] = useState(() => {
    try { return sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; }
  });
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [needsCheck, setNeedsCheck] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || needsCheck || !answer.trim()) return;
    sending.current = true;
    setBusy(true);
    setFailure('');
    try {
      const receipt = await api<{ reconciliation: { key: string } }>(path + '/' + issue.id + '/submission', {
        method: 'POST', body: { answer },
      });
      try { sessionStorage.removeItem(draftKey); } catch { /* Storage is optional. */ }
      submitted(receipt.reconciliation.key);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : '暂时无法确认交卷结果。');
      setNeedsCheck(!(error instanceof ApiError && error.status === 400));
      sending.current = false;
      setBusy(false);
    }
  }
  return <form onSubmit={submit}>
    <label className="field"><span className="workbook-answer-prompt">{issue.item.prompt}</span>
      {issue.item.kind === 'numeric' && issue.item.unit && <small>单位：{issue.item.unit}</small>}
      <textarea value={answer} maxLength={4000} required readOnly={busy || needsCheck} onChange={event => {
        const value = event.target.value;
        setAnswer(value);
        try { sessionStorage.setItem(draftKey, value); } catch { /* Retain the in-memory answer. */ }
      }} />
    </label>
    {failure && <p role="alert">{failure}</p>}
    <div className="study-actions workbook-attempt-actions">
      {needsCheck ? <a className="tonal-button" href={location.href}>重新确认后测状态</a> :
        <button className="primary-button" disabled={busy || !answer.trim()}>{busy ? '正在交卷…' : '交卷'}</button>}
    </div>
  </form>;
}

function OpenPosttest({ entry }: { entry: Entry }) {
  const path = '/retention/' + encodeURIComponent(entry.forecastKey) + '/posttest';
  const [issue, setIssue] = useState<Issue>();
  const [receipt, setReceipt] = useState('');
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (entry.state !== 'ready') return;
    const controller = new AbortController();
    api<Issue>(path, { method: 'POST', body: {}, signal: controller.signal })
      .then(setIssue).catch(error => {
        if (!controller.signal.aborted) setFailure(error instanceof ApiError ? error.message : '暂时无法打开后测。');
      });
    return () => controller.abort();
  }, [entry.state, path]);
  const key = entry.state === 'submitted' ? entry.reconciliationKey : receipt;
  return <section className="workbook-attempt-panel">
    <div className="subhead"><h2>{entry.title}</h2><a href="/today">返回今天</a></div>
    {key ? <><h3>后测对账</h3><Reconciliation key={key} recordKey={key} /></> : <>
      <p className="muted">独立完成 · 截止 {deadline(entry.through)}</p>
      {failure ? <p role="alert">{failure} <a href={location.href}>重新读取</a></p> :
        issue ? <AnswerForm issue={issue} path={path} submitted={setReceipt} /> : <p role="status">正在打开题目…</p>}
    </>}
  </section>;
}

export function RetentionPosttests({ selected }: { selected?: string }) {
  const list = useResource<{ items: Entry[] }>('/retention/posttests');
  useEffect(() => {
    function restore(event: PageTransitionEvent) { if (event.persisted) location.reload(); }
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);
  if (list.error || !list.data) return <ReadState resource={list} />;
  if (selected !== undefined) {
    const entry = list.data.items.find(item => item.forecastKey === selected);
    return entry ? <OpenPosttest entry={entry} /> : <p role="status">此次后测当前不可用。 <a href="/today">返回今天</a></p>;
  }
  return <>{list.data.items.map(entry => <ListLink key={entry.forecastKey}
    href={'/today?posttest=' + encodeURIComponent(entry.forecastKey)} title={entry.title} icon="practice"
    detail={entry.state === 'submitted' ? '已交卷 · 查看后测对账' : '保持后测 · 截止 ' + deadline(entry.through)} />)}</>;
}
