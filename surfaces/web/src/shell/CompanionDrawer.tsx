import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, isCarePauseTurn, sessionPath, type Session, type Settings, type Turn } from "../api";
import { teachingPage, type CurrentObject } from "../current-record";
import { useConversation } from "../conversation";
import { Icon } from "../icons";
import { Message } from "../message";
import { chatRoute } from "../model-route";
import type { ChatLink, Resource } from "../workspace";
import { RecoveryGuide } from "../recovery";
import { AgentThinkingSteps } from "./AgentThinkingSteps";
import { CarePauseNotice } from "./CarePauseNotice";
import { TurnArtifacts } from "../presentation/TurnArtifact";
import { TurnBasisChips } from "./TurnBasisChips";
import { resolveTurnCitations } from "./inline-citations";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RECORD_ROUTE = /^\/materials\/records\/([0-9A-HJKMNP-TV-Z]{26})/;
const PAPER_ROUTE = /^\/papers\/([0-9A-HJKMNP-TV-Z]{26})/;
const SAVED_ROUTE = /^\/materials\/saved\/([0-9A-HJKMNP-TV-Z]{26})/;

function isValidCurrentObject(value: unknown): value is CurrentObject {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length !== 3) return false;
  const candidate = value as { kind?: unknown; id?: unknown; rev?: unknown };
  return (
    (candidate.kind === "attempt" || candidate.kind === "page") &&
    typeof candidate.id === "string" &&
    ULID_PATTERN.test(candidate.id) &&
    typeof candidate.rev === "number" &&
    Number.isSafeInteger(candidate.rev) &&
    candidate.rev > 0
  );
}

export type DrawerFocus = { label: string; currentObject?: CurrentObject };

type FocusableRecord = {
  id: string;
  rev: number;
  title: string;
  kind?: string;
  category?: string;
  teaching?: boolean;
};

function focusFromRecord(record: FocusableRecord): DrawerFocus {
  if (Number.isSafeInteger(record.rev) && record.rev > 0) {
    if (record.category === "attempt" || record.kind === "attempt") {
      return { label: record.title, currentObject: { kind: "attempt", id: record.id, rev: record.rev } };
    }
    if (teachingPage(record)) {
      return { label: record.title, currentObject: { kind: "page", id: record.id, rev: record.rev } };
    }
  }
  return { label: record.title };
}

