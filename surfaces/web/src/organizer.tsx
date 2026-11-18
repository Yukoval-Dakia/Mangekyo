import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, requestId } from './api';
import { Icon } from './icons';
import { Message } from './message';
import { PageTitle, ReadState, useResource, type Resource } from './workspace';
import './organizer.css';

export type OrganizerMaterial = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
};

export type OrganizerTask = {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly done: boolean;
  readonly rev: number;
};

export type OrganizerNoteSource = {
  readonly id: string;
  readonly title: string;
};

export type OrganizerNoteVersion = {
  readonly rev: number;
  readonly title: string;
  readonly markdown: string;
  readonly source: OrganizerNoteSource | null;
};

export type OrganizerNote = OrganizerNoteVersion & {
  readonly id: string;
  readonly versions: readonly OrganizerNoteVersion[];
};

type OrganizerSnapshot = {
  readonly tasks: readonly OrganizerTask[];
  readonly notes: readonly OrganizerNote[];
};

type SaveResult = {
  readonly id: string;
  readonly rev: number;
};

function problemText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return '内容不符合要求，请检查后重试。';
    if (error.status === 403) return '链接的材料当前无法使用。';
    if (error.status === 404) return '这条记录不存在，请刷新后重试。';
    if (error.status === 409) return '这条记录已在别处更新，或同一请求已用于不同内容。请刷新后重试。';
  }
  return '操作暂时无法完成，请重试。';
}

function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function dateLabel(date: string) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(parsed);
}

function noticeElement(message: string) {
  if (!message) return null;
  return (
    <p className="organizer-notice" role="status">
      {message}
    </p>
  );
}

function failureElement(message: string) {
  if (!message) return null;
  return (
    <p className="organizer-notice problem" role="alert">
      {message}
    </p>
  );
}

