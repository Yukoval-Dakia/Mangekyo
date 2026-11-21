import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api, ApiError, remember, remembered, requestId, sessionEvents, sessionPath, type Session, type SessionEvent, type StudyAttachment } from "./api";

import type { CurrentObject } from "./current-record";
import type { Route, McpGrant } from './model-route';
import { mountBatches, mountQuery } from "./presentation/mount-coverage.ts";
import { editorDrafts } from "./presentation/editor-draft";
import { useMountPermissions } from "./presentation/mount-permissions";
import { authorizeMounts, refreshDraftBases, readSession, receiptSnapshot, streamSnapshot, type MountedSession, type ArtifactSnapshotV1 } from "./presentation/session-artifacts";

type Operation = {allowBackgroundUnderstanding?: boolean | undefined; currentObject?: CurrentObject | undefined} & (
  | { kind: "create"; route?: Route | undefined; mcpGrants?: McpGrant[] | undefined; requestId: string; question?: string; attachment?: StudyAttachment }
  | { kind: "answer"; route?: Route | undefined; mcpGrants?: McpGrant[] | undefined; requestId: string; sessionId: string; parentId: string; answer: string });

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
  const [session, renderSession] = useState(() => initialSession && readSession(initialSession));
  const sessionRef = useRef(session);
  function setSession(value: MountedSession | undefined) {
    const prior = sessionRef.current?.mounts;
    if (prior && prior !== value?.mounts) {
      const retained = new Set(value?.mounts);
      for (const mount of prior) if (!retained.has(mount)) editorDrafts.delete(mount);
    }
    sessionRef.current = value;
    renderSession(value);
  }
  const lastGrants = useRef<{ session: string; ids: ReadonlySet<string> }>(undefined);
  function knownIds(id: string) {
    const latest = sessionRef.current;
    return [...new Set([...(latest?.id === id ? latest.mounts.map(m => m.mountId) : []),
      ...(lastGrants.current?.session === id ? lastGrants.current.ids : [])])];
  }
  const permissions = useMountPermissions(sessionId, active, knownIds, (watchedSession, removed, unknown, ids) => {
    lastGrants.current = { session: watchedSession, ids };
    const latest = sessionRef.current;
    if (!latest || latest.id !== watchedSession || (!removed.length && !unknown.length)) return;
    const withdrawn = new Set([...latest.withdrawn, ...removed]);
    const uncertain = new Set([...latest.uncertain, ...unknown].filter(id => !withdrawn.has(id)));
    setSession({ ...latest, withdrawn, uncertain, mounts: latest.mounts.filter(m => !withdrawn.has(m.mountId)) });
  });
  // Reads, receipts and turn events supply content. Only the current session
  // permission stream can make that content visible, including after completion.
  const connection = permissions?.connection;
  const [checkedConnection, setCheckedConnection] = useState<symbol>();
  const visibleSession = session && {
    ...session,
    mounts: session.mounts.filter(m => session.id === sessionId && permissions?.ids.has(m.mountId) && !session.uncertain.has(m.mountId) &&
      (!editorDrafts.has(m) || checkedConnection === connection)),
  };
  function applySnapshot(sent: ArtifactSnapshotV1, input: unknown) {
    const latest = sessionRef.current;
    if (!latest?.mounts.some(m => m.sessionId === sent.sessionId && m.turnId === sent.turnId && m.mountId === sent.mountId)) return;
    if (input === null) {
      if (latest.mounts.includes(sent))
        setSession({ ...latest, uncertain: new Set([...latest.uncertain, sent.mountId]) });
    } else if (input === undefined) setRefresh(n => n + 1);
    else setSession(receiptSnapshot(latest, sent, input));
  }
  const [draft, setDraft] = useState<{ text: string; parentId: string }>();
  const [conflict, setConflict] = useState(false);
  const [refreshingConflict, setRefreshingConflict] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [retryOperation, setRetryOperation] = useState<Operation>();
  const [accountConflict, setAccountConflict] = useState(false);
  const [sendingAnswer, setSendingAnswer] = useState<string>();
  const [problem, setProblem] = useState<{ source: "read" | "write"; message: string }>();
  const [refresh, setRefresh] = useState(0);

  const uncertainKey = JSON.stringify([...(session?.uncertain ?? [])].sort());
  const checkDraftBases = useEffectEvent(async (signal: AbortSignal) => {
    const prior = sessionRef.current;
    if (!prior || prior.id !== sessionId || !permissions) return;
    const ids = new Set(prior.uncertain);
    for (const m of prior.mounts) if (editorDrafts.has(m) && checkedConnection !== connection) ids.add(m.mountId);
    if (prior.status !== "pending") for (const id of permissions.ids) {
      if (!prior.withdrawn.has(id) && !prior.mounts.some(m => m.mountId === id)) ids.add(id);
    }
    for (const batch of mountBatches(ids)) {
      const read = await api<Session>(mountQuery(sessionPath(prior.id), batch), { signal });
      if (signal.aborted) return;
      if (read.id !== prior.id || read.caseId !== caseId || !Array.isArray(read.turns))
        throw new Error("Session identity mismatch");
      const latest = sessionRef.current;
      if (latest?.id === read.id) setSession(refreshDraftBases(latest, prior, batch, readSession(read), permissions.ids));
    }
  });
  useEffect(() => {
    if (!permissions) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        await checkDraftBases(controller.signal);
        if (!controller.signal.aborted) setCheckedConnection(connection);
      } catch {
        if (!controller.signal.aborted)
          setProblem({ source: "read", message: "暂时无法核对作品版本，草稿保留在当前页面。请重试。" });
      }
      if (!controller.signal.aborted && sessionRef.current?.uncertain.size)
        timer = setTimeout(check, 15000);
    }
    void check();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [permissions, connection, uncertainKey, session?.id, refresh]);

  const [streamingReply, setStreamingReply] = useState<string>();
  const [progressLabel, setProgressLabel] = useState<string>();
  const [reconnecting, setReconnecting] = useState(false);

  const readAssessment = useRef<(() => Promise<void>) | undefined>(undefined);
  const queuedSubmissions = JSON.stringify(visibleSession?.mounts.flatMap(m => m.assessment?.state === 'queued'
    ? [[m.turnId, m.mountId, m.assessment.submissionRef.id, m.assessment.submissionRef.rev]] : []) ?? []);

  useEffect(() => {
    if (!active || !sessionId || busy || retryOperation) return;
    const controller = new AbortController();
    const hints = mountBatches(knownIds(sessionId))[0] ?? [];
    const covered = new Set(hints);
    const source = sessionEvents(sessionId, hints);
    let reconnectTimer: ReturnType<typeof setTimeout>;
    const baseline = sessionRef.current?.id === sessionId ? sessionRef.current : undefined;
    let batch: { id: string; turn: string; order?: Map<string, number>; frame: SessionEvent } | undefined;
    const retiredTurns = new Set<string>();
    let terminal = false;
    let didHydrate = Boolean(baseline);
    let readNumber = 0;
    let reading = false;

    function clearReadProblem() {
      setRefreshingConflict(false);
      setInvalidated(false);
      setProblem(previous => previous?.source === "write" ? previous : undefined);
    }

    function invalidate(status: number) {
      if ([401, 403, 404].includes(status)) {
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

    async function hydrate(mode: 'stream' | 'complete' | 'assessment', completed?: SessionEvent["session"]) {
      if (mode === 'assessment' && reading) return;
      reading = true;
      const number = ++readNumber;
      const atRequest = sessionRef.current;
      const requestedBatch = batch;
      try {
        const hints = mountBatches(knownIds(sessionId!))[0] ?? [];
        const current = await api<Session>(mountQuery(sessionPath(sessionId!), hints), { signal: controller.signal });
        if (controller.signal.aborted || number !== readNumber || (mode === 'stream' && terminal)) return;
        const latest = sessionRef.current;
        if (completed && (completed.currentTurnId !== current.currentTurnId || completed.status !== current.status)) {
          invalidate(0);
          return;
        }
        if (current.id !== sessionId || current.caseId !== caseId || !Array.isArray(current.turns) ||
            (latest?.currentTurnId !== current.currentTurnId && latest?.turns.some(t => t.turnId && t.turnId === current.currentTurnId)) ||
            (latest !== atRequest && latest?.currentTurnId !== current.currentTurnId) ||
            (latest?.currentTurnId === current.currentTurnId && latest?.status === "ready" && current.status === "pending")) return;
        // A later stream header owns this turn's complete mount set. Its
        // snapshots follow on the same connection, including after reconnect.
        if (batch?.order && requestedBatch !== batch && current.status === 'pending' && current.currentTurnId === batch.turn)
          delete current.artifacts;
        setSession(readSession(current, latest, atRequest, new Set(hints)));
        clearReadProblem();
        if (mode === 'complete') {
          setStreamingReply(undefined);
          setProgressLabel(undefined);
        }
      } catch (error) {
        if (controller.signal.aborted || number !== readNumber || (mode === 'stream' && terminal)) return;
        const status = error instanceof ApiError ? error.status : 0;
        if (mode === 'complete' || [401, 403, 404, 409].includes(status)) {
          terminal = true;
          source.close();
          invalidate(status);
        }
      } finally {
        if (number === readNumber) reading = false;
      }
    }

    readAssessment.current = () => hydrate('assessment');

    function receive(event: MessageEvent<string>): SessionEvent | undefined {
      let update: SessionEvent;
      try { update = JSON.parse(event.data); } catch { return; }
      if (terminal || controller.signal.aborted || update?.session?.id !== sessionId ||
          update.session.caseId !== caseId || typeof update.session.currentTurnId !== "string" ||
          (update.message !== undefined && typeof update.message !== "string")) return;
      clearReadProblem();
      setReconnecting(false);
      return update;
    }

    source.addEventListener("progress", (event: MessageEvent<string>) => {
      const update = receive(event);
      if (!update || update.session.status !== "pending") return;
      const previous = sessionRef.current;
      const turn = update.session.currentTurnId!;
      if (retiredTurns.has(turn)) return;
      if ((previous?.currentTurnId === update.session.currentTurnId && previous?.status !== "pending") ||
          previous?.turns.some(t => t.turnId === update.session.currentTurnId)) return;
      if (previous?.currentTurnId && previous.currentTurnId !== turn) retiredTurns.add(previous.currentTurnId);
      const ids = update.authorizedMountIds;
      batch = { id: event.lastEventId, turn, frame: update };
      if (ids !== undefined) {
        batch.order = new Map(Array.isArray(ids) && ids.every(id => typeof id === 'string')
          ? ids.map((id, i) => [id, i]) : []);
      }
      for (const id of batch.order?.keys() ?? []) covered.add(id);
      const next = { ...previous, ...update.session };
      if (previous?.currentTurnId !== next.currentTurnId) delete next.currentObject;
      const mounted = { ...next, turns: previous?.turns ?? [], uncertain: previous?.uncertain ?? new Set<string>(), withdrawn: previous?.withdrawn ?? new Set(),
        mounts: previous?.mounts.filter(m => m.turnId === update.session.currentTurnId || previous.turns.some(t => t.turnId === m.turnId)) ?? [] };
      setSession(batch.order ? authorizeMounts(mounted, turn, batch.order, update, covered) : mounted);
      setProgressLabel(update.phase ? progressLabels[update.phase] : undefined);
      setStreamingReply(update.message);
      // Restore prior turns for a remembered session while the current one streams.
      if (!didHydrate) {
        didHydrate = true;
        void hydrate('stream');
      }
    });

    if (refresh) void hydrate('stream');

    source.addEventListener("artifact-snapshot", (event: MessageEvent<string>) => {
      if (controller.signal.aborted || terminal) return;
      let input: unknown;
      try { input = JSON.parse(event.data); } catch { return; }
      if (!batch || event.lastEventId !== batch.id || batch.turn !== sessionRef.current?.currentTurnId) return;
      const latest = sessionRef.current;
      const next = streamSnapshot(latest, input, batch.order);
      if (!next || next === latest) return;
      setSession(batch.order ? authorizeMounts(next, batch.turn, batch.order, batch.frame, covered) : next);
    });

    source.addEventListener("complete", (event: MessageEvent<string>) => {
      const update = receive(event);
      if (!update || retiredTurns.has(update.session.currentTurnId!)) return;
      terminal = true;
      source.close();
      if (!refresh && !sessionRef.current?.mounts.length && baseline?.currentTurnId === update.session.currentTurnId && baseline?.status === update.session.status) {
        setStreamingReply(undefined);
        setProgressLabel(undefined);
        return;
      }
      // Render the accepted public reply immediately, then hydrate the
      // learner's authorized session view once. The stream never carries audit fields.
      setStreamingReply(update.message);
      setProgressLabel(undefined);
      void hydrate('complete', update.session);
    });

    source.addEventListener("session-error", (event: MessageEvent<string>) => {
      if (controller.signal.aborted || terminal) return;
      let status: number;
      try { status = JSON.parse(event.data).status; } catch { return; }
      terminal = true;
      ++readNumber;
      source.close();
      setReconnecting(false);
      invalidate(status);
    });

    source.onerror = () => {
      if (controller.signal.aborted || terminal) return;
      batch = undefined;
      setReconnecting(true);
      if (source.readyState === EventSource.CLOSED) void hydrate('complete');
      else {
        source.close();
        reconnectTimer = setTimeout(() => setRefresh(n => n + 1), 1000);
      }
    };

    return () => {
      source.close();
      controller.abort();
      clearTimeout(reconnectTimer);
      readAssessment.current = undefined;
    };
  }, [active, busy, caseId, refresh, retryOperation, sessionId, sessionKey]);

  // All queued works in this session share one bounded sequence of authorized reads.
  useEffect(() => {
    if (!active || busy || retryOperation || queuedSubmissions === '[]') return;
    const delays = [1000, 2000, 4000, 8000, 15000, 30000];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    function schedule(index: number) {
      if (cancelled || index >= delays.length) return;
      timer = setTimeout(async () => {
        await readAssessment.current?.();
        schedule(index + 1);
      }, delays[index]);
    }
    schedule(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, busy, retryOperation, sessionId, queuedSubmissions]);

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
          body: { allowBackgroundUnderstanding: operation.allowBackgroundUnderstanding, currentObject: operation.currentObject, route: operation.route, mcpGrants: operation.mcpGrants, caseId, requestId: operation.requestId, question: operation.question, attachment: operation.attachment },
        })
        : await api<Session>(`${sessionPath(operation.sessionId)}/answers`, {
          method: "POST",
          body: { allowBackgroundUnderstanding: operation.allowBackgroundUnderstanding, currentObject: operation.currentObject, route: operation.route, mcpGrants: operation.mcpGrants, answer: operation.answer, parentId: operation.parentId, requestId: operation.requestId },
        });
      if (result.caseId !== caseId || (operation.kind === "answer" && result.id !== operation.sessionId)) {
        throw new Error("Session identity mismatch");
      }
      remember(sessionKey, result.id);
      if (operation.kind === "create") remember(createKey, null);
      setSessionId(result.id);
      setSession(readSession(result, sessionRef.current));
      setRefreshingConflict(false);
      setInvalidated(false);
      setDraft(undefined);
      setRetryOperation(undefined);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'provider_account_confirmation_required') {
        setAccountConflict(true);
        setRetryOperation(undefined);
        return;
      }
      if (operation.kind === "answer" && error instanceof ApiError && error.status === 409) {
        setRetryOperation(undefined);
        setConflict(true);
        setRefresh(n => n + 1);
        setRefreshingConflict(true);
        return;
      }
      const rejected = error instanceof ApiError && [400, 401, 403, 404, 409, 413, 415, 422].includes(error.status);
      if (rejected && operation.kind === "create") remember(createKey, null);
      setRetryOperation(rejected ? undefined : operation);
      setProblem({
        source: "write",
        message: operation.currentObject && error instanceof ApiError && error.status === 403 ? "这条记录当前无法用于教学。可解除关联后继续。要使用这条记录，请在「学习设置 → 学习记录访问」检查记录和模型授权，再从记录重新提问。" :
          error instanceof ApiError && error.status === 409 ? "请求与已有记录冲突，请核对后重新发送。" :
          error instanceof ApiError && error.status === 422 ? "这次对话使用原模型端点，请新建对话以使用当前端点。" :
          operation.kind === "create" ? "暂时无法开始对话。" : "暂时无法发送这条作答。",
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
      setSendingAnswer(undefined);
    }
  }

  function start(question?: string, attachment?: StudyAttachment, mcpGrants?: McpGrant[], route?: Route, currentObject?: CurrentObject, allowBackgroundUnderstanding?: boolean) {
    if (inFlight.current || retryOperation) return;
    setAccountConflict(false);
    const text = question?.trim();
    const id = text ? requestId() : remembered(createKey) ?? requestId();
    if (!text) remember(createKey, id);
    void perform({ kind: "create", allowBackgroundUnderstanding, currentObject, route, mcpGrants, requestId: id, ...(text ? { question: text } : {}), ...(attachment ? { attachment } : {}) });
  }

  function send(mcpGrants?: McpGrant[], route?: Route, currentObject?: CurrentObject, allowBackgroundUnderstanding?: boolean) {
    const answer = draft?.text.trim();
    const parentId = session?.currentTurnId;
    if (!session || session.status !== "ready" || !answer || !parentId || draft?.parentId !== parentId || retryOperation || accountConflict) return;
    void perform({ kind: "answer", allowBackgroundUnderstanding, currentObject, route, mcpGrants, requestId: requestId(), sessionId: session.id, parentId, answer });
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
    session: visibleSession,
    mountsConfirmed: Boolean(permissions),
    applySnapshot,
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
    reload: () => setRefresh(n => n + 1),
    accountConflict,
    problem,
    start,
    send,
    retry,
  };
}