function TurnEvidence({ turn }: { turn: Turn }) {
  const rationale = turn.reads.reduce(
    (text, item) => text.replaceAll(item.id, item.title),
    turn.rationale,
  );
  const hasDetails = Boolean(
    rationale || turn.reads.length > 0 || turn.model || turn.reportedModel,
  );
  return (
    <details className="drawer-evidence">
      <summary>
        <span>本轮操作与依据</span>
        <Icon name="chevron" />
      </summary>
      <div className="drawer-evidence-body">
        {rationale && <p>{rationale}</p>}
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

function DrawerTurnBody({
  turn,
  onNavigate,
}: {
  turn: Turn;
  onNavigate: (href: string) => void;
}) {
  const citations = useMemo(() => resolveTurnCitations(turn), [turn]);
  const carePause = isCarePauseTurn(turn);
  return (
    <>
      <Message text={turn.message} citations={citations.byId} onNavigate={onNavigate} />
      {!carePause && <TurnBasisChips turn={turn} resolved={citations} onNavigate={onNavigate} />}
    </>
  );
}

function DrawerThread({
  open,
  initial,
  settings,
  quote,
  onClearQuote,
  onOpenSettings,
  onReloadChats,
  onOpenFull,
  activeFocus,
  contextSection,
  recentSection,
}: {
  open: boolean;
  initial?: Session | undefined;
  settings: Settings | undefined;
  quote: string;
  onClearQuote: () => void;
  onOpenSettings: () => void;
  onReloadChats: () => void;
  onOpenFull: (href: string) => void;
  activeFocus?: DrawerFocus | undefined;
  contextSection: ReactNode;
  recentSection: ReactNode;
}) {
  const chat = useConversation("companion", open, initial, false);
  const [opening, setOpening] = useState("");
  const [replyInput, setReplyInput] = useState("");
  const activeRoute = settings ? chatRoute(settings, "companion") : undefined;
  const modelReady = Boolean(activeRoute);
  const turns = chat.session?.turns ?? [];
  const pending = chat.busy || chat.session?.status === "pending";
  const value = chat.sessionId ? replyInput : opening;
  const sessionStatus = chat.session?.status;
  const sessionDown = sessionStatus === "failed" || sessionStatus === "unknown" || chat.invalidated;

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
    const currentObject = activeFocus?.currentObject;
    if (chat.sessionId) {
      chat.send([], activeRoute, currentObject, true);
      setReplyInput("");
    } else {
      chat.start(composed, undefined, [], activeRoute, currentObject, true);
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
              {turns.map((turn, index) => {
                const carePause = isCarePauseTurn(turn);
                return (
                  <li className="drawer-turn" key={turn.turnId ?? index}>
                    {turn.answer && <div className="drawer-user-msg">{turn.answer}</div>}
                    <article className="drawer-reply">
                      {!carePause && <AgentThinkingSteps chat={chat} turn={turn} />}
                      <DrawerTurnBody turn={turn} onNavigate={onOpenFull} />
                      {carePause && <CarePauseNotice disabled={!open} />}
                      {chat.session && chat.session.mounts.length > 0 && (
                        <TurnArtifacts
                          mounts={chat.session.mounts.filter(m => m.turnId === turn.turnId)}
                          apply={chat.applySnapshot}
                          live={false}
                        />
                      )}
                      {!carePause && <TurnEvidence turn={turn} />}
                    </article>
                  </li>
                );
              })}
            </ol>
          ) : (
            modelReady && <p className="drawer-empty">可以直接写下卡住的一步，或先点击上方「引用当前内容」。</p>
          )}
          {pending && (
            <div className="drawer-note" role="status">
              {(chat.sendingAnswer || chat.session?.pendingAnswer) && (
                <div className="drawer-user-msg">{chat.sendingAnswer || chat.session?.pendingAnswer}</div>
              )}
              <AgentThinkingSteps
                chat={chat}
                progress={chat.reconnecting ? '正在重连…' : chat.progressLabel || '同伴正在处理…'}
              />
              {chat.streamingReply && <Message text={chat.streamingReply} streaming />}
              {chat.session?.status === 'pending' && chat.session.mounts.length > 0 && (
                <TurnArtifacts
                  mounts={chat.session.mounts.filter(m => m.turnId === chat.session!.currentTurnId)}
                  apply={chat.applySnapshot}
                  live
                />
              )}
            </div>
          )}
          {!pending && sessionDown && (
            <RecoveryGuide
              status={sessionStatus === "unknown" ? "unknown" : "failed"}
              detail={chat.session?.error}
              onResend={() => chat.retry()}
              onOpenPrivacy={() => onOpenFull("/me?section=privacy")}
            />
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
            <span className="drawer-hint">⌘ / Ctrl + Enter 发送</span>
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
  pendingCitation?:
    | { title: string; text: string; topic?: string; seq: number; currentObject?: CurrentObject | undefined; focusLabel?: string | undefined }
    | undefined;
}) {
  const [quote, setQuote] = useState("");
  const [contextTitle, setContextTitle] = useState(pageLabel);
  const [selectedText, setSelectedText] = useState("");
  const [activeSession, setActiveSession] = useState<Session | undefined>(undefined);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const lastCitationSeq = useRef(0);
  const [citationFocus, setCitationFocus] = useState<DrawerFocus | null>(null);
  const [routeRecordFocus, setRouteRecordFocus] = useState<{ key: string; focus: DrawerFocus } | null>(null);
  const [dismissedFocusKey, setDismissedFocusKey] = useState("");

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
    const object = isValidCurrentObject(pendingCitation.currentObject) ? pendingCitation.currentObject : null;
    const label = pendingCitation.focusLabel?.trim() || pendingCitation.title.trim();
    setCitationFocus(object || label ? { label: label || "这条学习记录", ...(object ? { currentObject: object } : {}) } : null);
    setDismissedFocusKey("");
    setQuote(
      `【引用学习项：${pendingCitation.title.trim()}】` +
        (topic ? `\n主题：${topic}` : "") +
        `\n${excerpt.slice(0, 800)}`,
    );
  }, [pendingCitation]);

  const recordMatch = RECORD_ROUTE.exec(route);
  const paperMatch = PAPER_ROUTE.exec(route);
  const savedMatch = SAVED_ROUTE.exec(route);
  const routeRecordId = recordMatch?.[1];

  useEffect(() => {
    if (!open || !routeRecordId) return;
    const controller = new AbortController();
    api<FocusableRecord>(`/workspace/access/records/${encodeURIComponent(routeRecordId)}`, { signal: controller.signal })
      .then((record) => {
        if (controller.signal.aborted) return;
        if (!record || typeof record.id !== "string" || !Number.isSafeInteger(record.rev)) return;
        setRouteRecordFocus({ key: `${record.id}:${record.rev}`, focus: focusFromRecord(record) });
      })
      .catch(() => {
        // 静默容错：记录不可读时不展示聚焦胶囊，也不打断抽屉。
      });
    return () => controller.abort();
  }, [open, routeRecordId]);

  const routeFocus = useMemo<DrawerFocus | null>(() => {
    if (routeRecordId) {
      if (!routeRecordFocus || !routeRecordFocus.key.startsWith(`${routeRecordId}:`)) return null;
      return routeRecordFocus.focus;
    }
    const staticLabel = paperMatch
      ? "答题书桌"
      : savedMatch
        ? "这份已保存材料"
        : null;
    return staticLabel ? { label: staticLabel } : null;
  }, [routeRecordId, routeRecordFocus, paperMatch, savedMatch]);

  const activeFocus = citationFocus ?? routeFocus;
  const activeFocusKey = activeFocus?.currentObject
    ? `obj:${activeFocus.currentObject.kind}:${activeFocus.currentObject.id}:${activeFocus.currentObject.rev}`
    : activeFocus
      ? `label:${routeRecordId ?? route}:${activeFocus.label}`
      : "";
  const shownFocus = activeFocus && activeFocusKey !== dismissedFocusKey ? activeFocus : null;

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
        onOpenCompanion(`/classroom?session=${encodeURIComponent(chatId)}`);
      }
    } catch {
      setSessionError("暂时无法读取这段历史对话。");
    } finally {
      setLoadingSession(false);
    }
  }

  const recentChats = (chats.data ?? []).filter(item => item.caseId === "companion" || item.caseId === "riding").slice(0, 5);

  useEffect(() => {
    setDismissedFocusKey("");
  }, [route]);

  const contextSection = (
    <section className="drawer-section">
      {shownFocus && (
        <p className="drawer-focus-chip" role="status">
          <span className={shownFocus.currentObject ? "drawer-focus-dot drawer-focus-dot--bound" : "drawer-focus-dot"} aria-hidden="true" />
          <span className="drawer-focus-label">当前聚焦：{shownFocus.label}</span>
          <button
            className="drawer-focus-dismiss"
            type="button"
            aria-label="取消聚焦"
            disabled={!open}
            onClick={() => setDismissedFocusKey(activeFocusKey)}
          >
            ×
          </button>
        </p>
      )}
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
        quote={quote}
        onClearQuote={() => setQuote("")}
        onOpenSettings={onOpenSettings}
        onReloadChats={chats.reload}
        onOpenFull={onOpenCompanion}
        activeFocus={shownFocus ?? undefined}
        contextSection={contextSection}
        recentSection={recentSection}
      />
    </aside>
  );
}
