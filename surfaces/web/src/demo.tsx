import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ApiError, api, remember, remembered, sessionPath, type Session, type Settings, type TeachingCase, type Turn } from "./api";
import { useConversation } from "./conversation";
import { RelationReceipt } from "./relation-receipt";
import { PageWriteReceipt } from "./textbook/PageWriteReceipt";
import { Message } from "./message";
import { StudyCards } from "./study-tools";
import { Icon, Mark } from "./icons";

import { TurnArtifacts, type ApplySnapshot } from "./presentation/TurnArtifact";
import type { ArtifactSnapshotV1 } from "./presentation/session-artifacts";

const actionNames: Record<Turn["action"], string> = {
  companion_reply: "学习同伴",
  diagnostic_question: "诊断追问",
  transfer_question: "迁移练习",
  targeted_explanation: "针对性讲解",
  clarifying_question: "澄清问题",
};

function CyclingLegs({ question }: { question: string }) {
  const legs = Array.from(question.matchAll(/每小时\s*(\d+(?:\.\d+)?)\s*公里的速度骑了\s*(\d+(?:\.\d+)?)\s*小时/g));
  if (legs.length !== 2) return null;
  const speeds = legs.map((leg) => Number(leg[1]));
  const scale = Math.max(...speeds);
  if (scale <= 0) return null;

  return (
    <figure className="journey" aria-label="题目给出的两段骑行条件">
      <figcaption><span>两段骑行</span><span>速度 / 公里每小时</span></figcaption>
      <div className="legs">
        {legs.map((leg, index) => (
          <div className="leg" key={index}>
            <span className="leg-number">{index === 0 ? "第一段" : "第二段"}</span>
            <span className="leg-speed">{leg[1]}<span> km/h</span></span>
            <span className="rate-track" aria-hidden="true"><span style={{ width: `${Number(leg[1]) / scale * 100}%` }} /></span>
            <span className="leg-time">用时 {leg[2]} 小时</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

function Question({ teachingCase }: { teachingCase: TeachingCase }) {
  const pivot = teachingCase.question.lastIndexOf("。");
  const canSplit = pivot > 0 && pivot < teachingCase.question.length - 1;
  return (
    <section className="question-panel" aria-label="骑行题面">
      <div className="question-label"><Icon name="document" /> 题面</div>
      <h2>{canSplit ? teachingCase.question.slice(pivot + 1) : teachingCase.question}</h2>
      {canSplit && <p className="question-text">{teachingCase.question.slice(0, pivot + 1)}</p>}
      <CyclingLegs question={teachingCase.question} />
      <p className="initial-answer"><span>两份学习史的本次作答</span><strong>{teachingCase.initialAnswer}</strong></p>
    </section>
  );
}

function WorkspaceWrite({item}: {item: NonNullable<Turn['writes']>[number]}) {
  const [action, setAction] = useState<'idle' | 'pending' | 'withdrawn' | 'changed' | 'missing'>('idle');
  const [problem, setProblem] = useState('');
  const saved = item.memory ?? item.observation;
  const label = item.memory ? '记忆' : '观察';
  if (!saved) return <li><a href={'/materials/records/' + item.id}>{item.title}</a> · 第 {item.rev} 版</li>;
  if (saved.status === 'withdrawn' || action === 'withdrawn')
    return <li role="status">{label}已撤回</li>;
  if (saved.status === 'changed' || action === 'changed' || action === 'missing')
    return <li role="status">{action === 'missing' ? '撤回凭据已失效。' : label + '已变更，无法撤回原版本。'}</li>;
  const token = saved.undo_token;
  async function withdraw() {
    setAction('pending');
    setProblem('');
    try {
      const receipt = await api<{status: string; ref: {id: string; rev: number}}>(
        (item.memory ? '/memory/claims/' : '/workspace/observations/') + item.id + '/undo', {method: 'POST', body: {undo_token: token}});
      if (receipt.status !== 'withdrawn' || receipt.ref.id !== item.id || receipt.ref.rev !== item.rev + 1)
        throw new Error('unexpected receipt');
      setAction('withdrawn');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setAction('changed');
      else if (error instanceof ApiError && error.status === 404) setAction('missing');
      else {
        setAction('idle');
        setProblem('暂时无法确认撤回结果，可以再试一次。');
      }
    }
  }
  return <li className="saved-observation">
    {item.memory ? <strong>{item.title}</strong> : <>
      <small>学情观察 · 同伴推断</small>
      <strong><a href={'/materials/records/' + item.id}>{item.title}</a></strong>
      {'text' in saved && <p>{saved.text}</p>}
    </>}
    <button className="tonal-button" disabled={action === 'pending'} onClick={withdraw}>
      {action === 'pending' ? '正在撤回…' : '撤回' + label}
    </button>
    {problem && <span role="alert">{problem}</span>}
  </li>;
}

function TurnResearchConsent({turnId, grant, reload}: {
  turnId: string; grant: NonNullable<Turn['backgroundUnderstanding']>; reload: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [withdrawnRev, setWithdrawnRev] = useState<number>();
  async function revoke() {
    if (pending) return;
    setPending(true);
    setNotice('');
    try {
      await api('/memory/claims/sources/' + encodeURIComponent(turnId) + '/revoke', {
        method: 'POST', body: {expectedRev: grant.rev, purpose: 'background-research'},
      });
      setWithdrawnRev(grant.rev);
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 409
        ? '这条消息的授权已变化，正在重新读取。' : '暂时无法确认撤回结果，请重试。');
    } finally {
      reload();
      setPending(false);
    }
  }
  return <div>
    {grant.allowed && withdrawnRev !== grant.rev
      ? <button type="button" className="text-button" disabled={pending} onClick={revoke}>
        {pending ? '正在撤回…' : '撤回本条消息的后台整理授权'}
      </button> : <small>本条消息未开放后台整理</small>}
    {notice && grant.allowed && <p role="status">{notice}</p>}
  </div>;
}

export function TeachingTurn({ turn, answer = turn?.answer, message = turn?.message, progress, mounts, applySnapshot, sessionId, materialId, discuss, reload }: {
  reload?: () => void;
  turn?: Turn | undefined;
  answer?: string | undefined;
  message?: string | undefined;
  progress?: string | undefined;
  mounts?: ArtifactSnapshotV1[] | undefined;
  applySnapshot?: ApplySnapshot;
  sessionId?: string | undefined;
  materialId?: string | undefined;
  discuss?: ((question: string, answer: string) => void) | undefined;
}) {
  const item = useRef<HTMLLIElement>(null);
  const complete = Boolean(turn);
  useLayoutEffect(() => {
    const focus = document.activeElement;
    if (complete && focus instanceof HTMLElement && item.current?.contains(focus)) {
      focus.scrollIntoView({ block: 'nearest' });
    }
  }, [complete]);
  const rationale = turn?.reads.reduce((text, read) => text.replaceAll(read.id, read.title), turn.rationale);
  return (
    <li className="turn" ref={item}>
      {answer && <div className="learner-message"><span>{!turn || turn.action === "companion_reply" ? "你" : "你的作答"}</span><p>{answer}</p></div>}
      <article className="companion-turn">
        {turn ? <header className="turn-heading"><Mark /><span>{actionNames[turn.action]}</span></header>
          : <span className="live-status" role="status"><i />{progress}</span>}
        {message && <Message text={message} />}
        {applySnapshot && mounts && <TurnArtifacts mounts={mounts} apply={applySnapshot} live={!turn} />}
        {turn && <>
        {!!turn.writes?.length && <ul className="read-list" aria-label="学习工作区回执">{turn.writes.map(item =>
          item.relation ? <RelationReceipt key={'relation:' + (item.relation.status === 'proposed' ? item.relation.proposalId : item.id + ':' + item.rev)}
            id={item.id} rev={item.rev} relation={item.relation} /> : item.page ? <PageWriteReceipt key={item.page.status === 'proposed' ? item.page.proposalId : item.id + ':' + item.rev}
            id={item.id} rev={item.rev} title={item.title} page={item.page} /> :
            <WorkspaceWrite key={item.id + ':' + item.rev} item={item} />
        )}</ul>}

          {reload && turn.turnId && turn.backgroundUnderstanding &&
            <TurnResearchConsent turnId={turn.turnId} grant={turn.backgroundUnderstanding} reload={reload} />}
          {turn.recall && sessionId && <StudyCards kit={turn.recall} sessionId={sessionId} materialId={materialId} discuss={discuss} />}
          <details className="evidence">
            <summary><Icon name="history" /><span>{turn.action === "companion_reply" ? "本轮信息" : "教研依据"}</span><Icon name="chevron" /></summary>
            <div className="evidence-content">
              {rationale && <p>{rationale}</p>}
              {turn.trace && turn.trace.length > 0 && <ol aria-label="本轮工具记录">{turn.trace.map((step, index) => <li key={index}>{step}</li>)}</ol>}
              {turn.reads.length > 0 && <ul className="read-list">{turn.reads.map((read) => (
                <li key={read.id}>
                  <div className="read-heading"><strong>{read.title}</strong>{turn.evidenceIds.includes(read.id) && <span>本轮引用</span>}</div>
                  <p>{read.text}</p>
                </li>
              ))}</ul>}
              {(turn.model || turn.reportedModel) && <div className="model-info">
                {turn.model && <small>配置路由 · {turn.model}</small>}
                {turn.reasoningEffort && <small>请求思考强度 · {turn.reasoningEffort}</small>}
                <small>返回模型 · {turn.reportedModel ?? "服务未报告"}</small>
              </div>}
            </div>
          </details>
        </>}
      </article>
    </li>
  );
}

function Conversation({ teachingCase, active, settings, needsSetup, openSettings, initialSession }: {
  teachingCase: TeachingCase;
  active: boolean;
  settings: Settings | undefined;
  needsSetup: boolean;
  openSettings: (event: MouseEvent<HTMLButtonElement>) => void;
  initialSession?: Session | undefined;
}) {
  const conversation = useConversation(teachingCase.id, active, initialSession);
  const { busy, draft, problem, retryOperation, session, sessionId, conflict, refreshingConflict, invalidated, outdatedDraft } = conversation;
  const status = session?.status;
  const turns = session?.turns ?? [];
  const waiting = busy || status === "pending" || Boolean(sessionId && !session && !problem);
  const canReply = status === "ready" && Boolean(session?.currentTurnId) && !busy && !refreshingConflict && !retryOperation && (!problem || problem?.source === "write");
  const pendingAnswer = conversation.sendingAnswer ?? session?.pendingAnswer;
  const feed = useRef<HTMLDivElement>(null);
  const previousTurnCount = useRef(0);

  useEffect(() => {
    if (!active) return;
    const url = new URL(location.href);
    if (sessionId) url.searchParams.set("session", sessionId);
    else url.searchParams.delete("session");
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }, [active, sessionId]);

  useEffect(() => {
    if (active && (pendingAnswer || conflict || problem || turns.length > previousTurnCount.current) && feed.current) {
      feed.current.scrollTop = feed.current.scrollHeight;
    }
    previousTurnCount.current = turns.length;
  }, [active, conflict, pendingAnswer, problem, turns.length]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (settings && canReply && !outdatedDraft && !conflict) conversation.send(undefined, settings);
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="workspace" hidden={!active}>
      <Question teachingCase={teachingCase} />
      <section className="conversation-panel" aria-label="教研同伴">
        <header className="conversation-header">
          <div className="companion-title">
            <Mark />
            <div><h2>教研同伴</h2><p>{teachingCase.title}</p></div>
          </div>
          {(session || invalidated) && <button type="button" className="tonal-button" disabled={!settings || waiting || Boolean(retryOperation)} onClick={() => conversation.start(undefined, undefined, undefined, settings)}><Icon name="plus" /> 新对话</button>}
        </header>
        <div className="feed" ref={feed} role="region" aria-label="对话记录" tabIndex={0}>
          {turns.length > 0 && <ol className="turns">{turns.map((turn, index) => <TeachingTurn turn={turn} sessionId={session?.id} key={turn.turnId ?? index} mounts={session?.mounts.filter(m => m.turnId === turn.turnId)} applySnapshot={conversation.applySnapshot} />)}</ol>}
          {pendingAnswer && <div className="learner-message pending-answer"><span>你的作答</span><p>{pendingAnswer}</p></div>}
          {!sessionId && !waiting && !problem && (
            <div className="start-state">
              <div className="start-note">
                <h3>开始本次教研</h3>
                <p>{needsSetup ? "连接模型后，同伴会先查看这份学习历史，再提出下一步。" : "同伴会先查看这份学习历史，再提出下一步。每轮都可以展开查看依据。"}</p>
              </div>
              {needsSetup
                ? <button type="button" className="primary-button start-button" onClick={openSettings}>配置模型 <Icon name="arrow" /></button>
                : <button type="button" className="primary-button start-button" disabled={!settings} onClick={() => conversation.start(undefined, undefined, undefined, settings)}>开始对话 <Icon name="arrow" /></button>}
            </div>
          )}
          {problem && (
            <div className="notice problem" role="alert">
              <p>{problem.message}</p>
              {needsSetup && problem?.source === "write" && <button type="button" className="text-button" onClick={openSettings}>模型设置</button>}
              {!invalidated && <button type="button" className="text-button" onClick={conversation.retry}>{retryOperation ? "重试提交" : "重试"}</button>}
            </div>
          )}
          {!problem && (conflict || outdatedDraft) && (
            <div className="notice problem" role="alert">
              <p>{conflict ? "本轮状态已变更。请查看更新后的对话，再确认草稿是否仍适用。" : "草稿对应上一道追问，请查看当前问题并修改草稿。"}</p>
              {canReply && <button type="button" className="text-button" onClick={() => conversation.editDraft(draft)}>将草稿用于当前问题</button>}
            </div>
          )}
          {!problem && (status === "failed" || status === "unknown") && !busy && (
            <div className="notice problem" role="alert">
              <p>{session?.error || (status === "unknown" ? "无法确认模型是否已完成本轮。可以重新查询对话状态。" : "模型未能完成本轮。请检查模型设置，或新建对话。")}</p>
              <button type="button" className="text-button" onClick={status === "unknown" ? conversation.retry : openSettings}>{status === "unknown" ? "查询状态" : "模型设置"}</button>
            </div>
          )}
          <div role="status" className={waiting && !problem ? "notice waiting" : "visually-hidden"}>
            {waiting && !problem ? <><span className="waiting-dot" /> {conversation.reconnecting ? "正在重连…" : conversation.progressLabel || "正在准备同伴回复…"} </> : turns.length > 0 ? `已收到第 ${turns.length} 轮教研回复。` : ""}
          </div>
        </div>
        <form className="composer" onSubmit={submit}>
          <label className="visually-hidden" htmlFor={`answer-${teachingCase.id}`}>用自己的话写下答案和想法</label>
          <textarea
            id={`answer-${teachingCase.id}`}
            placeholder={canReply ? "写下你的答案和思路…" : "同伴发问后可以在这里作答"}
            value={draft}
            onChange={(event) => conversation.editDraft(event.target.value)}
            onKeyDown={handleComposerKey}
            disabled={!canReply}
            rows={2}
            maxLength={4000}
          />
          <div className="composer-actions">
            <span>Ctrl / ⌘ + Enter 发送</span>
            <button type="submit" className="primary-button" disabled={!draft.trim() || !canReply || outdatedDraft || conflict}>发送 <Icon name="send" /></button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function DemoClassroom({ settings, needsSetup, openSettings }: {
  settings: Settings | undefined; needsSetup: boolean; openSettings: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [linkedId, setLinkedId] = useState(() => new URLSearchParams(location.search).get("session"));
  const [linkedSession, setLinkedSession] = useState<Session>();
  const [linkProblem, setLinkProblem] = useState(false);
  const [cases, setCases] = useState<TeachingCase[]>([]);
  const [selectedId, setSelectedId] = useState(() => remembered("case"));
  const [caseLoadProblem, setCaseLoadProblem] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<{ cases: TeachingCase[] }>("/cases", { signal: controller.signal }).then((result) => {
      setCases(result.cases);
    }).catch(() => {
      if (!controller.signal.aborted) setCaseLoadProblem(true);
    });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!linkedId) return;
    const controller = new AbortController();
    api<Session>(sessionPath(linkedId), { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.id !== linkedId) { setLinkProblem(true); return; }
      remember(`session:${result.caseId}`, result.id);
      selectCase(result.caseId);
      setLinkedSession(result);
    }).catch(() => {
      if (!controller.signal.aborted) setLinkProblem(true);
    });
    return () => controller.abort();
  }, [linkedId]);

  const selected = cases.find((teachingCase) => teachingCase.id === selectedId) ?? cases[0];

  function selectCase(id: string) {
    remember("case", id);
    setSelectedId(id);
  }

  return <div className="demo-classroom">
    <div className="section-heading"><div><a className="back-link" href="/materials">材料 / 示例课堂</a><h1>同一个 45，两份学习史</h1><p>切换两份合成的旧作，观察同伴读了什么，以及它为什么追问。</p></div></div>
        {linkedId && (!linkedSession || (!selected && cases.length === 0) || (cases.length > 0 && !cases.some((item) => item.id === linkedSession.caseId))) ? (
          <div className="case-loading" role="status">
            {linkProblem || caseLoadProblem || (linkedSession && cases.length > 0)
              ? <>无法打开这次对话。<button type="button" className="text-button" onClick={() => { setLinkedId(null); setLinkProblem(false); }}>返回教研室</button></>
              : "正在打开对话…"}
          </div>
        ) : selected ? (
          <>
            <fieldset className="history">
              <legend>学习历史</legend>
              <div className="history-options">
                {cases.map((teachingCase) => (
                  <label className="history-option" key={teachingCase.id}>
                    <input type="radio" name="teaching-history" checked={selected.id === teachingCase.id} onChange={() => selectCase(teachingCase.id)} />
                    <span className="history-radio" aria-hidden="true" />
                    <span className="history-copy"><strong>{teachingCase.title}</strong><span>{teachingCase.description}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            {cases.map((teachingCase) => <Conversation key={teachingCase.id} teachingCase={teachingCase} active={teachingCase.id === selected.id} initialSession={linkedSession?.caseId === teachingCase.id ? linkedSession : undefined} settings={settings} needsSetup={needsSetup} openSettings={openSettings} />)}
          </>
        ) : (
          <div className="case-loading" role={caseLoadProblem ? "alert" : "status"}>
            {caseLoadProblem
              ? <>无法读取学习历史。<button type="button" className="text-button" onClick={() => { setCaseLoadProblem(false); setReload((attempt) => attempt + 1); }}>重试</button></>
              : "正在读取学习历史…"}
          </div>
        )}
  </div>;
}
