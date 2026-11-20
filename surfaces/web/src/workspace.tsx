import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ErasureProgress, readErasure, pendingErasures } from './erasure';
import { latestKey } from './deletion-watermark';
import { enqueue } from './offline-queue';
import { api, deletedSubmission, remember, remembered, requestId, submissionId, type Settings } from './api';
import { RetentionPosttests } from './retention-posttests';
import { Icon } from './icons';
import { LearningUnderstandings } from './learning-understandings';
import { LearningMemory } from './study-tools';
import { MaterialOriginal } from './intake';

export type Material = { id: string; title: string; text: string };
export type Workspace = { materials: Material[]; goal: string | null };
export type ChatLink = { id: string; title: string; caseId: string };
export type Resource<T> = { data: T | undefined; error: boolean; reload: () => void };

export function useResource<T>(path: string): Resource<T> & {replace: (value: T) => void} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    api<T>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [path, version]);
  useEffect(() => {
    if (path !== '/workspace') return;
    const refresh = () => {setData(undefined);setVersion(n => n + 1);};
    const stored = (e:StorageEvent) => {if (e.key === latestKey) refresh();};
    window.addEventListener(latestKey,refresh);
    window.addEventListener('storage',stored);
    return () => {window.removeEventListener(latestKey,refresh);window.removeEventListener('storage',stored);};
  },[path]);
  return { data, error, reload: () => setVersion((n) => n + 1),
    replace(value) { setData(value); setError(false); setVersion(n => n + 1); } };
}

export function ReadState({ resource }: { resource: Resource<unknown> }) {
  if (resource.error)
    return (
      <p role="alert">
        暂时无法读取。{' '}
        <button className="text-button" onClick={resource.reload}>
          重试
        </button>
      </p>
    );
  return !resource.data ? (
    <p role="status" className="muted">
      正在读取…
    </p>
  ) : null;
}

export function PageTitle({ title, children, meta }: { title: string; children?: ReactNode; meta?: string }) {
  return (
    <header className="section-heading">
      <div>
        {meta && <p className="heading-meta">{meta}</p>}
        <h1>{title}</h1>
      </div>
      {children}
    </header>
  );
}

export function ListLink({
  href,
  title,
  detail,
  icon,
}: {
  href: string;
  title: string;
  detail: string;
  icon: 'book' | 'practice' | 'chat' | 'document' | 'history' | 'today';
}) {
  return (
    <a className="list-link" href={href}>
      <span className={'list-symbol symbol-' + icon}>
        <Icon name={icon} />
      </span>
      <span className="list-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <Icon name="chevron" />
    </a>
  );
}

export const materialPath = (id: string) => '/materials/saved/' + encodeURIComponent(id);
export const chatPath = (id: string) => '/companion?session=' + encodeURIComponent(id);

function Recent({ chats }: { chats: Resource<ChatLink[]> }) {
  const last = chats.data?.[0];
  if (last) return <ListLink href={chatPath(last.id)} title={last.title} detail="继续上次对话" icon="chat" />;
  return (
    <>
      <ReadState resource={chats} />
      {chats.data && (
        <ListLink href="/companion" title="问学习同伴" detail="从你卡住的那一步开始" icon="chat" />
      )}
    </>
  );
}

type PaperSummary = { id: string; title: string };
type OrganizerIndex = { tasks: { id: string; title: string; date: string; done: boolean }[]; notes: { id: string; title: string }[] };

