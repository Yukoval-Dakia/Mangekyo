import { useEffect, useRef, useState, type FormEvent } from 'react';
import { remembered, remember, sessionPath, type Session, type StudyAttachment } from './api';
import { useConversation } from './conversation';
import { Icon, Mark } from './icons';
import { Message } from './message';
import { TeachingTurn } from './demo';
import { chatPath, materialPath, PageTitle, ReadState, useResource, type ChatLink, type Material, type Resource } from './workspace';

function LinkedChat({ id, chats }: { id: string; chats: Resource<ChatLink[]> }) {
  const record = useResource<Session>(sessionPath(id));
  if (!record.data)
    return (
      <>
        <PageTitle title="同伴" />
        <ReadState resource={record} />
        <a className="text-button" href="/companion">
          开始新对话
        </a>
      </>
    );
  if (!['companion', 'riding'].includes(record.data.caseId))
    return (
      <>
        <PageTitle title="示例课堂" />
        <a href={'/classroom/first45?session=' + encodeURIComponent(id)}>打开这次教研记录</a>
      </>
    );
  return <ChatRoom mode={record.data.caseId} initial={record.data} chats={chats} />;
}

function MaterialChat({id, prepare, chats}: {id: string; prepare: boolean; chats: Resource<ChatLink[]>}) {
  const source = useResource<Material>('/materials/'+encodeURIComponent(id)+'/reading');
  if (!source.data) return <><PageTitle title="读取材料" /><ReadState resource={source} /><a href="/materials">返回材料</a></>;
  return <ChatRoom mode="companion" chats={chats} source={source.data} prepare={prepare} />;
}
export function Companion({ chats }: { chats: Resource<ChatLink[]> }) {
  const [query] = useState(() => new URLSearchParams(location.search));
  const id = query.get('session');
  if (id) return <LinkedChat id={id} chats={chats} />;
  const materialId = query.get('material');
  if (materialId) return <MaterialChat id={materialId} prepare={query.get('mode') === 'prepare'} chats={chats} />;
  return <ChatRoom mode={query.get('context') === 'riding' ? 'riding' : 'companion'} chats={chats} />;
}

