import { recordFromQuery, recordFromSession, recordLabel, type CurrentObject } from './current-record';
import { chatRoute, taskLabels, type Route } from './model-route';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, remembered, remember, sessionPath, type Session, type Settings, type StudyAttachment } from './api';
import { useConversation } from './conversation';
import { Icon, Mark } from './icons';
import { TeachingTurn } from './demo';
import { chatPath, materialPath, PageTitle, ReadState, useResource, type ChatLink, type Material, type Resource } from './workspace';

function LinkedChat({ id, chats, settings }: { settings: Settings | undefined; id: string; chats: Resource<ChatLink[]> }) {
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
  if (record.data.id !== id) return <p role="alert">无法读取这次对话。</p>;
  if (!['companion', 'riding'].includes(record.data.caseId))
    return (
      <>
        <PageTitle title="示例课堂" />
        <a href={'/classroom/first45?session=' + encodeURIComponent(id)}>打开这次教研记录</a>
      </>
    );
  return <ChatRoom mode={record.data.caseId} initial={record.data} chats={chats} settings={settings} />;
}

function MaterialChat({id, prepare, chats, settings}: {settings: Settings | undefined; id: string; prepare: boolean; chats: Resource<ChatLink[]>}) {
  const source = useResource<Material>('/materials/'+encodeURIComponent(id)+'/reading');
  if (!source.data) return <><PageTitle title="读取材料" /><ReadState resource={source} /><a href="/materials">返回材料</a></>;
  return <ChatRoom mode="companion" chats={chats} settings={settings} source={source.data} prepare={prepare} />;
}
export function Companion({ chats, settings }: { settings: Settings | undefined; chats: Resource<ChatLink[]> }) {
  const [query] = useState(() => new URLSearchParams(location.search));
  const id = query.get('session');
  if (id) return <LinkedChat id={id} chats={chats} settings={settings} />;
  const materialId = query.get('material');
  if (materialId) return <MaterialChat id={materialId} prepare={query.get('mode') === 'prepare'} chats={chats} settings={settings} />;
  if (query.get('context') === 'riding') return <ChatRoom mode="riding" chats={chats} settings={settings} />;
  const entry = recordFromQuery(query);
  if (query.has('record') && !entry) return <><PageTitle title="同伴" /><p role="alert">记录链接缺少有效版本，请从原记录重新进入。</p><a href="/companion">开始普通对话</a></>;
  return <ChatRoom mode="companion" entry={entry} chats={chats} settings={settings} />;
}

