import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { WorkbookQuestionView } from '../../../modules/activity/workbook-values';
import type { reconcileRetention } from '../../../modules/learner/retention';
import { api, ApiError, requestId } from './api';
import { ListLink, ReadState, useResource } from './workspace';
import { ReconciliationResearch } from './research';
import {useVisibleDocument} from './workbook-presentation';
import './workbook.css';

type Entry = { forecastKey: string; title: string; through: string; sourceReconciliationKey?: string } & (
  { state: 'preparing' | 'scheduled'; scheduledAt: string } | { state: 'ready' } | { state: 'submitted'; reconciliationKey: string }
);
type Issue = { id: string; rev: number; item: WorkbookQuestionView };
type Verdict = ReturnType<typeof reconcileRetention>;
type RecordView = { state: 'current'; value: Verdict } | { state: 'pending' | 'blocked' | 'stale' };

const verdictLabels: Record<Verdict['status'], string> = {
  matched: '与预测一致', missed: '与预测不一致', observed: '已记录观察，预测未知',
  contaminated: '受帮助影响', 'awaiting-independent': '等待独立作答证据',
};
const deadline = (through: string) => new Date(through).toLocaleString('zh-CN');

const posttestHref = (key: string) => '/today?posttest=' + encodeURIComponent(key);

function plannedTime(entry: Extract<Entry, { scheduledAt: string }>) {
  const time = deadline(entry.scheduledAt);
  return entry.state === 'preparing' ? `${time} 开始，正在准备` : `${time} 开始`;
}

type FollowupContext = { entries: Entry[]; reload: () => void };

function ScheduleFollowup({ recordKey, entries, reload }: { recordKey: string } & FollowupContext) {
  const existing = entries.find(entry => entry.sourceReconciliationKey === recordKey);
  const [localTime, setLocalTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const intent = useRef<{ requestId: string; scheduledAt: string } | null>(null);
  const sending = useRef(false);

  async function schedule(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    const time = new Date(localTime);
    if (!Number.isFinite(time.getTime()) || time.getTime() <= Date.now()) {
      setFailure('请选择将来的时间。');
      return;
    }
    const scheduledAt = time.toISOString();
    if (intent.current?.scheduledAt !== scheduledAt) intent.current = { requestId: requestId(), scheduledAt };
    sending.current = true;
    setBusy(true);
    setFailure('');
    try {
      const result = await api<{ key: string; state: string }>('/retention/' + encodeURIComponent(recordKey) + '/followup', {
        method: 'POST', body: intent.current,
      });
      if (result.state === 'stale' || result.state === 'blocked') {
        setFailure('此次后测当前不可用，请返回今天查看。');
      } else {
        setScheduledTime(scheduledAt);
      }
      reload();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : '暂时无法确认安排，请重试。');
      reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  if (existing) {
    const detail = existing.state === 'scheduled' || existing.state === 'preparing' ? '已安排 · ' + plannedTime(existing) :
      existing.state === 'submitted' ? '已交卷' : '已到时间';
    return <p role="status">下一次后测{detail}{' '}<a href={posttestHref(existing.forecastKey)}>查看后测</a></p>;
  }
  if (scheduledTime) return <p role="status">已收到后测安排 · {deadline(scheduledTime)}{' '}
    <a href="/today">返回今天查看</a></p>;
  return <form className="research-choice" onSubmit={schedule}>
    <label className="field">下一次后测时间（当地时间）
      <input required type="datetime-local" value={localTime} disabled={busy}
        onChange={event => { setLocalTime(event.target.value); setFailure(''); }} />
    </label>
    {failure && <p role="alert">{failure}</p>}
    <button className="tonal-button" disabled={busy || !localTime}>{busy ? '正在安排…' : '安排后测'}</button>
  </form>;
}

function Reconciliation({ recordKey, entries, reload: reloadList }: { recordKey: string } & FollowupContext) {
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
    {observation.exposure.kind === 'independent' && observation.result !== 'unknown' &&
      <ScheduleFollowup recordKey={recordKey} entries={entries} reload={reloadList} />}
    {status === 'missed' && observation.result === 'incorrect' && observation.exposure.kind === 'independent' &&
      <ReconciliationResearch key={recordKey} recordKey={recordKey} />}
  </>;
}

function AnswerForm({ issue, path, submitted, withdrawn }: { issue: Issue; path: string; submitted: (key: string) => void; withdrawn: (message: string) => void }) {
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
      if (error instanceof ApiError && [403, 404, 409].includes(error.status)) {
        withdrawn(error.message);
        return;
      }
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

function OpenPosttest({ entry, entries, reload }: { entry: Entry } & FollowupContext) {
  const path = '/retention/' + encodeURIComponent(entry.forecastKey) + '/posttest';
  const [issue, setIssue] = useState<Issue>();
  const visible = useVisibleDocument();
  const [receipt, setReceipt] = useState('');
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (entry.state !== 'ready' || !visible || issue || receipt || failure) return;
    const controller = new AbortController();
    api<Issue>(path, { method: 'POST', body: {}, signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) setIssue(next); }).catch(error => {
        if (!controller.signal.aborted) setFailure(error instanceof ApiError ? error.message : '暂时无法打开后测。');
      });
    return () => controller.abort();
  }, [entry.state, path, visible, issue, receipt, failure]);
  const key = entry.state === 'submitted' ? entry.reconciliationKey : receipt;
  return <section className="workbook-attempt-panel">
    <div className="subhead"><h2>{entry.title}</h2><a href="/today">返回今天</a></div>
    {entry.state === 'scheduled' || entry.state === 'preparing' ? <p role="status">后测已安排 · {plannedTime(entry)}</p> : key ? <><h3>后测对账</h3><Reconciliation key={key} recordKey={key} entries={entries} reload={reload} /></> : <>
      <p className="muted">独立完成 · 截止 {deadline(entry.through)}</p>
      {failure ? <p role="alert">{failure} <a href={location.href}>重新读取</a></p> :
        visible && issue ? <AnswerForm issue={issue} path={path} submitted={setReceipt} withdrawn={message => {setIssue(undefined); setFailure(message);}} /> : <p role="status">正在打开题目…</p>}
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
  useEffect(() => {
    if (list.error || !list.data) return;
    const now = Date.now();
    const times = list.data.items.flatMap(entry => entry.state === 'scheduled' ? [Date.parse(entry.scheduledAt)] :
      entry.state === 'preparing' ? [now + 1500] : []);
    if (!times.length) return;
    const delay = Math.min(...times) - now;
    const timer = setTimeout(list.reload, Math.min(delay > 0 ? delay : 5000, 2147483647));
    return () => clearTimeout(timer);
  }, [list.data, list.error, list.reload]);
  if (list.error || !list.data) return <ReadState resource={list} />;
  if (selected !== undefined) {
    const entry = list.data.items.find(item => item.forecastKey === selected);
    return entry ? <OpenPosttest key={entry.forecastKey} entry={entry} entries={list.data.items} reload={list.reload} /> : <p role="status">此次后测当前不可用。 <a href="/today">返回今天</a></p>;
  }
  return <>{list.data.items.map(entry => <ListLink key={entry.forecastKey}
    href={posttestHref(entry.forecastKey)} title={entry.title} icon="practice"
    detail={entry.state === 'submitted' ? '已交卷 · 查看后测对账' : entry.state === 'scheduled' || entry.state === 'preparing'
      ? '后测已安排 · ' + plannedTime(entry) : '保持后测 · 截止 ' + deadline(entry.through)} />)}</>;
}
