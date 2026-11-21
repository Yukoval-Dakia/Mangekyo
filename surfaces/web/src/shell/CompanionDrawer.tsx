import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, sessionPath, type Session, type Settings, type Turn } from "../api";
import { useConversation } from "../conversation";
import { Icon } from "../icons";
import { Message } from "../message";
import { chatRoute, forTask } from "../model-route";
import type { ChatLink, Resource } from "../workspace";

type Purpose = "daily" | "once";

function TurnEvidence({ turn }: { turn: Turn }) {
  const rationale = turn.reads.reduce(
    (text, item) => text.replaceAll(item.id, item.title),
    turn.rationale,
  );
  const hasDetails = Boolean(
    rationale || (turn.trace && turn.trace.length > 0) || turn.reads.length > 0 || turn.model || turn.reportedModel,
  );
  return (
    <details className="drawer-evidence">
      <summary>
        <span>本轮操作与依据</span>
        <Icon name="chevron" />
      </summary>
      <div className="drawer-evidence-body">
        {rationale && <p>{rationale}</p>}
        {turn.trace && turn.trace.length > 0 && (
          <ol aria-label="本轮操作步骤">
            {turn.trace.map((step, index) => <li key={index}>{step}</li>)}
          </ol>
        )}
        {turn.reads.length > 0 && (
          <ul aria-label="本轮参考依据">
            {turn.reads.map(item => (
              <li key={item.id}>
                <strong>{item.title}</strong>
              </li>
            ))}
          </ul>
        )}
        {(turn.reportedModel || turn.model) && (
          <p>模型：{turn.reportedModel || turn.model}</p>
        )}
        {!hasDetails && <p>本轮没有记录额外操作或参考依据。</p>}
      </div>
    </details>
  );
}

