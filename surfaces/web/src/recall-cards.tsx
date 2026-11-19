import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { requestId } from './api';
import { Icon } from './icons';
import './recall-cards.css';

export type RecallMount = { turnId: string; derivationId: string; itemId: string };
export type RecallItem = RecallMount & { issuanceId: string; responseId: string; prompt: string };
type FactRef = { learner: string; id: string; rev: number };
type Reveal = { token: string; requestId: string; rubric?: string; revealId: string; itemId: string; reference: string };
type Display = { mount: RecallMount; grant: Reveal };
const outcomes = {
  correct: '回答正确', incorrect: '回答有误', partial: '部分正确', pending: '待评定',
  unanswered: '未作答', 'self-check': '待自行核对',
};
const observations = {
  unknown: '提交前是否看过帮助尚未确认', unexposed: '提交前未显示相关帮助', exposed: '提交前已显示相关帮助',
};
export type RecallReceipt = {
  submission: FactRef; itemId: string; responseId: string; result: keyof typeof outcomes;
  exposure: { kind: 'exposed' | 'unexposed'; evidenceRefs: readonly FactRef[] }
    | { kind: 'unknown'; reason: string; evidenceRefs: readonly FactRef[] };
};
type Attempt = { answer: string; receipt: RecallReceipt };
export type RecallTransport = {
  readState(input: { scope: string; mount: RecallMount }): Promise<Attempt | null>;
  requestReveal(input: { mount: RecallMount; requestId: string }): Promise<Reveal>;
  confirmDisplay(input: Display): Promise<{ display: FactRef }>;
  submit(input: { mount: RecallMount; requestId: string; answer: string }): Promise<RecallReceipt>;
};
export type RecallCardsProps = {
  scope: string; items: readonly RecallItem[]; transport: RecallTransport;
  label?: string; title?: string; lesson?: string;
  onDiscuss?: (context: Attempt & { mount: RecallMount; prompt: string }) => void;
};

function Reference({ grant, report }: { grant: Reveal; report: () => Promise<unknown> }) {
  const text = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<'observe' | 'sending' | 'done' | 'failed'>('observe');
  const confirm = useEffectEvent(report);
  useEffect(() => {
    const node = text.current;
    if (!node || status !== 'observe') return;
    let active = true;
    let timer = 0;
    // Observe the text itself. Delivery, a mounted hidden panel, or a scrolled-away
    // answer cannot attest that a learner had the opportunity to see the reference.
    function inspect() {
      if (!active || !node || document.visibilityState !== 'visible') return;
      if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
      const visible = Array.from(node.getClientRects()).some(box => {
        const x = (Math.max(box.left, 0) + Math.min(box.right, innerWidth)) / 2;
        const y = (Math.max(box.top, 0) + Math.min(box.bottom, innerHeight)) / 2;
        return document.elementFromPoint(x, y) === node;
      });
      if (!visible) return;
      active = false;
      setStatus('sending');
      void confirm().then(() => setStatus('done'), () => setStatus('failed'));
    }
    const observer = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry?.isIntersecting) {
        inspect();
        if (active) timer = window.setInterval(inspect, 250);
      }
    });
    observer.observe(node);
    return () => { active = false; observer.disconnect(); clearInterval(timer); };
  }, [status]);
  return <div className="rc-reference"><strong>参考答案</strong><p><span ref={text} tabIndex={-1}>{grant.reference}</span></p>
    {status === 'failed' && <div role="alert">显示记录未确认。<button type="button" className="text-button"
      onClick={() => { text.current?.focus(); setStatus('observe'); }}>重试确认</button></div>}
  </div>;
}