function ChatRoom({
  mode,
  initial,
  chats,
  source,
  prepare = false,
}: {
  mode: string;
  initial?: Session;
  chats: Resource<ChatLink[]>;
  source?: Material;
  prepare?: boolean;
}) {
  const chat = useConversation(mode, true, initial, false);
  const { session, sessionId, busy, streamingReply, progressLabel, reconnecting } = chat;
  const draftKey = 'free-chat:' + (sessionId ?? (source ? source.id + ':' + prepare : mode));
  const [opening, setOpening] = useState(() => remembered(draftKey) ?? (prepare ? '请结合这段材料准备一份短讲义和可以自测的练习题。' : new URLSearchParams(location.search).has('review') ? '根据我这些实际错答，我在哪一步可能有困难？请引用其中一题，给我一道能验证你判断的追问。' : ''));
  const [excerpt, setExcerpt] = useState(() => source?.text.slice(0, 3000) ?? '');
  const excerptValid = !source || Boolean(excerpt.trim() && source.text.includes(excerpt) && excerpt.length <= 3000);
  const shared = session?.attachment ?? initial?.attachment;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastId = useRef<string | undefined>(initial?.id);
  const feedEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sessionId && sessionId !== lastId.current) {
      lastId.current = sessionId;
      history.replaceState(null, '', chatPath(sessionId));
      remember('free-chat:' + (source ? source.id + ':' + prepare : mode), null);
      chats.reload();
    }
  }, [sessionId, mode]);
  useEffect(() => {
    if (document.activeElement === textarea.current) feedEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [streamingReply, session?.turns.length]);
  const pending = busy || session?.status === 'pending';
  const unavailable = session?.status === 'failed' || session?.status === 'unknown' || chat.invalidated;
  const value = sessionId ? chat.draft : opening;
  function edit(text: string) {
    if (sessionId) chat.editDraft(text);
    else {
      setOpening(text);
      remember(draftKey, text);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (
      pending ||
      unavailable ||
      !value.trim() ||
      chat.retryOperation ||
      chat.outdatedDraft ||
      chat.refreshingConflict
    )
      return;
    if (sessionId) chat.send();
    else if (excerptValid) {
      const attachment: StudyAttachment | undefined = source
        ? { id: source.id, title: source.title, text: excerpt, mode: prepare ? 'prepare' : 'ask' }
        : undefined;
      chat.start(value.trim(), attachment);
    }
  }
  const historyList = chats.data ?? [];
  return (
    <>
      <PageTitle title="同伴">
        <a className="tonal-button" href="/companion">
          <Icon name="plus" /> 新对话
        </a>
      </PageTitle>
      <div className="chat-layout">
        <section className="personal-chat" aria-label="学习同伴">
          {shared && <a className="context-tag" href={materialPath(shared.id)}><Icon name="book" />{shared.title}</a>}
          {source && !sessionId && <div className="source-focus">
            <h2>{prepare ? '从材料备课' : '带着材料提问'}</h2>
            <a href={materialPath(source.id)}>{source.title}</a>
            <label className="field"><span>随本次对话发送的原文选段</span>
              <textarea rows={4} maxLength={3000} value={excerpt} disabled={busy} onChange={e => setExcerpt(e.target.value)} />
            </label>
            <p className="field-help">{excerptValid ? '点发送后，材料标题和这段文字会交给设置中的模型服务，并保存在这次对话里。你可以只留下需要的一段。需要联网核对时，在消息中另起一行写「公开检索：主题」。' : '请使用原文中连续的一段文字，最多 3000 字。'}</p>
          </div>}
          {mode === 'riding' && (
            <a className="context-tag" href="/materials/riding">
              <Icon name="book" /> 正在讨论《同一趟骑行，两块码表》
            </a>
          )}
          {!source && !session?.turns.length && !pending && !unavailable && (
            <div className="chat-welcome">
              <Mark />
              <h2>{mode === 'riding' ? '讲义里哪一步想再聊聊？' : '你卡在哪一步？'}</h2>
              <p>
                {mode === 'riding'
                  ? '同伴会结合这趟骑行的路程和计时条件回答。'
                  : '写下你的问题，也可以贴出自己的解法。'}
              </p>
            </div>
          )}
          {session?.turns.length ? (
            <ol className="turns chat-thread">
              {session.turns.map((t, i) => (
                <TeachingTurn key={i} turn={t} materialId={shared?.id} discuss={pending || unavailable ? undefined : (question, answer) => {
                  chat.editDraft('题目：' + question + '\n我的回答：' + answer + '\n请根据我的回答指出下一步。');
                  textarea.current?.focus();
                }} />
              ))}
            </ol>
          ) : null}
          {(chat.sendingAnswer || session?.pendingAnswer) && (
            <div className="learner-message">
              <span>你</span>
              <p>{chat.sendingAnswer || session?.pendingAnswer}</p>
            </div>
          )}
          {pending && (
            <div className="live-response">
              <span className="live-status" role="status">
                <i />
                {reconnecting ? '正在重连…' : progressLabel || '正在连接同伴…'}
              </span>
              {streamingReply && <Message text={streamingReply} />}
            </div>
          )}
          <div ref={feedEnd} />
          {unavailable && (
            <p className="notice problem" role="status">
              {session?.error || '这次对话暂时无法继续。'}
            </p>
          )}
          {chat.problem && (
            <div className="notice problem" role="alert">
              {chat.problem.message}{' '}
              <button className="text-button" onClick={chat.retry}>
                重试
              </button>
            </div>
          )}
          {(chat.outdatedDraft || chat.conflict) && (
            <div className="notice problem">
              问题已经更新。
              <button className="text-button" onClick={() => chat.editDraft(chat.draft)}>
                将草稿用于当前问题
              </button>
            </div>
          )}
          <form className="chat-composer" onSubmit={submit}>
            <textarea
              ref={textarea}
              aria-label="给同伴的话"
              placeholder="写给学习同伴…"
              rows={3}
              maxLength={4000}
              value={value}
              disabled={pending || unavailable || !!chat.retryOperation}
              onChange={(e) => edit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing)
                  e.currentTarget.form?.requestSubmit();
              }}
            />
            <div>
              <span>⌘ / Ctrl + Enter</span>
              <button
                className="primary-button"
                disabled={
                  (!sessionId && !excerptValid) ||
                  !value.trim() ||
                  pending ||
                  unavailable ||
                  !!chat.retryOperation ||
                  chat.refreshingConflict ||
                  chat.outdatedDraft
                }
              >
                发送 <Icon name="send" />
              </button>
            </div>
          </form>
        </section>
        <aside className="chat-history">
          <div className="subhead">
            <h2>最近对话</h2>
          </div>
          <ReadState resource={chats} />
          {historyList.map((c) => (
            <a href={chatPath(c.id)} key={c.id} aria-current={sessionId === c.id ? 'page' : undefined}>
              <Icon name="chat" />
              <span>{c.title}</span>
            </a>
          ))}
          {chats.data && !historyList.length && <p className="muted">开始对话后，可以从这里继续。</p>}
        </aside>
      </div>
    </>
  );
}
