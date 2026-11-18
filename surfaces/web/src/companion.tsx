import { useEffect, useRef, useState, type FormEvent } from 'react';
import { remembered, remember, sessionPath, type Session } from './api';
import { useConversation } from './conversation';
import { Icon, Mark } from './icons';
import { Message } from './message';
import { TeachingTurn } from './demo';
import { chatPath, PageTitle, ReadState, useResource, type ChatLink, type Resource } from './workspace';

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

export function Companion({ chats }: { chats: Resource<ChatLink[]> }) {
  const [query] = useState(() => new URLSearchParams(location.search));
  const id = query.get('session');
  if (id) return <LinkedChat id={id} chats={chats} />;
  return <ChatRoom mode={query.get('context') === 'riding' ? 'riding' : 'companion'} chats={chats} />;
}

function ChatRoom({
  mode,
  initial,
  chats,
}: {
  mode: string;
  initial?: Session;
  chats: Resource<ChatLink[]>;
}) {
  const chat = useConversation(mode, true, initial, false);
  const { session, sessionId, busy, streamingReply, progressLabel, reconnecting } = chat;
  const draftKey = 'free-chat:' + (sessionId ?? mode);
  const [opening, setOpening] = useState(() => remembered(draftKey) ?? '');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastId = useRef<string | undefined>(initial?.id);
  const feedEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sessionId && sessionId !== lastId.current) {
      lastId.current = sessionId;
      history.replaceState(null, '', chatPath(sessionId));
      remember('free-chat:' + mode, null);
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
    else chat.start(value.trim());
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
          {mode === 'riding' && (
            <a className="context-tag" href="/materials/riding">
              <Icon name="book" /> 正在讨论《同一趟骑行，两块码表》
            </a>
          )}
          {!session?.turns.length && !pending && !unavailable && (
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
                <TeachingTurn key={i} turn={t} />
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
