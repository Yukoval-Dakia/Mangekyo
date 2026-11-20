import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, submissionId } from './api';
import { useDraftWatermark } from './draft-watermark';
import { Message } from './message';
import { PageTitle } from './workspace';
import './iqdb.css';

type FixedRef = {id: string; rev: number};
type Question = FixedRef & {title: string; prompt: string; status: keyof typeof statusLabels};
type Need = {need: string; durationMinutes: number; coverage?: string[]; questionRefs?: FixedRef[]};
type Proposal = {
  proposalId: string;
  requestId: string;
  questionRefs: FixedRef[];
  coverage: {target: string; status: 'mentioned' | 'unconfirmed'}[];
  gaps: string[];
  next: 'issue' | 'review_questions';
};
type Intent =
  | {kind: 'proposal'; body: Need & {requestId: string}}
  | {kind: 'paper'; body: {requestId: string} & ({proposalId: string} | {sourceRef: FixedRef})};

const statusLabels = {
  draft: '草稿', needs_verification: '待核验', restricted: '已限制发放', release_ready: '可开练',
};
const pendingKey = 'mangekyo:iqdb-pending';
const refKey = ({id, rev}: FixedRef) => id + ':' + rev;

function pendingIntent(): Intent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null') as Intent | null;
    if (value && typeof value.body?.requestId === 'string' &&
        ((value.kind === 'proposal' && typeof value.body.need === 'string') ||
         (value.kind === 'paper' && ('proposalId' in value.body || 'sourceRef' in value.body)))) return value;
  } catch { /* Use in-memory retries when tab storage is unavailable. */ }
  return null;
}

function persist(intent: Intent | null) {
  try {
    if (intent) sessionStorage.setItem(pendingKey, JSON.stringify(intent));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The mounted form still holds the original request. */ }
}

