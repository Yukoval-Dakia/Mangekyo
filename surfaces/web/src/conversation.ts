import { useEffect, useRef, useState } from "react";
import { api, ApiError, remember, remembered, requestId, sessionEvents, sessionPath, type Session, type SessionEvent, type StudyAttachment } from "./api";

type Operation =
  | { kind: "create"; requestId: string; question?: string; attachment?: StudyAttachment }
  | { kind: "answer"; requestId: string; sessionId: string; parentId: string; answer: string };

const progressLabels: Record<NonNullable<SessionEvent["phase"]>, string> = {
  queued: "正在等待同伴…",
  thinking: "同伴正在处理你的问题…",
  reading: "同伴正在查看学习记录…",
  checking: "同伴正在核对这轮教学任务…",
  replying: "同伴正在回复…",
};

export function useConversation(caseId: string, active: boolean, initialSession?: Session, restore = true) {
  const sessionKey = `session:${caseId}`;
  const createKey = `create:${caseId}`;
  const [sessionId, setSessionId] = useState(() => initialSession?.id ?? (restore ? remembered(sessionKey) : null));
  const [session, setSession] = useState(initialSession);
  const [draft, setDraft] = useState<{ text: string; parentId: string }>();
  const [conflict, setConflict] = useState(false);
  const [refreshingConflict, setRefreshingConflict] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [retryOperation, setRetryOperation] = useState<Operation>();
  const [sendingAnswer, setSendingAnswer] = useState<string>();
  const [problem, setProblem] = useState<{ source: "read" | "write"; message: string }>();
  const [refresh, setRefresh] = useState(0);

  const [streamingReply, setStreamingReply] = useState<string>();
  const [progressLabel, setProgressLabel] = useState<string>();
  const [reconnecting, setReconnecting] = useState(false);
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  useEffect(() => {
    if (!active || !sessionId || busy || retryOperation) return;
    const controller = new AbortController();
    const source = sessionEvents(sessionId);
    const baseline = sessionRef.current?.id === sessionId ? sessionRef.current : undefined;
    let terminal = false;
    let didHydrate = Boolean(baseline);

    function clearReadProblem() {
      setRefreshingConflict(false);
      setInvalidated(false);
      setProblem(previous => previous?.source === "write" ? previous : undefined);
    }

    function invalidate(status: number) {
      if (status === 404) {
        if (remembered(sessionKey) === sessionId) remember(sessionKey, null);
        setSessionId(null);
        setSession(undefined);
      }
      const staleEvidence = status === 409;
      setInvalidated(staleEvidence);
      if (staleEvidence) setSession(undefined);
      setStreamingReply(undefined);
      setProgressLabel(undefined);
      setProblem({
        source: "read",
        message: staleEvidence ? "这次对话的依据已更新，请开始新对话。" : "暂时无法读取这次对话。",
      });
    }

    async function hydrate(final: boolean) {
      try {
        const current = await api<Session>(sessionPath(sessionId!), { signal: controller.signal });
        if (controller.signal.aborted || (!final && terminal)) return;
        setSession(current);
        clearReadProblem();
        if (final) {
          setStreamingReply(undefined);
          setProgressLabel(undefined);
        }
      } catch (error) {
        if (controller.signal.aborted || (!final && terminal)) return;
        if (final) invalidate(error instanceof ApiError ? error.status : 0);
      }
    }

    function receive(event: MessageEvent<string>): SessionEvent | undefined {
      const update = JSON.parse(event.data) as SessionEvent;
      if (update.session?.id !== sessionId || controller.signal.aborted) return;
      clearReadProblem();
      setReconnecting(false);
      return update;
    }

    source.addEventListener("progress", (event: MessageEvent<string>) => {
      const update = receive(event);
      if (!update) return;
      setSession(previous => {
        if (previous?.id === sessionId && previous.currentTurnId === update.session.currentTurnId && previous.status !== "pending") {
          return previous;
        }
        return { ...update.session, turns: previous?.id === sessionId ? previous.turns : [] };
      });
      setProgressLabel(update.phase ? progressLabels[update.phase] : undefined);
      setStreamingReply(update.message);
      // Restore prior turns for a remembered session while the current one streams.
      if (!didHydrate) {
        didHydrate = true;
        void hydrate(false);
      }
    });

    source.addEventListener("complete", (event: MessageEvent<string>) => {
      const update = receive(event);
      if (!update) return;
      terminal = true;
      source.close();
      if (baseline?.currentTurnId === update.session.currentTurnId && baseline?.status === update.session.status) {
        setStreamingReply(undefined);
        setProgressLabel(undefined);
        return;
      }
      // Render the accepted public reply immediately, then hydrate the
      // learner's authorized session view once. The stream never carries audit fields.
      setStreamingReply(update.message);
      setProgressLabel(undefined);
      void hydrate(true);
    });

    source.addEventListener("session-error", (event: MessageEvent<string>) => {
      terminal = true;
      source.close();
      setReconnecting(false);
      invalidate((JSON.parse(event.data) as { status: number }).status);
    });

    source.onerror = () => {
      if (controller.signal.aborted || terminal) return;
      if (source.readyState === EventSource.CLOSED) invalidate(0);
      else setReconnecting(true);
    };

    return () => {
      source.close();
      controller.abort();
    };
  }, [active, busy, refresh, retryOperation, sessionId, sessionKey]);

  async function perform(operation: Operation) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setSendingAnswer(operation.kind === "answer" ? operation.answer : operation.question);
    setStreamingReply(undefined);
    setProgressLabel(undefined);
    setReconnecting(false);
    setProblem(undefined);
    setConflict(false);
    try {
      const result = operation.kind === "create"
        ? await api<Session>("/sessions", {
          method: "POST",
          body: { caseId, requestId: operation.requestId, question: operation.question, attachment: operation.attachment },
        })
        : await api<Session>(`${sessionPath(operation.sessionId)}/answers`, {
          method: "POST",
          body: { answer: operation.answer, parentId: operation.parentId, requestId: operation.requestId },
        });
      remember(sessionKey, result.id);
      if (operation.kind === "create") remember(createKey, null);
      setSessionId(result.id);
      setSession(result);
      setRefreshingConflict(false);
      setInvalidated(false);
      setDraft(undefined);
      setRetryOperation(undefined);
    } catch (error) {
      if (operation.kind === "answer" && error instanceof ApiError && error.status === 409) {
        setRetryOperation(undefined);
        setConflict(true);
        setRefreshingConflict(true);
        return;
      }
      const rejected = error instanceof ApiError && [400, 401, 403, 404, 413, 415, 422].includes(error.status);
      if (rejected && operation.kind === "create") remember(createKey, null);
      setRetryOperation(rejected ? undefined : operation);
      setProblem({
        source: "write",
        message: error instanceof ApiError && error.status === 422 ? "这次对话使用原模型端点，请新建对话以使用当前端点。" :
          operation.kind === "create" ? "暂时无法开始对话。" : "暂时无法发送这条作答。",
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
      setSendingAnswer(undefined);
    }
  }

  function start(question?: string, attachment?: StudyAttachment) {
    if (inFlight.current || retryOperation) return;
    const text = question?.trim();
    const id = text ? requestId() : remembered(createKey) ?? requestId();
    if (!text) remember(createKey, id);
    void perform({ kind: "create", requestId: id, ...(text ? { question: text } : {}), ...(attachment ? { attachment } : {}) });
  }

  function send() {
    const answer = draft?.text.trim();
    const parentId = session?.currentTurnId;
    if (!session || session.status !== "ready" || !answer || !parentId || draft?.parentId !== parentId || retryOperation) return;
    void perform({ kind: "answer", requestId: requestId(), sessionId: session.id, parentId, answer });
  }

  function editDraft(text: string) {
    if (!session?.currentTurnId) return;
    setDraft({ text, parentId: session.currentTurnId });
    setConflict(false);
  }

  function retry() {
    if (retryOperation) void perform(retryOperation);
    else if (problem?.source === "write" && !sessionId) start();
    else {
      setProblem(undefined);
      setRefresh((current) => current + 1);
    }
  }

  return {
    sessionId,
    session,
    draft: draft?.text ?? "",
    outdatedDraft: Boolean(draft?.text.trim() && draft.parentId !== session?.currentTurnId),
    editDraft,
    conflict,
    refreshingConflict,
    invalidated,
    busy,
    sendingAnswer,
    streamingReply,
    progressLabel,
    reconnecting,
    retryOperation,
    problem,
    start,
    send,
    retry,
  };
}
