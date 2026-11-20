import { useEffect, useRef, useState } from 'react';
import { api, ApiError, requestId } from './api';
import { PageTitle } from './workspace';
import { rejected, rememberRoom, roomApi, writeRoom, type Classroom, type ClassroomWrite } from './classroom-contract';
import { ClassroomLesson } from './classroom-turns';
import './classroom.css';

type Action = 'adjust' | 'advance' | 'skip' | 'finish' | 'archive';
const states = {active: '上课中', finished: '已结课', archived: '已归档'};

export function ClassroomRoom({id}: {id: string}) {
  const [room, setRoom] = useState<Classroom>();
  const [rechecking, setRechecking] = useState(false);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [pending, setPending] = useState<ClassroomWrite>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [reload, setReload] = useState(0);
  const sending = useRef(false);
  const reads = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      clearTimeout(timer);
      const seq = ++reads.current;
      if (document.hidden || sending.current) return;
      try {
        const next = await api<Classroom>(roomApi(id), {signal: controller.signal});
        if (next.id !== id) throw new Error();
        if (controller.signal.aborted || seq !== reads.current) return;
        setRoom(next);
        setRechecking(false);
        setReadError('');
        rememberRoom(id);
      } catch (error) {
        if (controller.signal.aborted || seq !== reads.current) return;
        setRoom(undefined);
        setReadError(error instanceof ApiError && error.status === 404 ? '当前无法访问这节课。' : '暂时无法读取课堂。');
        return;
      }
      if (!controller.signal.aborted) timer = setTimeout(read, 3000);
    }
    function visibility() {
      setRechecking(true);
      void read();
    }
    void read();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pageshow', visibility);
    return () => {controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pageshow', visibility);};
  }, [id, reload]);

  async function submit(action: Action, retry = false) {
    if (!room || sending.current || (!retry && pending)) return;
    sending.current = true;
    reads.current++;
    setBusy(true);
    setWriteError('');
    const op = retry && pending ? pending : {path: roomApi(id) + '/' + action, body: {
      requestId: requestId(), expectedRev: room.rev, ...(action === 'adjust' && note.trim() && {note: note.trim()}),
    }};
    setPending(op);
    try {
      const next = await writeRoom(op);
      if (next.id !== id) throw new Error();
      if (!document.hidden) setRoom(next);
      if (op.path.endsWith('/adjust')) setNote('');
      setPending(undefined);
    } catch (failure) {
      if (rejected(failure)) setPending(undefined);
      if (failure instanceof ApiError && [403,404,409].includes(failure.status)) setRoom(undefined);
      setWriteError(failure instanceof ApiError ? failure.message : '尚未收到操作回执，可重发原请求。');
    } finally {
      sending.current = false;
      setBusy(false);
      setReload(n => n + 1);
    }
  }

  if (!room) return <><a href="/classroom">返回学习课堂</a><p role="status">{readError || '正在读取课堂…'}</p>{readError && <button onClick={() => setReload(n => n + 1)}>重新读取</button>}</>;
  return <>
    <a className="back-link" href="/classroom">‹ 学习课堂</a>
    {rechecking ? <p role="status">正在核对课堂读取权限…</p> : <PageTitle title={room.topic} meta={states[room.status] + ' · ' + room.minutes + ' 分钟 · 第 ' + room.rev + ' 版'} />}
    {!rechecking && <a className="tonal-button" href={'/classroom/' + encodeURIComponent(room.id) + '/print'}>打开打印版</a>}
    <ClassroomLesson key={room.sessionId + ':' + room.rev} room={room} visible={!rechecking} />
    {!rechecking && <>
    {room.generation === 'pending' && <p role="status">正在编排课堂…</p>}
    {room.status === 'active' && room.adjustmentFailed && <p role="status">这次调整没有完成。可以继续原步骤，或重新调整后续步骤。</p>}
    <fieldset className="classroom-controls" disabled={busy || !!pending || room.generation === 'pending'}>
      {room.status === 'active' && <>
        {room.activeStepId && <>
          <label className="field">希望后面怎么调整？<textarea rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>
          <div className="study-actions"><button disabled={!room.steps.some(step => step.status === 'pending')} onClick={() => submit('adjust')}>调整后续步骤</button>
            <button className="primary-button" onClick={() => submit('advance')}>下一步</button>
            <button onClick={() => submit('skip')}>跳过这一步</button></div>
        </>}
        <button className="text-button" onClick={() => submit('finish')}>结束这节课</button>
      </>}
      {room.status === 'finished' && <button className="primary-button" onClick={() => submit('archive')}>归档课堂</button>}
    </fieldset>
    {room.status === 'archived' && <a className="tonal-button" href={'/classroom?from=' + encodeURIComponent(id)}>按这个主题另开一课</a>}
    {writeError && <p role="alert">{writeError}</p>}
    {busy && <p role="status">正在等待课堂回执…</p>}
    {pending && !busy && <button onClick={() => submit('adjust', true)}>重发原请求</button>}
    </>}
  </>;
}