function Plan({ resource }: { resource: Resource<OrganizerSnapshot> }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef<{ payload: string; request: string } | null>(null);
  const tasks = resource.data?.tasks ?? [];

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    const payload = { title, date };
    const data = JSON.stringify(payload);
    const saved = pending.current;
    let operation = saved?.payload === data && saved !== null ? saved.request : requestId();
    if (saved?.payload !== data) pending.current = { payload: data, request: operation };
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await api<SaveResult>('/organizer/tasks', {
        method: 'POST',
        body: { ...payload, requestId: operation },
      });
      setTitle('');
      pending.current = null;
      setMessage('已加入计划。');
      resource.reload();
    } catch (requestError) {
      setError(problemText(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(task: OrganizerTask) {
    if (busy) return;
    const payload = { id: task.id, rev: task.rev, done: !task.done };
    const data = JSON.stringify(payload);
    const saved = pending.current;
    let operation = saved?.payload === data && saved !== null ? saved.request : requestId();
    if (saved?.payload !== data) pending.current = { payload: data, request: operation };
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await api<SaveResult>('/organizer/tasks', {
        method: 'POST',
        body: { ...payload, requestId: operation },
      });
      pending.current = null;
      setMessage(task.done ? `${task.title}已重新打开。` : `${task.title}已完成。`);
      resource.reload();
    } catch (requestError) {
      setError(problemText(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle title="计划" meta="写下当天和接下来要推进的学习">
        <button className="text-button" disabled={busy} onClick={resource.reload}>
          <Icon name="today" /> 刷新
        </button>
      </PageTitle>
      <ReadState resource={resource} />
      {failureElement(error)}
      {noticeElement(message)}
      {resource.data && (
        <section className="organizer-card">
          <form className="organizer-form" onSubmit={(event) => void add(event)}>
            <label className="field">
              <span>要做什么</span>
              <input
                autoFocus
                disabled={busy}
                maxLength={240}
                placeholder="例如：重做骑行平均速度题"
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="field">
              <span>日期</span>
              <input
                disabled={busy}
                max="2200-12-31"
                required
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy || !title.trim()}>
              {busy ? '保存中…' : '加入计划'}
            </button>
          </form>
        </section>
      )}
      {resource.data && (
        <section className="organizer-card">
          {tasks.length ? (
            <ul className="organizer-tasks">
              {tasks.map((task) => (
                <li key={task.id} className={task.done ? 'is-done' : undefined}>
                  <button
                    aria-label={task.done ? `重新打开${task.title}` : `标记${task.title}已完成`}
                    aria-pressed={task.done}
                    className="organizer-task-toggle"
                    disabled={busy}
                    onClick={() => void toggle(task)}
                    type="button"
                  >
                    {task.done ? '✓' : ''}
                  </button>
                  <div className="organizer-task-copy">
                    <strong>{task.title}</strong>
                    <small>{dateLabel(task.date)}</small>
                  </div>
                  <button
                    className="text-button organizer-task-action"
                    disabled={busy}
                    onClick={() => void toggle(task)}
                    type="button"
                  >
                    {task.done ? '重新打开' : '完成'}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="organizer-empty">
              <h2>还没有计划</h2>
              <p>写下一件接下来要学的事，完成状态可以随时改回。</p>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function NoteEditor({
  note,
  materials,
  initialMaterialId,
  onReload,
  onCreated,
}: {
  note: OrganizerNote | null;
  materials: readonly OrganizerMaterial[];
  initialMaterialId: string | null;
  onReload: () => void;
  onCreated: (id: string) => void;
}) {
  const draftKey = 'mangekyo:note-draft:' + (note?.id ?? initialMaterialId ?? 'new');
  const [draft] = useState(() => {
    try {
      const raw = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
      if (raw && typeof raw.title === 'string' && typeof raw.markdown === 'string' &&
          typeof raw.sourceId === 'string' && Number.isInteger(raw.base)) return raw as {title:string; markdown:string; sourceId:string; base:number};
    } catch { /* Storage can be disabled. */ }
    return null;
  });
  const [title, setTitle] = useState(draft?.title ?? note?.title ?? '');
  const [markdown, setMarkdown] = useState(draft?.markdown ?? note?.markdown ?? '');
  const [sourceId, setSourceId] = useState(draft?.sourceId ?? note?.source?.id ?? initialMaterialId ?? '');
  const [expectedRev, setExpectedRev] = useState(draft?.base ?? note?.rev ?? 0);
  function clearDraft() {
    try { sessionStorage.removeItem(draftKey); } catch { /* Storage can be disabled. */ }
  }
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({title, markdown, sourceId, base:expectedRev})); }
    catch { /* The live editor remains usable. */ }
  }, [title, markdown, sourceId, expectedRev, draftKey]);
  const [busyAction, setBusyAction] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef<{ payload: string; request: string } | null>(null);
  const sourceTouched = useRef(Boolean(draft));
  const busyFor = busyAction;


  useEffect(() => {
    if (!note && initialMaterialId && !sourceTouched.current) setSourceId(initialMaterialId);
  }, [initialMaterialId, note]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !markdown.trim() || busyFor) return;
    const payload = note
      ? { id: note.id, expectedRev, title, markdown, materialId: sourceId || null }
      : { title, markdown, materialId: sourceId || null };
    const data = JSON.stringify(payload);
    const saved = pending.current;
    let operation = saved?.payload === data && saved !== null ? saved.request : requestId();
    if (saved?.payload !== data) pending.current = { payload: data, request: operation };
    setBusyAction(true);
    setMessage('');
    setError('');
    try {
      const savedNote = await api<SaveResult>('/organizer/notes', {
        method: 'POST',
        body: { ...payload, requestId: operation },
      });
      pending.current = null;
      clearDraft();
      if (note) {
        setExpectedRev(savedNote.rev);
        setMessage(`已保存，当前是第 ${savedNote.rev} 版。`);
        onReload();
      } else {
        setMessage(`已创建，当前是第 ${savedNote.rev} 版。`);
        onCreated(savedNote.id);
      }
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 409) onReload();
      setError(problemText(requestError));
    } finally {
      setBusyAction(false);
    }
  }

  async function restore(version: OrganizerNoteVersion) {
    if (!note || busyFor) return;
    setBusyAction(true);
    setMessage('');
    setError('');
    try {
      const restored = await api<SaveResult>('/organizer/notes', {
        method: 'POST',
        body: {
          requestId: requestId(),
          id: note.id,
          expectedRev,
          restoreRev: version.rev,
        },
      });
      setExpectedRev(restored.rev);
      setTitle(version.title);
      setMarkdown(version.markdown);
      setSourceId(version.source?.id ?? '');
      setMessage(`已恢复第 ${version.rev} 版，并保存为第 ${restored.rev} 版。`);
      onReload();
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 409) onReload();
      setError(problemText(requestError));
    } finally {
      setBusyAction(false);
    }
  }

  return (
    <section className="organizer-card organizer-editor">
      <div className="organizer-editor-heading">
        <div>
          <h2>{note ? '编辑笔记' : '新建笔记'}</h2>
          {note ? (
            <p>第 {note.rev} 版 · 每次保存都会保留历史</p>
          ) : (
            <p>使用 Markdown 写下理解、疑问和摘录。</p>
          )}
        </div>
        {note && (
          <a className="text-button" href={`/notes?id=${encodeURIComponent(note.id)}`}>
            <Icon name="history" /> 版本历史
          </a>
        )}
      </div>
      {note && note.rev !== expectedRev && <aside className="organizer-notice">
        <p>原笔记已更新。你的草稿仍在下面，请在版本历史里核对新内容。</p>
        <button className="text-button" onClick={() => setExpectedRev(note.rev)}>已核对，以第 {note.rev} 版为基础继续修改</button>
      </aside>}
      <form className="organizer-editor-form"  onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>标题</span>
          <input
            disabled={busyFor}
            maxLength={240}
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="field">
          <span>关联材料</span>
          <select
            disabled={busyFor}
            value={sourceId}
            onChange={(event) => {
              sourceTouched.current = true;
              setSourceId(event.target.value);
            }}
          >
            <option value="">不链接</option>
            {materials.map((material) => (
              <option key={material.id} value={material.id}>
                {material.title}
              </option>
            ))}
          </select>
        </label>
        {failureElement(error)}
        {noticeElement(message)}
        <div className="organizer-editor-grid">
          <label className="field">
            <span>Markdown</span>
            <textarea
              disabled={busyFor}
              maxLength={8000}
              required
              rows={16}
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          </label>
          <div className="organizer-preview">
            <span>预览</span>
            {markdown.trim() ? <Message text={markdown} /> : <p className="muted">开始写后这里会显示排版效果。</p>}
          </div>
        </div>
        {note && (
          <details className="organizer-versions">
            <summary>
              <Icon name="history" />
              <span>版本历史 · {note.versions.length} 版</span>
              <Icon name="chevron" />
            </summary>
            <ol className="organizer-version-list">
              {[...note.versions].reverse().map((version) => (
                <li key={version.rev} className={version.rev === note.rev ? 'is-current' : undefined}>
                  <span>第 {version.rev} 版</span>
                  <small>{version.title || '未命名笔记'}</small>
                  {version.source && (
                    <a className="organizer-source-link" href={`/materials/saved/${encodeURIComponent(version.source.id)}`}>
                      查看材料
                    </a>
                  )}
                  {version.rev < note.rev && (
                    <button
                      className="text-button"
                      disabled={busyFor}
                      onClick={() => void restore(version)}
                      type="button"
                    >
                      恢复此版本
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}
        <div className="organizer-editor-actions">
          <button className="primary-button" disabled={busyFor || !title.trim() || !markdown.trim()}>
            {busyFor ? '保存中…' : note ? '保存新版本' : '创建笔记'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function Organizer({
  section,
  materials,
}: {
  section: 'plan' | 'notes';
  materials: readonly OrganizerMaterial[];
}) {
  const resource = useResource<OrganizerSnapshot>('/organizer');
  const query = useState(() => new URLSearchParams(location.search))[0];
  const [selectedId, setSelectedId] = useState(query.get('id'));
  const [newDraft, setNewDraft] = useState(0);
  const [materialParam, setMaterialParam] = useState(query.get('material'));
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const selectedNote = resource.data?.notes.find((note) => note.id === selectedId) ?? null;
  const unknownMaterial =
    materials.length > 0 &&
    Boolean(materialParam) &&
    !materials.some((material) => material.id === materialParam);

  useEffect(() => {
    const url = new URL(location.href);
    if (selectedId) url.searchParams.set('id', selectedId);
    else url.searchParams.delete('id');
    if (url.searchParams.toString() !== location.search)
      history.replaceState(history.state, '', url);
  }, [selectedId]);

  useEffect(() => {
    if (waitingFor && resource.data?.notes.some((note) => note.id === waitingFor)) setWaitingFor(null);
  }, [waitingFor, resource.data]);

  if (section === 'plan') return <Plan resource={resource} />;

  const notes = resource.data?.notes ?? [];
  const initialMaterial = materials.some((material) => material.id === materialParam)
    ? materialParam
    : null;

  function select(note: string | null) {
    setSelectedId(note);
    if (note === null) setNewDraft((value) => value + 1);
  }

  function openWithMaterial(material: OrganizerMaterial) {
    setSelectedId(null);
    setMaterialParam(material.id);
    setNewDraft((value) => value + 1);
    const url = new URL('/notes', location.origin);
    url.searchParams.set('material', material.id);
    history.replaceState(history.state, '', url);
  }

  function created(note: string) {
    setSelectedId(note);
    setWaitingFor(note);
    setStatus('已创建笔记。');
    resource.reload();
  }

  return (
    <>
      <PageTitle title="笔记" meta="保存 Markdown，保留每一版">
        <button className="text-button" disabled={!resource.data} onClick={resource.reload}>
          <Icon name="today" /> 刷新
        </button>
      </PageTitle>
      <ReadState resource={resource} />
      {noticeElement(status)}
      {unknownMaterial && <p className="organizer-notice problem" role="alert">找不到要链接的材料。</p>}
      <div className="organizer-notes-layout">
        <section className="organizer-card organizer-note-list">
          <div className="organizer-list-heading">
            <h2>全部笔记</h2>
            <button
              className="tonal-button"
              onClick={() => select(null)}
              type="button"
            >
              <Icon name="plus" /> 新建
            </button>
          </div>
          {notes.length ? (
            <ul>
              {notes.map((note) => (
                <li key={note.id}>
                  <a
                    aria-current={selectedId === note.id ? 'true' : undefined}
                    href={`/notes?id=${encodeURIComponent(note.id)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      select(note.id);
                    }}
                  >
                    <strong>{note.title || '未命名笔记'}</strong>
                    <small>
                      第 {note.rev} 版
                      {note.source ? ` · ${note.source.title}` : ''}
                    </small>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="organizer-empty-text">还没有笔记。写下第一段理解。</p>
          )}
          {materials.length > 0 && (
            <div className="organizer-material-links">
              <span>从材料开始</span>
              {materials.map((material) => (
                <button
                  key={material.id}
                  className="tonal-button"
                  onClick={() => openWithMaterial(material)}
                  type="button"
                >
                  {material.title}
                </button>
              ))}
            </div>
          )}
        </section>
        {resource.error || !resource.data ? (
          <section className="organizer-card">
            <ReadState resource={resource} />
          </section>
        ) : selectedId && !selectedNote && waitingFor !== selectedId ? (
          <section className="organizer-card">
            <div className="organizer-empty">
              <h2>未找到这份笔记</h2>
              <p>它可能已被删除，或链接不属于当前学习记录。</p>
            </div>
          </section>
        ) : selectedId && !selectedNote ? (
          <section className="organizer-card">
            <p className="muted" role="status">正在打开新笔记…</p>
          </section>
        ) : (
          <NoteEditor
            key={selectedId ?? `new-${newDraft}`}
            note={selectedNote}
            materials={materials}
            initialMaterialId={initialMaterial}
            onReload={resource.reload}
            onCreated={created}
          />
        )}
      </div>
    </>
  );
}
