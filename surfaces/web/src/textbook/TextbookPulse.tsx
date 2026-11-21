import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { submissionId } from '../api';
import { PaperDetail } from '../workbook';
import { useVisibleDocument } from '../workbook-presentation';
import { pulseLabels as labels, type PulseConcept, type PulseRows, type PulseReader } from './pulse-projection';
import './pulse.css';

type Selection = {blockId: string; conceptId: string};

const Pulse = createContext<{
  rows: PulseRows;
  requestFor: (key: string) => string;
  selected: Selection | null;
  toggle: (value: Selection | null) => void;
  openPaper: (id: string) => void;
} | null>(null);

export function TextbookPulse({initial, read, children}: {initial: PulseRows; read: PulseReader; children: ReactNode}) {
  const visible = useVisibleDocument();
  const [rows, setRows] = useState(initial);
  const [selected, select] = useState<Selection | null>(null);
  const [paper, setPaper] = useState<string>();
  const [refresh, reload] = useState(0);
  const leftPage = useRef(false);
  const intents = useRef(new Map<string,string>());
  useLayoutEffect(() => {
    function refreshPage() { select(null); setPaper(undefined); reload(n => n + 1); }
    window.addEventListener('focus', refreshPage);
    window.addEventListener('pageshow', refreshPage);
    return () => {
      window.removeEventListener('focus', refreshPage);
      window.removeEventListener('pageshow', refreshPage);
    };
  }, []);
  useLayoutEffect(() => {
    if (!visible) {
      leftPage.current = true;
      setRows(new Map()); select(null); setPaper(undefined);
      return;
    }
    if (refresh === 0 && !leftPage.current) return;
    const controller = new AbortController();
    setRows(new Map());
    void read(controller.signal).then(result => {
      if (!controller.signal.aborted) setRows(result);
    }).catch(() => {});
    return () => controller.abort();
  }, [visible, refresh, read]);

  function toggle(value: Selection | null) {
    select(value);
    if (value) reload(n => n + 1);
  }
  function close() {
    setPaper(undefined);
    select(null);
    if (selected) document.getElementById('tb-' + selected.blockId)?.focus({preventScroll:true});
    reload(n => n + 1);
  }
  return <Pulse.Provider value={{rows, selected, toggle, openPaper: setPaper, requestFor(key) {
    const id = intents.current.get(key) ?? submissionId();
    intents.current.set(key, id);
    return id;
  }}}>
    {children}
    {paper && visible && <PulsePaper id={paper} close={close} />}
  </Pulse.Provider>;
}

function PulsePaper({id, close}: {id: string; close: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="reading-panel tb-pulse-paper" aria-label="原地测一题" onClose={close}>
    <header><h2>原地测一题</h2><button autoFocus onClick={() => dialog.current?.close()}>返回教材块</button></header>
    <section><PaperDetail key={id} paperId={id} singleQuestionOnly /></section>
  </dialog>, document.body);
}

export function BlockPulseMarks({blockId}: {blockId: string}) {
  const pulse = useContext(Pulse);
  const concepts = pulse?.rows.get(blockId);
  if (!pulse || !concepts?.length) return null;
  return <div className="tb-pulse-marks">{concepts.map(row => {
    const open = pulse.selected?.blockId === blockId && pulse.selected.conceptId === row.conceptId;
    return <div key={row.conceptId} className="tb-pulse-mark">
      <button type="button" aria-expanded={open} aria-label={row.conceptId + ' · ' + labels[row.state]}
        onClick={() => pulse.toggle(open ? null : {blockId, conceptId: row.conceptId})}>
        <span {...{elementtiming:'textbook-mastery-pulse'}}>{labels[row.state]}</span>
      </button>
      {open && <div className="tb-pulse-popup" onKeyDown={e => {
        if (e.key === 'Escape') { pulse.toggle(null); document.getElementById('tb-' + blockId)?.focus(); }
      }}>
        {row.history ? <a href={row.history.href}>{row.history.kind === 'recent-error' ? '回看最近错题' : '回看旧稳题'}</a>
          : <small>暂无可重开的旧题</small>}
        {row.candidate ? <Claim key={row.candidate.key} candidate={row.candidate} requestFor={pulse.requestFor} open={pulse.openPaper} />
          : <small>暂无可领取的两分钟题</small>}
      </div>}
    </div>;
  })}</div>;
}

function Claim({candidate, open, requestFor}: {candidate: NonNullable<PulseConcept['candidate']>; open: (id: string) => void; requestFor: (key: string) => string}) {
  const pending = useRef(false);
  const live = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function claim() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const paper = await candidate.issue(requestFor(candidate.key));
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(paper.id)) throw new Error();
      if (live.current) open(paper.id);
    } catch {
      if (live.current) setError(true);
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  return <><button type="button" disabled={busy} onClick={claim}>原地测 1 题（≤2分钟）</button>
    {error && <small role="status">领取未确认，请重试。</small>}</>;
}