export function Today({ library, chats }: { library: Resource<Workspace>; chats: Resource<ChatLink[]> }) {
  const organizer = useResource<OrganizerIndex>('/organizer/index');
  const papers = useResource<PaperSummary[]>('/papers');
  const next = organizer.data?.tasks.filter(t => !t.done).sort((a,b) => a.date.localeCompare(b.date))[0];
  const latest = library.data?.materials[0];
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(
    new Date(),
  );
  const selected = new URLSearchParams(location.search).get('posttest');
  if (selected !== null) return <>
    <PageTitle title="今天" meta={date} />
    <RetentionPosttests selected={selected} />
  </>;
  return (
    <>
      <PageTitle title="今天" meta={date} />
      <section className="study-today-hero">
        <div>
          <span className="cover-kind"><Icon name={next ? 'today' : 'book'} />{next ? '下一项安排 · ' + next.date : latest ? '最近交入的材料' : '个人学习台'}</span>
          <h2>{next?.title || latest?.title || '今天想学些什么？'}</h2>
          <p>{next ? '打开计划，查看接下来的安排或记录已完成。' : latest ? '打开原文，写笔记，或选一段交给同伴备课。' : '带上你的讲义、卷子或课堂笔记，从手头正在学的内容开始。'}</p>
          <div className="study-actions"><a className="primary-button" href={next ? '/plan?id='+next.id : latest ? materialPath(latest.id) : '/intake'}>{next ? '打开学习计划' : latest ? '继续读材料' : '导入学习材料'} <Icon name="arrow" /></a>
          <a className="tonal-button" href={next ? '/intake' : '/plan'}>{next ? '导入材料' : '学习计划'}</a></div>
        </div>
        <time className="study-calendar" aria-label={date}>
          <span>{new Intl.DateTimeFormat('zh-CN',{month:'long'}).format(new Date())}</span>
          <strong>{new Date().getDate()}</strong>
          <small>{new Intl.DateTimeFormat('zh-CN',{weekday:'long'}).format(new Date())}</small>
        </time>
      </section>
      <div className="today-lower">
        <section className="surface-section">
          <div className="subhead"><h2>我的练习</h2><a href="/papers">全部练习</a></div>
          <RetentionPosttests />
          <ReadState resource={papers} />
          {papers.data?.slice(0, 2).map(p => <ListLink key={p.id} href={'/papers/'+p.id} title={p.title} detail="继续作答或查看反馈" icon="practice" />)}
          <ListLink href="/review" title="错题回看" detail="从上次答错的题回到原卷" icon="history" />
          <ListLink href="/papers/new" title="编一份练习" detail="用自己的题目和答案组卷" icon="practice" />
        </section>
        <section className="surface-section">
          <div className="subhead"><h2>学习笔记</h2><a href="/notes">全部笔记</a></div>
          <ReadState resource={organizer} />
          {organizer.data?.notes.slice(0,2).map(n => <ListLink key={n.id} href={'/notes?id='+n.id} title={n.title} detail="打开笔记及修订记录" icon="document" />)}
          <ListLink href="/notes" title="整理学习笔记" detail="记录思路、原文和自己的解法" icon="book" />
        </section>
        <section className="surface-section">
          <div className="subhead"><h2>学习同伴</h2><a href="/companion">全部对话</a></div>
          <Recent chats={chats} />
        </section>
        <section className="surface-section">
          <div className="subhead"><h2>起步材料</h2><a href="/materials">材料库</a></div>
          <ListLink href="/materials/riding" title="同一趟骑行，两块码表" detail="内置讲义 · 调节停车时间" icon="book" />
        </section>
      </div>
      {library.data?.goal && (
        <section className="goal-strip">
          <Icon name="person" />
          <div>
            <small>当前目标</small>
            <p>{library.data.goal}</p>
          </div>
          <a href="/me">查看</a>
        </section>
      )}
      {(library.data?.materials.length ?? 0) > 0 && (
        <section className="recent-material">
          <div className="subhead">
            <h2>最近交入</h2>
            <a href="/materials">全部材料</a>
          </div>
          {library.data?.materials.slice(0, 3).map((x) => (
            <ListLink
              key={x.id}
              href={materialPath(x.id)}
              title={x.title}
              detail="个人材料"
              icon="document"
            />
          ))}
        </section>
      )}
    </>
  );
}

