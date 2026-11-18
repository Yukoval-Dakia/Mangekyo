import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, remember, remembered, requestId } from './api';
import { Icon } from './icons';

export type Material = { id: string; title: string; text: string };
export type Workspace = { materials: Material[]; goal: string | null };
export type ChatLink = { id: string; title: string; caseId: string };
export type Resource<T> = { data: T | undefined; error: boolean; reload: () => void };

export function useResource<T>(path: string): Resource<T> {
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
  return { data, error, reload: () => setVersion((n) => n + 1) };
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

export function Today({ library, chats }: { library: Resource<Workspace>; chats: Resource<ChatLink[]> }) {
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(
    new Date(),
  );
  return (
    <>
      <PageTitle title="今天" meta={date} />
      <article className="lesson-cover">
        <div className="cover-copy">
          <span className="cover-kind">
            <Icon name="book" /> 起步课堂
          </span>
          <h2>
            一趟骑行，
            <br />
            两个平均速度
          </h2>
          <p>骑了 10 公里，两块码表却显示不同的均速。试着拖长停车时间，看看哪一个数会变。</p>
          <a className="cover-action" href="/materials/riding">
            进入课堂 <Icon name="arrow" />
          </a>
        </div>
        <img
          src="/images/riding.webp"
          alt="骑行路上的车把和码表"
          width="1050"
          height="700"
          fetchPriority="high"
        />
      </article>
      <div className="today-lower">
        <section className="surface-section">
          <div className="subhead">
            <h2>自己练一练</h2>
            <Icon name="practice" />
          </div>
          <ListLink
            href="/practice/riding"
            icon="practice"
            title="骑行与平均速度"
            detail="独立短练 · 交卷后逐题核对"
          />
        </section>
        <section className="surface-section">
          <div className="subhead">
            <h2>学习同伴</h2>
            <a href="/companion">全部对话</a>
          </div>
          <Recent chats={chats} />
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
      <PageTitle title="材料" />
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
          {['全部', '教材', '题库', '个人材料', '示例课堂'].map((k) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="library-list">
        {visible.map((x) => (
          <ListLink key={x.href} {...x} />
        ))}
        <ReadState resource={library} />
        {!visible.length && library.data && (
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
          <p className="preserve">{m.text}</p>
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
}: {
  library: Resource<Workspace>;
  chats: Resource<ChatLink[]>;
  editGoal: () => void;
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
      <section className="surface-section profile-records">
        <div className="subhead">
          <h2>我的学习记录</h2>
        </div>
        <ListLink
          href="/practice/riding"
          title="独立练习与反馈"
          detail="回看每次提交的答案"
          icon="practice"
        />
        <ListLink href="/materials" title="个人材料" detail="回到已保存的原文" icon="document" />
        <Recent chats={chats} />
      </section>
      <section className="privacy-note">
        <Icon name="lock" />
        <div>
          <h2>资料用途</h2>
          <p>交入的文字材料仅供自己回看。主动发到学习同伴的文字会用于这次对话。</p>
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
    let id = requestId();
    try {
      const saved = JSON.parse(pendingIntent.current ?? remembered(intentKey) ?? 'null');
      if (saved?.data === data && typeof saved.id === 'string') id = saved.id;
    } catch {
      /* Recover a partially written browser draft. */
    }
    const intent = JSON.stringify({ data, id });
    pendingIntent.current = intent;
    remember(intentKey, intent);
    setBusy(true);
    setError('');
    try {
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
    } catch {
      setError('保存失败，文字还在。请再试一次。');
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
        {isMaterial && <p className="field-help">仅保存到我的材料。</p>}
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