function Question({ item, position, scope, transport, onDiscuss }: Pick<RecallCardsProps, 'scope' | 'transport' | 'onDiscuss'> & {
  item: RecallItem; position: number;
}) {
  const { turnId, derivationId, itemId, responseId } = item;
  const mount = useMemo(() => ({ turnId, derivationId, itemId }), [turnId, derivationId, itemId]);
  const field = useRef<HTMLTextAreaElement>(null);
  const promptHeading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const [answer, setAnswer] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [loading, setLoading] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [readVersion, setReadVersion] = useState(0);
  const [busy, setBusy] = useState<'submit' | 'reveal' | null>(null);
  const [problem, setProblem] = useState('');
  const [grant, setGrant] = useState<Reveal | null>(null);
  const submitIntent = useRef<{ requestId: string; answer: string } | null>(null);
  const pendingDisplay = useRef<Promise<unknown> | null>(null);
  const revealIntent = useRef<string | null>(null);
  const read = useEffectEvent(() => transport.readState({ scope, mount }));
  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const last = await read();
        if (!active) return;
        if (last && (last.receipt.itemId !== itemId || last.receipt.responseId !== responseId)) throw Error();
        setAttempt(last);
        setAnswer(last?.answer ?? '');
        setLoading('ready');
      } catch { if (active) setLoading('failed'); }
    }
    void restore();
    return () => { active = false; };
  }, [itemId, responseId, readVersion]);

  async function submit() {
    if (busy || !answer.trim() || loading !== 'ready' || attempt) return;
    setBusy('submit');
    setProblem('');
    if (submitIntent.current?.answer !== answer) submitIntent.current = { answer, requestId: requestId() };
    try {
      // Preserve the order of a visible reference and a subsequent click even on a slow connection.
      await pendingDisplay.current;
      const receipt = await transport.submit({ mount, ...submitIntent.current });
      if (receipt.itemId !== itemId || receipt.responseId !== responseId) throw Error();
      setAttempt({ receipt, answer });
      submitIntent.current = null;
    } catch { setProblem('交答结果未确认。保留原回答，再次提交即可重试。'); }
    finally { setBusy(null); }
  }

  async function reveal() {
    if (busy || loading !== 'ready') return;
    if (grant) { setGrant(null); revealIntent.current = null; return; }
    setBusy('reveal');
    setProblem('');
    revealIntent.current ??= requestId();
    try {
      const next = await transport.requestReveal({ mount, requestId: revealIntent.current });
      if (next.itemId !== itemId || !next.reference.trim()) throw Error();
      setGrant(next);
    } catch { setProblem('暂时无法揭晓参考答案，可以再次揭晓。'); }
    finally { setBusy(null); }
  }

  function again() {
    setAttempt(null); setAnswer(''); setGrant(null); setProblem('');
    revealIntent.current = null;
    field.current?.focus();
  }
  return <article className="rc-item" aria-labelledby={id + '-prompt'}>
    <header className="rc-question"><span className="rc-position">第 {position} 题</span>
      <h4 ref={promptHeading} tabIndex={-1} id={id + '-prompt'}>{item.prompt}</h4></header>
    <div className="rc-body">
      {loading === 'failed' ? <div role="alert">无法读取交答记录。<button type="button" className="text-button"
        onClick={() => { promptHeading.current?.focus(); setLoading('loading'); setReadVersion(v => v + 1); }}>重新读取</button></div>
      : loading === 'loading' ? <p role="status">正在读取作答记录…</p> : <>
        <label htmlFor={id} className="rc-caption">{attempt ? '已提交的回答' : '你的回答'}</label>
        <textarea ref={field} id={id} aria-describedby={id + '-prompt'} rows={2} maxLength={4000}
          value={answer} readOnly={!!attempt || busy === 'submit'} onChange={e => setAnswer(e.target.value)} />
        {attempt && <div role="status" className="rc-receipt"><strong>{outcomes[attempt.receipt.result]}</strong>
          <span>{observations[attempt.receipt.exposure.kind]}</span></div>}
        <div className="rc-actions">
          <button type="button" className={attempt ? 'tonal-button' : 'primary-button'}
            aria-disabled={!!busy || (!attempt && !answer.trim())}
            onClick={() => { if (!busy) { if (attempt) again(); else void submit(); } }}>
            {attempt ? '再次作答' : busy === 'submit' ? '提交中…' : '正式交答'}</button>
          <button type="button" className="text-button" aria-expanded={!!grant} aria-controls={id + '-reference'}
            aria-disabled={!!busy} onClick={() => void reveal()}>{grant ? '收起参考答案' : busy === 'reveal' ? '正在揭晓…' : '揭晓参考答案'}</button>
          {attempt && onDiscuss && <button type="button" className="text-button"
            onClick={() => onDiscuss({ mount, prompt: item.prompt, ...attempt })}><Icon name="chat" />带着这次提交追问</button>}
        </div>
        {problem && <p role="alert">{problem}</p>}
        <div id={id + '-reference'} hidden={!grant}>{grant && <Reference key={grant.revealId} grant={grant}
          report={() => {
            const confirmation = transport.confirmDisplay({ mount, grant });
            pendingDisplay.current = confirmation.catch(() => undefined);
            return confirmation;
          }} />}</div>
      </>}
    </div>
  </article>;
}

export function RecallCards({ items, title, label, lesson, ...host }: RecallCardsProps) {
  return <section className="rc-deck" aria-label={label ?? title ?? '回忆练习'}>
    {title && <h3>{title}</h3>}
    {lesson && <details className="rc-lesson"><summary>本轮讲义</summary><p>{lesson}</p></details>}
    {items.map((item, i) => <Question key={JSON.stringify([host.scope, item.turnId, item.derivationId, item.itemId, item.issuanceId, item.responseId])}
      item={item} position={i + 1} {...host} />)}
  </section>;
}