export function Materials({ library, capture }: { library: Resource<Workspace>; capture: () => void }) {
  const papers = useResource<PaperSummary[]>('/papers');
  const organizer = useResource<OrganizerIndex>('/organizer/index');
  const [filter, setFilter] = useState('全部');
  const [search, setSearch] = useState('');
  const items = [
    {
      title: '同一趟骑行，两块码表',
      detail: '起步讲义 · 速度与时间',
      kind: '教材',
      href: '/materials/riding',
      icon: 'book' as const,
    },
    {
      title: '骑行与平均速度',
      detail: '独立短练 · 可重复作答',
      kind: '题库',
      href: '/practice/riding',
      icon: 'practice' as const,
    },
    {
      title: '同一个 45，两份学习史',
      detail: '示例课堂 · 两份合成旧作',
      kind: '示例课堂',
      href: '/classroom/first45',
      icon: 'chat' as const,
    },
    ...(papers.data ?? []).map(p => ({ title:p.title, detail:'自编或从材料备课的练习', kind:'题库', href:'/papers/'+p.id, icon:'practice' as const })),
    ...(organizer.data?.notes ?? []).map(n => ({title:n.title, detail:'个人笔记 · 可编辑', kind:'笔记', href:'/notes?id='+n.id, icon:'book' as const})),
    ...(library.data?.materials ?? []).map((m) => ({
      title: m.title,
      detail: '个人材料 · 仅保存',
      kind: '个人材料',
      href: materialPath(m.id),
      icon: 'document' as const,
      text: m.text,
    })),
  ];
  const visible = items.filter(
    (x) =>
      (filter === '全部' || x.kind === filter) &&
      (x.title + x.detail + ('text' in x ? x.text : '')).toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <>
      <PageTitle title="材料"><a className="tonal-button" href="/intake"><Icon name="plus" /> 导入文件</a></PageTitle>
      <div className="study-actions library-actions"><a href="/textbooks">个人教材</a><a href="/papers">我的题库</a><a href="/notes">学习笔记</a><a href="/materials/workspace">同伴工作区</a><button className="text-button" onClick={capture}>交入文字</button></div>
      {pendingErasures().map(id => <a key={id} href={materialPath(id)}>查看待核对的原件删除请求 · {id.slice(-6)}</a>)}
      <div className="library-controls">
        <label className="search-box">
          <Icon name="search" />
          <input
            aria-label="搜索材料"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索题目、教材和个人材料"
          />
        </label>
        <div className="filter-row" aria-label="材料分类">
          {['全部', '教材', '题库', '笔记', '个人材料', '示例课堂'].map((k) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <ReadState resource={papers} /><ReadState resource={organizer} />
      <div className="library-list">
        {visible.map((x) => (
          <ListLink key={x.href} {...x} />
        ))}
        <ReadState resource={library} />
        {!visible.length && library.data && papers.data && organizer.data && (
          <div className="empty">
            <h2>{search ? '没有匹配的材料' : '还没有个人材料'}</h2>
            {!search && (
              <button className="tonal-button" onClick={capture}>
                交入第一份材料
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export function SavedMaterial({ library, id }: { library: Resource<Workspace>; id: string }) {
  const [erasure,setErasure] = useState(() => readErasure(id));
  const [start,setStart] = useState(false);
  useEffect(() => {
    const restore = () => setErasure(readErasure(id));
    window.addEventListener('storage',restore);
    return () => window.removeEventListener('storage',restore);
  },[id]);
  if (erasure) return <ErasureProgress id={id} initial={erasure} start={start} onReset={() => {setStart(false);setErasure(null);library.reload();}}/>;
  const m = library.data?.materials.find((x) => x.id === id);
  return (
    <>
      <a className="back-link" href="/materials">
        ‹ 返回材料
      </a>
      <ReadState resource={library} />
      {m ? (
        <article className="reading-paper">
          <PageTitle title={m.title} meta="个人材料 · 仅保存" />
          <div className="study-actions material-actions">
            <a className="primary-button" href={'/companion?mode=prepare&material='+m.id}>让同伴备课</a>
            <a className="tonal-button" href={'/companion?material='+m.id}>带原文提问</a>
            <a href={'/notes?material='+m.id}>写笔记</a>
            <a href={'/papers/new?material='+m.id}>自己编卷</a>
          </div>
          <p className="preserve">{m.text}</p><MaterialOriginal id={m.id} previewText={m.text} changed={library.reload} erase={() => {setStart(true);setErasure(readErasure(id));}} />
        </article>
      ) : (
        library.data && <h1>未找到这份材料</h1>
      )}
    </>
  );
}

export function Me({
  library,
  chats,
  editGoal,
  settings,
}: {
  library: Resource<Workspace>;
  chats: Resource<ChatLink[]>;
  editGoal: () => void;
  settings: Settings | undefined;
}) {
  return (
    <>
      <PageTitle title="我" />
      <ReadState resource={library} />
      {library.data && (
        <section className="goal-panel">
          <div className="subhead">
            <h2>当前学习目标</h2>
            <button className="text-button" onClick={editGoal}>
              {library.data.goal ? '修改目标' : '写下目标'}
            </button>
          </div>
          <p>{library.data.goal || '你最近希望弄懂什么？'}</p>
        </section>
      )}
      <LearningUnderstandings />
      <LearningMemory settings={settings} />
      <section className="surface-section profile-records">
        <div className="subhead">
          <h2>我的学习记录</h2>
        </div>
        <ListLink
          href="/papers"
          title="我的练习与反馈"
          detail="回看每次提交的答案"
          icon="practice"
        />
        <ListLink href="/review" title="错题回看" detail="回看最近一次未答对的题" icon="history" />
        <ListLink href="/plan" title="学习计划" detail="安排与完成记录" icon="today" />
        <ListLink href="/notes" title="学习笔记" detail="回看原文和笔记修订" icon="book" />
        <ListLink href="/materials" title="个人材料" detail="回到已保存的原文" icon="document" />
        <Recent chats={chats} />
      </section>
      <section className="privacy-note">
        <Icon name="lock" />
        <div>
          <h2>资料用途</h2>
          <p>你可以在材料的用途设置中查看授权。同伴对你的理解来自已获准的学习活动。</p>
        </div>
      </section>
    </>
  );
}

export function EditDialog({
  kind,
  currentGoal,
  close,
  saved,
}: {
  kind: 'material' | 'goal';
  currentGoal: string;
  close: () => void;
  saved: (id?: string) => void;
}) {
  const isMaterial = kind === 'material';
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(() => (isMaterial ? (remembered('capture-title') ?? '') : ''));
  const [text, setText] = useState(() => (isMaterial ? (remembered('capture-text') ?? '') : currentGoal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const intentKey = 'pending-save:' + kind;
  const pendingIntent = useRef<string | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const payload = isMaterial ? { title, text } : { text };
    const data = JSON.stringify(payload);
    let id: string | undefined;
    try {
      const saved = JSON.parse(pendingIntent.current ?? remembered(intentKey) ?? 'null');
      if (saved?.data === data && typeof saved.id === 'string') id = saved.id;
    } catch {
      /* Recover a partially written browser draft. */
    }
    id ??= isMaterial ? submissionId() : requestId();
    const intent = JSON.stringify({ data, id });
    pendingIntent.current = intent;
    remember(intentKey, intent);
    setBusy(true);
    setError('');
    try {
      if (isMaterial && !navigator.onLine) {
        await enqueue({kind:'material',id,title,text});
        remember(intentKey,null);
        remember('capture-title',null);
        remember('capture-text',null);
        close();
        return;
      }
      const result = await api<{ id?: string }>(isMaterial ? '/materials' : '/goal', {
        method: 'POST',
        body: { ...payload, requestId: id },
      });
      if (remembered(intentKey) === intent) remember(intentKey, null);
      if (isMaterial && remembered('capture-title') === title && remembered('capture-text') === text) {
        remember('capture-title', null);
        remember('capture-text', null);
      }
      saved(isMaterial ? result.id : undefined);
    } catch (failure) {
      if (isMaterial && deletedSubmission(failure)) {
        pendingIntent.current = null;
        remember(intentKey,null);
        remember('capture-title',null);
        remember('capture-text',null);
        setTitle('');setText('');
        setError('删除状态已变化，旧提交已清除。需要时请重新交入。');
      } else setError('保存失败，文字还在。请再试一次。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="settings-dialog entry-dialog"
      aria-labelledby="edit-title"
      onClose={close}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
    >
      <div className="dialog-heading">
        <h2 id="edit-title">{isMaterial ? '交入文字材料' : '当前学习目标'}</h2>
        <button className="icon-button" type="button" aria-label="关闭" disabled={busy} onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)}>
        {isMaterial && (
          <label className="field">
            <span>标题</span>
            <input
              autoFocus
              disabled={busy}
              required
              maxLength={240}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                remember('capture-title', e.target.value);
              }}
            />
          </label>
        )}
        <label className="field">
          <span>{isMaterial ? '原文或自己的问题' : '我希望弄懂'}</span>
          <textarea
            autoFocus={!isMaterial}
            disabled={busy}
            required={isMaterial}
            maxLength={4000}
            rows={5}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (isMaterial) remember('capture-text', e.target.value);
            }}
          />
        </label>
        {isMaterial && <p className="field-help">仅保存到我的材料。也可以<a href="/intake">导入文件或照片</a>。</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} className="text-button" onClick={close}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={busy || (isMaterial && (!title.trim() || !text.trim()))}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
