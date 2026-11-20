import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, sessionPath, type Session } from './api';
import { roomApi, roomPath, type Classroom } from './classroom-contract';
import { Message } from './message';
import { readSession, type MountedSession } from './presentation/session-artifacts';
import { TurnArtifacts } from './presentation/TurnArtifact';

type Sheet = { room: Classroom; history: MountedSession };
function sheet(id: string, room: Classroom, session: Session): Sheet {
  if (room.id !== id || !room.sessionId || room.sessionId !== session.id) throw new Error();
  return {room, history: readSession(session)};
}

// Browser-initiated printing cannot await a Promise in beforeprint. Make the
// final reads there, and render no course data if either authority is unavailable.
function current<T>(path: string): T {
  const request = new XMLHttpRequest();
  request.open('GET', '/api' + path, false);
  request.setRequestHeader('Cache-Control', 'no-cache');
  request.send();
  if (request.status !== 200) throw new Error();
  return JSON.parse(request.responseText) as T;
}

const stepStatus = {pending: '待学', active: '当前步骤', presented: '已呈现', skipped: '已跳过'};
function Paper({value}: {value: Sheet}) {
  const {room, history} = value;
  return <article className="print-paper classroom-paper">
    <h1>{room.topic}</h1>
    <p>{room.minutes} 分钟 · {room.status === 'archived' ? '已归档' : room.status === 'finished' ? '已结课' : '上课中'} · 第 {room.rev} 版</p>
    <ol>{room.steps.map(step => {
      const turn = step.status !== 'pending' && step.turnId ? history.turns.find(t => t.turnId === step.turnId) : undefined;
      const mounts = step.status !== 'pending' && step.turnId ? history.mounts.filter(m => m.turnId === step.turnId) : [];
      return <li key={step.id}>
        <h2>{step.title}</h2><p>{stepStatus[step.status]}</p>
        {turn?.message && <Message text={turn.message} />}
        <TurnArtifacts mounts={mounts} live={false} />
      </li>;
    })}</ol>
  </article>;
}

export function ClassroomPrint({id, preview}: {id: string; preview: boolean}) {
  const [screen, setScreen] = useState<Sheet>();
  const [paper, setPaper] = useState<Sheet>();
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const sessionId = useRef<string | undefined>(undefined);
  const generation = useRef(0);

  useEffect(() => {
    if (!preview) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      clearTimeout(timer);
      const seq = ++generation.current;
      if (document.hidden) {setScreen(undefined);return;}
      try {
        const options = {signal: controller.signal};
        const first = await api<Classroom>(roomApi(id), options);
        const history = await api<Session>(sessionPath(first.sessionId), options);
        const latest = await api<Classroom>(roomApi(id), options);
        if (controller.signal.aborted || seq !== generation.current) return;
        const next = sheet(id, latest, history);
        sessionId.current = next.room.sessionId;
        setScreen(next);
        setError(false);
      } catch {
        if (controller.signal.aborted || seq !== generation.current) return;
        setScreen(undefined);
        setError(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
    }
    function reopen() {
      setScreen(undefined);
      void refresh();
    }
    void refresh();
    window.addEventListener('pageshow', reopen);
    document.addEventListener('visibilitychange', reopen);
    return () => {controller.abort(); clearTimeout(timer); window.removeEventListener('pageshow', reopen); document.removeEventListener('visibilitychange', reopen);};
  }, [id, preview, version]);

  useLayoutEffect(() => {
    function prepare() {
      ++generation.current;
      let next: Sheet | undefined;
      try {
        const session = sessionId.current ?? current<Classroom>(roomApi(id)).sessionId;
        const history = current<Session>(sessionPath(session));
        next = sheet(id, current<Classroom>(roomApi(id)), history);
        sessionId.current = session;
      } catch { /* The printable layer starts empty and never falls back to preview data. */ }
      flushSync(() => {setPaper(next); setScreen(next); setError(!next);});
    }
    function finish() {
      setPaper(undefined);
      setVersion(n => n + 1);
    }
    window.addEventListener('beforeprint', prepare);
    window.addEventListener('afterprint', finish);
    return () => {window.removeEventListener('beforeprint', prepare); window.removeEventListener('afterprint', finish);};
  }, [id]);

  return <>
    {preview && <section className="classroom-screen">
      <div className="study-actions print-controls"><a href={roomPath(id)}>返回原课堂</a>
        <button className="primary-button" disabled={!screen} onClick={() => window.print()}>打印或存为 PDF</button></div>
      {screen ? <Paper value={screen} /> : <p role="status">{error ? '当前无法读取可打印的课堂。' : '正在核对可打印的课堂…'}</p>}
    </section>}
    <div className="classroom-print-output">{paper ? <Paper value={paper} /> : <p>当前无法读取可打印的课堂。</p>}</div>
  </>;
}
