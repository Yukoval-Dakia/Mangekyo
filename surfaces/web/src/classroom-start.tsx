import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, requestId, type Settings } from './api';
import { recordFromQuery, recordLabel } from './current-record';
import { chatRoute } from './model-route';
import { PageTitle } from './workspace';
import { recentRooms, rejected, rememberRoom, roomPath, roomApi, writeRoom, type Classroom, type ClassroomWrite } from './classroom-contract';

export function ClassroomStart({ settings }: {settings?: Settings | undefined}) {
  const query = new URLSearchParams(location.search);
  const currentObject = recordFromQuery(query);
  const [topic, setTopic] = useState('');
  const [minutes, setMinutes] = useState('');
  const [pending, setPending] = useState<ClassroomWrite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const from = query.get('from');
  const [seed, setSeed] = useState<'loading' | 'ready' | 'failed'>(from ? 'loading' : 'ready');
  useEffect(() => {
    if (!from) return;
    const controller = new AbortController();
    void api<Classroom>(roomApi(from), {signal: controller.signal}).then(prior => {
      if (prior.id !== from) throw new Error();
      if (controller.signal.aborted) return;
      setTopic(prior.topic);
      setMinutes(String(prior.minutes));
      setSeed('ready');
    }).catch(() => {if (!controller.signal.aborted) setSeed('failed');});
    return () => controller.abort();
  }, [from]);
  const route = settings && chatRoute(settings, 'companion');
  const blocked = !route || (currentObject && !route.accountRevision);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || blocked || !topic.trim()) return;
    sending.current = true;
    setBusy(true);
    setError('');
    const operation = pending ?? {path: '/classrooms', body: {
      requestId: requestId(), topic: topic.trim(), ...(minutes && {minutes: Number(minutes)}),
      ...(currentObject && {currentObject}), route,
    }};
    setPending(operation);
    try {
      const room = await writeRoom(operation);
      rememberRoom(room.id);
      location.assign(roomPath(room.id));
    } catch (failure) {
      if (rejected(failure)) setPending(undefined);
      setError(failure instanceof ApiError ? failure.message : '尚未收到开课回执，可重发同一请求。');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const rooms = recentRooms();
  if (seed !== 'ready') return <><PageTitle title="学习课堂" /><p role="status">{seed === 'loading' ? '正在读取原课堂…' : '当前无法读取原课堂主题。'}</p><a href="/classroom">自行填写主题</a></>;
  if (query.has('record') && !currentObject) return <><PageTitle title="学习课堂" /><p role="alert">记录链接缺少有效版本，请从原记录重新进入。</p><a href="/classroom">按主题开课</a></>;
  return <>
    <PageTitle title="学习课堂" />
    <form className="reading-paper classroom-form" onSubmit={submit}>
      <label className="field classroom-field">这节课想学什么？<textarea required maxLength={300} value={topic} disabled={!!pending} onChange={event => setTopic(event.target.value)} rows={4} placeholder="写下你想搞懂的知识点、卡住的一道题，或直接贴上题干…" /></label>
      <div className="classroom-minutes">
        <label className="field classroom-field">可用时间（分钟，可选）<input type="number" min="5" max="90" step="1" value={minutes} disabled={!!pending} onChange={event => setMinutes(event.target.value)} placeholder="例如 20" /></label>
        <div className="classroom-quick" role="group" aria-label="快捷时长">
          {[10,20,30].map(value => <button key={value} type="button" className="classroom-pill" data-active={minutes === String(value)} disabled={!!pending} onClick={() => setMinutes(String(value))}>{value} 分钟</button>)}
        </div>
      </div>
      {currentObject && <p>随课使用的记录：{recordLabel(currentObject)}　<a href="/classroom">解除关联</a></p>}
      {route && <p className="classroom-route">本次教学账户 · {route.model}</p>}
      {blocked && <p role="status">请检查学习设置中的教学账户后刷新。</p>}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status" className="classroom-form-wait">正在为你开课；首次生成课堂通常需要一到两分钟，请勿重复提交。</p>}
      <button className="primary-button" disabled={busy || !!blocked || !topic.trim()}>{busy ? '正在开课…' : pending ? '重发开课请求' : '开始上课'}</button>
    </form>
    {!!rooms.length && <section className="surface-section"><h2>本机打开过的课堂</h2><ul>{rooms.map(id => <li key={id}><a href={roomPath(id)}>打开课堂 · {id.slice(-8)}</a></li>)}</ul></section>}
  </>;
}