function DrawerThread({
  open,
  initial,
  settings,
  purpose,
  onPurposeChange,
  quote,
  onClearQuote,
  onOpenSettings,
  onReloadChats,
  onOpenFull,
  contextSection,
  recentSection,
}: {
  open: boolean;
  initial?: Session | undefined;
  settings: Settings | undefined;
  purpose: Purpose;
  onPurposeChange: (next: Purpose) => void;
  quote: string;
  onClearQuote: () => void;
  onOpenSettings: () => void;
  onReloadChats: () => void;
  onOpenFull: (href: string) => void;
  contextSection: ReactNode;
  recentSection: ReactNode;
}) {
  const chat = useConversation("companion", open, initial, false);
  const [opening, setOpening] = useState("");
  const [replyInput, setReplyInput] = useState("");
  const taskSettings = settings ? forTask(settings, "companion") : undefined;
  const activeRoute = settings ? chatRoute(settings, "companion") : undefined;
  const modelReady = Boolean(taskSettings?.hasKey && activeRoute);
  const turns = chat.session?.turns ?? [];
  const pending = chat.busy || chat.session?.status === "pending";
  const value = chat.sessionId ? replyInput : opening;

  useEffect(() => {
    if (chat.sessionId && !initial) onReloadChats();
  }, [chat.sessionId, initial, onReloadChats]);

  useEffect(() => {
    if (!chat.sessionId) return;
    const composed = [quote, replyInput.trim()].filter(Boolean).join("\n\n");
    chat.editDraft(composed);
  }, [chat.sessionId, chat.session?.currentTurnId, quote, replyInput]);

  function updateText(next: string) {
    if (chat.sessionId) setReplyInput(next);
    else setOpening(next);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!modelReady || pending) return;
    const composed = [quote, value.trim()].filter(Boolean).join("\n\n");
    if (!composed) return;
    const allowBackground = purpose === "daily";
    if (chat.sessionId) {
      chat.send([], activeRoute, undefined, allowBackground);
      setReplyInput("");
    } else {
      chat.start(composed, undefined, [], activeRoute, undefined, allowBackground);
      setOpening("");
    }
    if (quote) onClearQuote();
  }

  return (
    <>
      <div className="drawer-body">
        {contextSection}

        <section className="drawer-section" aria-label="对话记录">
          <div className="drawer-section-head">
            <h3>{chat.sessionId ? "当前对话" : "新对话"}</h3>
            <button
              className="text-button"
              type="button"
              onClick={() => onOpenFull(chat.sessionId ? `/companion?session=${encodeURIComponent(chat.sessionId)}` : "/companion")}
              disabled={!open}
            >
              完整同伴页
            </button>
          </div>
          {!modelReady && (
            <div className="drawer-note" role="status">
              <p>尚未配置可用模型，学习同伴暂时无法生成回复，也不会伪造回答。你可以先前往设置配置模型，或翻看已有对话记录。</p>
              <div>
                <button className="tonal-button drawer-cite" type="button" onClick={onOpenSettings} disabled={!open}>
                  前往学习设置
                </button>
              </div>
            </div>
          )}
          {turns.length > 0 ? (
            <ol className="drawer-thread">
              {turns.map((turn, index) => (
                <li className="drawer-turn" key={turn.turnId ?? index}>
                  {turn.answer && <div className="drawer-user-msg">{turn.answer}</div>}
                  <article className="drawer-reply">
                    <Message text={turn.message} />
                    <TurnEvidence turn={turn} />
                  </article>
                </li>
              ))}
            </ol>
          ) : (
            modelReady && <p className="drawer-empty">可以直接写下卡住的一步，或先点击上方「引用当前内容」。</p>
          )}
          {pending && (
            <div className="drawer-note" role="status">
              <p>{chat.progressLabel || "同伴正在处理…"}</p>
              {chat.streamingReply && <Message text={chat.streamingReply} />}
            </div>
          )}
          {chat.problem && (
            <div className="drawer-note problem" role="alert">
              <p>{chat.problem.message}</p>
              <button className="text-button" type="button" onClick={chat.retry} disabled={!open}>重试</button>
            </div>
          )}
        </section>

        {recentSection}
      </div>

      <footer className="drawer-footer">
        <form className="drawer-composer" onSubmit={handleSubmit}>
          <div className="drawer-purpose-row">
            <span className="drawer-purpose-label">本轮用途</span>
            <div className="segmented-radio" role="radiogroup" aria-label="本轮用途">
              {([["daily", "日常学习"], ["once", "仅本次回答"]] as const).map(([option, label]) => (
                <label key={option}>
                  <input
                    type="radio"
                    name="companion-purpose"
                    checked={purpose === option}
                    onChange={() => onPurposeChange(option)}
                    disabled={!open}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>
          <textarea
            className="drawer-textarea"
            rows={3}
            value={value}
            onChange={event => updateText(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={modelReady ? "写下卡住的那一步…（⌘ / Ctrl + Enter 发送）" : "配置模型后即可直接在这里提问"}
            disabled={!open || !modelReady || pending}
          />
          <div className="drawer-composer-actions">
            <span className="drawer-hint">
              {purpose === "daily" ? "本轮允许整理学习观察" : "仅本次回答，不整理学习观察"}
            </span>
            <button
              className="primary-button drawer-send"
              type="submit"
              disabled={!open || !modelReady || pending || (!value.trim() && !quote)}
            >
              发送 <Icon name="send" />
            </button>
          </div>
        </form>
      </footer>
    </>
  );
}

export function CompanionDrawer({
  open,
  route,
  pageLabel,
  settings,
  chats,
  onClose,
  onOpenCompanion,
  onOpenSettings,
  pendingCitation,
}: {
  open: boolean;
  route: string;
  pageLabel: string;
  settings: Settings | undefined;
  chats: Resource<ChatLink[]>;
  onClose: () => void;
  onOpenCompanion: (href: string) => void;
  onOpenSettings: () => void;
  pendingCitation?: { title: string; text: string; topic?: string; seq: number } | undefined;
}) {
  const [purpose, setPurpose] = useState<Purpose>("daily");
  const [quote, setQuote] = useState("");
  const [contextTitle, setContextTitle] = useState(pageLabel);
  const [selectedText, setSelectedText] = useState("");
  const [activeSession, setActiveSession] = useState<Session | undefined>(undefined);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const lastCitationSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const heading = document.querySelector<HTMLHeadingElement>("#main-content h1, #main-content h2")?.textContent?.trim();
    const selection = window.getSelection()?.toString().trim() ?? "";
    setContextTitle(heading || pageLabel);
    setSelectedText(selection);
  }, [open, route, pageLabel]);

  useEffect(() => {
    if (!pendingCitation || pendingCitation.seq === lastCitationSeq.current) return;
    lastCitationSeq.current = pendingCitation.seq;
    const topic = pendingCitation.topic?.trim();
    const excerpt = pendingCitation.text.trim() || pendingCitation.title.trim();
    setQuote(
      `【引用学习项：${pendingCitation.title.trim()}】` +
        (topic ? `\n主题：${topic}` : "") +
        `\n${excerpt.slice(0, 800)}`,
    );
  }, [pendingCitation]);

  function citeCurrent() {
    const excerpt = selectedText || contextTitle || pageLabel;
    setQuote(`【引用当前页面：${pageLabel}】\n${excerpt.slice(0, 800)}`);
  }

  async function openHistory(chatId: string) {
    setLoadingSession(true);
    setSessionError("");
    try {
      const loaded = await api<Session>(sessionPath(chatId));
      if (loaded.caseId === "companion" || loaded.caseId === "riding") {
        setActiveSession(loaded);
      } else {
        onOpenCompanion(`/classroom/first45?session=${encodeURIComponent(chatId)}`);
      }
    } catch {
      setSessionError("暂时无法读取这段历史对话。");
    } finally {
      setLoadingSession(false);
    }
  }

  const recentChats = (chats.data ?? []).filter(item => item.caseId === "companion" || item.caseId === "riding").slice(0, 5);

  const contextSection = (
    <section className="drawer-section">
      <div className="drawer-context-row">
        <p className="drawer-context">正在查看：{contextTitle}</p>
        <button className="tonal-button drawer-cite" type="button" onClick={citeCurrent} disabled={!open}>
          引用当前内容
        </button>
      </div>
      {quote && (
        <blockquote className="drawer-quote">
          <span>{quote}</span>
          <button className="text-button" type="button" onClick={() => setQuote("")} disabled={!open}>移除引用</button>
        </blockquote>
      )}
    </section>
  );

  const recentSection = (
    <section className="drawer-section">
      <div className="drawer-section-head">
        <h3>最近对话</h3>
        {loadingSession && <span className="drawer-hint">读取中…</span>}
      </div>
      {sessionError && <p className="error-text" role="alert">{sessionError}</p>}
      {chats.error && <p className="drawer-empty">暂时无法读取最近对话。</p>}
      {recentChats.length > 0 ? (
        <ul className="drawer-card-list">
          {recentChats.map(item => (
            <li key={item.id}>
              <button className="drawer-card-button" type="button" onClick={() => void openHistory(item.id)} disabled={!open}>
                <span>{item.title}</span>
                <Icon name="chevron" />
              </button>
            </li>
          ))}
        </ul>
      ) : !chats.error && <p className="drawer-empty">还没有已保存的同伴对话。</p>}
    </section>
  );

  return (
    <aside className="app-drawer" data-open={open} data-drawer="companion" aria-label="学习同伴" aria-hidden={!open}>
      <header className="drawer-header">
        <div>
          <h2>学习同伴</h2>
          <p className="drawer-subtitle">当前位置：{pageLabel}</p>
        </div>
        <div className="drawer-header-actions">
          {activeSession && (
            <button className="text-button" type="button" onClick={() => setActiveSession(undefined)} disabled={!open}>
              新对话
            </button>
          )}
          <button className="icon-button" type="button" onClick={onClose} disabled={!open} aria-label="关闭学习同伴">
            <Icon name="close" />
          </button>
        </div>
      </header>
      <DrawerThread
        key={activeSession?.id ?? "new"}
        open={open}
        initial={activeSession}
        settings={settings}
        purpose={purpose}
        onPurposeChange={setPurpose}
        quote={quote}
        onClearQuote={() => setQuote("")}
        onOpenSettings={onOpenSettings}
        onReloadChats={chats.reload}
        onOpenFull={onOpenCompanion}
        contextSection={contextSection}
        recentSection={recentSection}
      />
    </aside>
  );
}