export function QuestionBank() {
  const watermark = useDraftWatermark();
  const [pending, setPending] = useState(pendingIntent);
  const restored = pending?.kind === 'proposal' ? pending.body : undefined;
  const [need, setNeed] = useState(restored?.need ?? '');
  const [minutes, setMinutes] = useState(String(restored?.durationMinutes ?? 20));
  const [coverage, setCoverage] = useState(restored?.coverage?.join('\n') ?? '');
  const [selected, setSelected] = useState<FixedRef[]>(restored?.questionRefs ?? []);
  const [questions, setQuestions] = useState<Question[]>();
  const [catalogError, setCatalogError] = useState('');
  const [proposal, setProposal] = useState<Proposal>();
  const lastProposalRequest = useRef<Extract<Intent, {kind: 'proposal'}> | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const reading = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setQuestions(undefined);
    setProposal(undefined);
    setCatalogError('');
    try {
      const catalog = await api<{questions: Question[]}>('/iqdb/questions', {signal: controller.signal});
      if (!controller.signal.aborted) setQuestions(catalog.questions);
    } catch {
      if (!controller.signal.aborted) setCatalogError('暂时无法读取获准用于学习的题目。');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const restoredPage = (e: PageTransitionEvent) => { if (e.persisted) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', restoredPage);
    return () => {
      reading.current?.abort();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pageshow', restoredPage);
    };
  }, [refresh]);

  const catalog = new Map(questions?.map(q => [refKey(q), q]));
  const selection = new Set(selected.map(refKey));
  const staleSelection = selected.some(ref => !catalog.has(refKey(ref)));
  const locked = busy || pending !== null || !watermark.ready;
  function rememberIntent(intent: Intent | null) {
    persist(intent);
    setPending(intent);
  }

  async function send(intent: Intent) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    rememberIntent(intent);
    setMessage('');
    const listRead = reading.current;
    try {
      if (intent.kind === 'paper') {
        const receipt = await api<{id: string}>('/iqdb/papers', {method: 'POST', body: intent.body});
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(receipt.id)) throw new Error('未收到试卷标识。');
        rememberIntent(null);
        location.assign('/papers/' + receipt.id);
        return;
      }
      const result = await api<Proposal>('/iqdb/proposals', {method: 'POST', body: intent.body});
      if (!result.proposalId || result.requestId !== intent.body.requestId || !Array.isArray(result.questionRefs))
        throw new Error('未收到完整提案。');
      rememberIntent(null);
      if (listRead === reading.current && !listRead?.signal.aborted) {
        lastProposalRequest.current = intent;
        setProposal(result);
      } else setMessage('题库已刷新，请重新查看组卷建议。');
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        rememberIntent(null);
        setMessage(error.message);
        void refresh();
      } else {
        setMessage('尚未取得回执。可以用原请求重试。');
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function selectQuestion(q: Question, checked: boolean) {
    setProposal(undefined);
    setSelected(previous => checked ? [...previous, {id: q.id, rev: q.rev}] :
      previous.filter(ref => refKey(ref) !== refKey(q)));
  }

  function propose(event: FormEvent) {
    event.preventDefault();
    if (locked || !questions || !need.trim() || staleSelection) return;
    const targets = coverage.split('\n').map(line => line.trim()).filter(Boolean);
    if (targets.length > 20 || targets.some(target => target.length > 120)) {
      setMessage('最多可指定 20 个目标，每个目标限 120 字。');
      return;
    }
    setProposal(undefined);
    void send({kind: 'proposal', body: {
      requestId: submissionId(), need: need.trim(), durationMinutes: Number(minutes),
      ...(targets.length ? {coverage: [...new Set(targets)]} : {}),
      ...(selected.length ? {questionRefs: selected} : {}),
    }});
  }

  return <>
    <PageTitle title="智能题库（IQDB）"><a href="/materials">全部材料</a></PageTitle>
    <section className="study-cards iqdb-compose">
      <h2>一句话组卷</h2>
      {watermark.notice}
      <p>题库会在题名和题面中查找原句或覆盖关键词。也可以勾选指定题版。</p>
      <form onSubmit={propose} onChange={() => setProposal(undefined)}>
        <fieldset disabled={locked}>
          <label className="field">这次想练什么
            <textarea required maxLength={500} value={need} rows={2} placeholder="例如：我想练习比较折线图中两段的变化。"
              onChange={e => setNeed(e.target.value)}/>
          </label>
          <label className="field">可用时间（分钟）
            <input type="number" min={1} max={240} step={1} required value={minutes} onChange={e => setMinutes(e.target.value)}/>
          </label>
          <details><summary>指定覆盖目标</summary>
            <label className="field">每行一个目标<textarea rows={2} value={coverage} onChange={e => setCoverage(e.target.value)}/></label>
          </details>
        </fieldset>
        {questions && staleSelection && <p role="status">已选题目中有版本已变化或当前不可用。
          <button type="button" disabled={locked} onClick={() => {setSelected(selected.filter(ref => catalog.has(refKey(ref)))); setProposal(undefined);}}>移除失效选择</button>
        </p>}
        <button className="primary-button" disabled={locked || !questions || staleSelection}>查看组卷建议</button>
      </form>
      {questions && proposal && <div className="iqdb-proposal">
        <h3>建议试卷</h3>
        <p>计划用时 {minutes} 分钟 · {proposal.questionRefs.length} 题</p>
        <ol>{proposal.questionRefs.map(ref => <li key={refKey(ref)}>{catalog.get(refKey(ref))?.title ?? '当前清单无法核对的题目'} · 第 {ref.rev} 版</li>)}</ol>
        <ProposalDetails proposal={proposal}/>
        <button type="button" className="primary-button" disabled={locked || proposal.next !== 'issue' || !proposal.questionRefs.length ||
          !proposal.questionRefs.every(ref => catalog.get(refKey(ref))?.status === 'release_ready')}
          onClick={() => void send({kind: 'paper', body: {requestId: submissionId(), proposalId: proposal.proposalId}})}>按建议开卷</button>
        <button type="button" className="text-button" disabled={locked} onClick={() => {
          const intent = lastProposalRequest.current;
          if (intent) {
            void refresh();
            void send(intent);
          }
        }}>复查原提案</button>
      </div>}
    </section>
    {message && <p role="status">{message}</p>}
    {pending && <div role="status" className="iqdb-pending">
      {busy ? '正在确认请求…' : <>上次{pending.kind === 'paper' ? '开卷' : '组卷'}请求待确认。
        <button type="button" className="tonal-button" onClick={() => void send(pending)}>重试原请求</button>
      </>}
    </div>}
    <section className="iqdb-list">
      <div className="subhead"><h2>题目</h2>
        <button className="text-button" disabled={busy} onClick={() => void refresh()}>刷新题库</button></div>
      {catalogError ? <p role="alert">{catalogError}</p> : !questions ? <p role="status">正在读取题库…</p> :
        !questions.length ? <p>暂时没有获准用于学习的题目。</p> : <ul className="read-list">
          {questions.map(q => <li key={refKey(q)}>
            <h3>{q.title}</h3>
            <small>第 {q.rev} 版 · {statusLabels[q.status]}</small>
            <details><summary>查看题面</summary><Message text={q.prompt}/></details>
            <div className="study-actions">
              <label><input type="checkbox" disabled={locked || (selected.length >= 20 && !selection.has(refKey(q)))} checked={selection.has(refKey(q))}
                onChange={e => selectQuestion(q, e.target.checked)}/> 用于这份试卷</label>
              {q.status === 'release_ready' && <button type="button" className="tonal-button" disabled={locked}
                onClick={() => void send({kind: 'paper', body: {requestId: submissionId(), sourceRef: {id:q.id, rev:q.rev}}})}>单题开练</button>}
            </div>
          </li>)}
        </ul>}
    </section>
    <div className="study-actions"><a href="/materials/workspace?kind=question">浏览本人保存的题目</a><a href="/papers">打开已保存的试卷</a><a href="/papers/new">手动编卷</a></div>
  </>;
}

const gapLabels: Record<string, string> = {
  duration_unestimated: '当前缺少完成这些题目的用时估计。',
  coverage_unconfirmed: '目标覆盖还需核对。',
  no_matching_question: '没有找到相符题目，可修改覆盖关键词或勾选题目。',
  question_unavailable: '原提案中有题目或版本已不可用。',
  needs_verification: '部分题目仍需独立核验。',
  restricted: '部分题目已限制发放。',
  draft: '部分题目仍是草稿。',
};

function ProposalDetails({proposal}: {proposal: Proposal}) {
  return <>
    {proposal.coverage.length > 0 && <div><h4>覆盖目标</h4>
      <ul>{proposal.coverage.map(item => <li key={item.target}>{item.target} · {item.status === 'mentioned' ? '题名或题面提及' : '尚未确认'}</li>)}</ul>
    </div>}
    {proposal.gaps.length > 0 && <div><h4>缺口</h4>
      <ul>{proposal.gaps.map(gap => <li key={gap}>{gapLabels[gap] ?? gap}</li>)}</ul>
    </div>}
    <p>下一步：{proposal.next === 'issue' ? '可以按建议开卷。' : '请核对题目状态，再复查提案。'}</p>
  </>;
}