function ChatRoom({
  mode,
  initial,
  chats,
  source,
  entry,
  settings: allSettings,
  prepare = false,
}: {
  mode: string;
  initial?: Session;
  chats: Resource<ChatLink[]>;
  source?: Material;
  entry?: CurrentObject | undefined;
  settings: Settings | undefined;
  prepare?: boolean;
}) {
  const chat = useConversation(mode, true, initial, false);
  const { session, sessionId, busy, streamingReply, progressLabel, reconnecting } = chat;
  const preparing = initial ? initial.attachment?.mode === 'prepare' : prepare;
  const task = preparing ? 'preparation' : 'companion';
  const [route, setRoute] = useState<Route>();
  const [reviewingRoute, setReviewingRoute] = useState(false);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [routeError, setRouteError] = useState('');
  useEffect(() => {
    if (allSettings) setRoute(first => first ?? chatRoute(allSettings, task));
  }, [allSettings, task]);
  async function reviewNewRoute() {
    setLoadingRoute(true);
    setRouteError('');
    try {
      const next = chatRoute(await api<Settings>('/settings'), task);
      if (!next || ((source || chat.accountConflict) && !next.accountRevision)) throw new Error();
      setRoute(next);
      setReviewingRoute(true);
    } catch {
      setRouteError('无法取得当前任务的发送账户，请检查设置并重试。');
    } finally {
      setLoadingRoute(false);
    }
  }
  const [authorizedDraft, setAuthorizedDraft] = useState<string>();
  const draftTurn = session?.currentTurnId ?? 'opening';
  const allowBackgroundUnderstanding = mode === 'companion' && authorizedDraft === draftTurn;
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const grants = (allSettings?.mcpServers ?? []).filter(server => server.enabled && server.allowedTools.length)
    .map(({id, url, allowedTools}) => ({id, url, allowedTools}));
  const permitted = grants.filter(server => selectedTools.includes(JSON.stringify(server)));
  const [openingRecord, setOpeningRecord] = useState(entry);
  const [keepForTurn, setKeepForTurn] = useState<string>();
  const lastRecord = recordFromSession(session?.currentObject);
  const choiceKey = lastRecord && JSON.stringify([session?.currentTurnId, lastRecord]);
  const displayedRecord = sessionId ? lastRecord : openingRecord;
  const selectedRecord = !sessionId || (choiceKey && choiceKey === keepForTurn) ? displayedRecord : undefined;
  const openingKey = 'free-chat:' + (source ? source.id + ':' + prepare : openingRecord ? JSON.stringify(openingRecord) : mode);
  const draftKey = sessionId ? 'free-chat:' + sessionId : openingKey;
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
      remember(openingKey, null);
      chats.reload();
    }
  }, [sessionId, mode]);
  useEffect(() => {
    if (document.activeElement === textarea.current) feedEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [streamingReply, session?.turns.length]);
  const pending = busy || session?.status === 'pending';
  const unavailable = session?.status === 'failed' || session?.status === 'unknown' || chat.invalidated;
  const value = sessionId ? chat.draft : opening;
  const routeUnavailable = !route || (!!(source || shared) && !route.accountRevision);
  const sendBlocked = routeUnavailable || loadingRoute || (chat.accountConflict && !reviewingRoute);
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
      sendBlocked ||
      unavailable ||
      !value.trim() ||
      chat.retryOperation ||
      chat.outdatedDraft ||
      chat.refreshingConflict
    )
      return;
    if (sessionId) chat.send(permitted, route, selectedRecord, allowBackgroundUnderstanding || undefined);
    else if (excerptValid) {
      const attachment: StudyAttachment | undefined = source
        ? { id: source.id, title: source.title, text: excerpt, mode: prepare ? 'prepare' : 'ask' }
        : undefined;
      chat.start(value.trim(), attachment, permitted, route, selectedRecord, allowBackgroundUnderstanding || undefined);
    }
    setReviewingRoute(false);
    setSelectedTools([]);
  }
  const historyList = chats.data ?? [];
  return (
    <>
      <PageTitle title="同伴">
        <a className="tonal-button" href="/classroom">按主题开课</a>
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
              <textarea rows={4} maxLength={3000} value={excerpt} disabled={busy || !!chat.retryOperation} onChange={e => setExcerpt(e.target.value)} />
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
          {Boolean(session?.turns.length || pending) && (
            <ol className="turns chat-thread">
              {[
                ...(session?.turns ?? []).map((turn, i) =>
                  <TeachingTurn key={turn.turnId ?? i} turn={turn} sessionId={session?.id} materialId={shared?.id}
                    mounts={session?.mounts.filter(m => m.turnId === turn.turnId)} applySnapshot={chat.applySnapshot} reload={chat.reload}
                    discuss={pending || unavailable ? undefined : (question, answer) => {
                      chat.editDraft('题目：' + question + '\n我的回答：' + answer + '\n请根据我的回答指出下一步。');
                      textarea.current?.focus();
                    }} />),
                pending && <TeachingTurn key={session?.status === 'pending' ? session.currentTurnId : 'sending'}
                  answer={chat.sendingAnswer || session?.pendingAnswer} message={streamingReply}
                  progress={reconnecting ? '正在重连…' : progressLabel || '正在连接同伴…'}
                  mounts={session?.status === 'pending' ? session.mounts.filter(m => m.turnId === session.currentTurnId) : []}
                  applySnapshot={chat.applySnapshot} />,
              ]}
            </ol>
          )}
          {!pending && session?.pendingAnswer && <div className="learner-message">
            <span>你</span><p>{session.pendingAnswer}</p>
          </div>}
          <div ref={feedEnd} />
          {unavailable && (
            <p className="notice problem" role="status">
              {session?.error || '这次对话暂时无法继续。'}
            </p>
          )}
          {chat.problem && (
            <div className="notice problem" role="alert">
              {chat.problem.message}{' '}
              {(chat.retryOperation || chat.problem.source === "read") && <button className="text-button" onClick={chat.retry}>
                {chat.retryOperation ? "重试原请求" : "重试"}
              </button>}
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
            {displayedRecord && <fieldset disabled={pending || unavailable || !!chat.retryOperation}>
              <legend>{sessionId ? '最近一轮关联的记录' : '本次提问关联的记录'}</legend>
              <p>{recordLabel(displayedRecord)}</p>
              {sessionId ? <label><input type="checkbox" checked={!!selectedRecord}
                onChange={e => setKeepForTurn(e.target.checked ? choiceKey : undefined)} /> 下轮继续使用这一版</label>
                : <button type="button" className="text-button" onClick={() => {
                  remember(openingKey, null);
                  remember('free-chat:' + mode, opening);
                  setOpeningRecord(undefined);
                  history.replaceState(null, '', '/companion');
                }}>解除关联</button>}
            </fieldset>}
            {mode === 'companion' && <label className="workbook-check">
              <input type="checkbox" checked={allowBackgroundUnderstanding}
                disabled={pending || unavailable || !!chat.retryOperation}
                onChange={event => setAuthorizedDraft(event.target.checked ? draftTurn : undefined)} />
              <span>允许后台从我这条消息整理学习观察</span>
            </label>}
            {route && <small>{taskLabels[task]} · {route.providerId} · {route.protocol} · {route.baseUrl} · {route.model} · {route.reasoningEffort}
              {route.accountRevision && <> · 账户版本 {route.accountRevision}</>}</small>}
            {chat.accountConflict && <p role="alert">发送账户已变更，草稿已保留。
              {sessionId && <a href={shared ? '/companion?material=' + encodeURIComponent(shared.id) + (preparing ? '&mode=prepare' : '') : '/companion'} target="_blank" rel="noreferrer">在新对话中确认发送账户</a>}
            </p>}
            {routeUnavailable && <p role="status">等待确认任务的发送账户。</p>}
            {!sessionId && !pending && !chat.retryOperation && !reviewingRoute &&
              (routeUnavailable || chat.accountConflict || chat.problem?.source === 'write' ||
                (allSettings && JSON.stringify(route) !== JSON.stringify(chatRoute(allSettings, task)))) &&
              <button type="button" className="text-button" disabled={loadingRoute} onClick={() => void reviewNewRoute()}>查看当前账户以发起新请求</button>}
            {routeError && <p role="alert">{routeError}</p>}
            {grants.length > 0 && <fieldset disabled={pending || unavailable || !!chat.retryOperation}>
              <legend>本轮允许使用的 MCP 工具</legend>
              <p className="field-help">选中的服务可收到同伴为调用工具传入的内容，其中可能包含本轮材料、对话或备忘。</p>
              {grants.map(server => {
                const key = JSON.stringify(server);
                return <label key={key} className="workbook-check">
                  <input type="checkbox" checked={selectedTools.includes(key)} onChange={e =>
                    setSelectedTools(current => e.target.checked ? [...current, key] : current.filter(item => item !== key))} />
                  <span>{server.id} · {server.allowedTools.join('、')}<br/><small>{server.url}</small></span>
                </label>;
              })}
            </fieldset>}
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
                  sendBlocked ||
                  (!sessionId && !excerptValid) ||
                  !value.trim() ||
                  pending ||
                  unavailable ||
                  !!chat.retryOperation ||
                  chat.refreshingConflict ||
                  chat.outdatedDraft
                }
              >
                {reviewingRoute ? '确认账户并作为新请求发送' : '发送'} <Icon name="send" />
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
