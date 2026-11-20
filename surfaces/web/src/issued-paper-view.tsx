import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {flushSync} from 'react-dom';
import {api, ApiError} from './api';
import {useVisibleDocument} from './workbook-presentation';

type Presentation = {paper: {id: string; rev: number}; items: string[]; permit: string};
export type IssuedPaper = {issuanceId: string; title: string; presentation: Presentation | null;
  pages: {number: number; pieces: {itemId: string | null; text: string}[]}[]};

export function hasPresentation(paper: IssuedPaper) {
  if (!paper?.issuanceId || !Array.isArray(paper.pages) || !paper.pages.length) return false;
  const proof = paper.presentation;
  if (proof === null) return true;
  if (!proof?.paper?.id || !Number.isSafeInteger(proof.paper.rev) || proof.paper.rev < 1 ||
      typeof proof.permit !== 'string' || !proof.permit.trim() || !Array.isArray(proof.items) || !proof.items.length) return false;
  const printed = new Set(paper.pages.flatMap(page => page.pieces.map(piece => piece.itemId)).filter(id => id !== null));
  return printed.size === proof.items.length && new Set(proof.items).size === printed.size &&
    proof.items.every(id => typeof id === 'string' && id.length > 0 && printed.has(id));
}

export function IssuedPaperView({paper, print}: {paper: IssuedPaper; print: boolean}) {
  const visible = useVisibleDocument();
  const sheets = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [printing, setPrinting] = useState(false);
  const confirmed = useRef(false);
  const printed = useRef(false);

  useEffect(() => {
    const prompt = sheets.current?.querySelector<HTMLElement>('[data-prompt]');
    if (!visible || denied || !prompt) return;
    const controller = new AbortController();
    let frame = 0;
    const foreground = () => {
      const rect = prompt.getBoundingClientRect();
      return !controller.signal.aborted && document.visibilityState === 'visible' && prompt.isConnected &&
        rect.height > 0 && rect.width > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };
    async function afterPaint() {
      if (!foreground()) return;
      observer.disconnect();
      try {
        if (paper.presentation && !confirmed.current) {
          const receipt = await api<{recorded: boolean}>('/capture/papers/displayed', {method:'POST', signal:controller.signal,
            body:{issuanceId:paper.issuanceId, permit:paper.presentation.permit}});
          if (receipt?.recorded !== true) throw new Error();
          if (controller.signal.aborted) return;
          confirmed.current = true;
        }
        setError('');
        if (print && !printed.current) {
          await document.fonts.ready;
          if (!foreground()) {
            if (!controller.signal.aborted) observer.observe(prompt!);
            return;
          }
          printed.current = true;
          flushSync(() => setPrinting(true));
          try { window.print(); } finally { setPrinting(false); }
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
          setDenied(true); setError(failure.message);
        } else setError('未收到卷面展示回执。');
      }
    }
    const observer = new IntersectionObserver(entries => {
      cancelAnimationFrame(frame);
      if (entries.some(entry => entry.isIntersecting)) {
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => void afterPaint()); });
      }
    });
    prompt.scrollIntoView({block:'nearest', behavior:'instant'});
    observer.observe(prompt);
    return () => { controller.abort(); observer.disconnect(); cancelAnimationFrame(frame); };
  }, [paper, print, visible, denied, attempt]);

  return <>
    {error && <div className="print-controls" role="alert">{error} {!denied &&
      <button className="tonal-button" onClick={() => {setError(''); setAttempt(n => n+1);}}>重试展示确认</button>}</div>}
    {visible && !denied && <div ref={sheets} className="issued-sheets" data-printing={printing || undefined}>
      {paper.pages.map(sheet => <section key={sheet.number} style={{
        '--rows': Math.max(1, sheet.pieces.length),
        '--columns': Math.max(1, ...sheet.pieces.map(piece => Array.from(piece.text).length)),
      } as CSSProperties}>
        <header><h2>{paper.title}</h2><p>卷号 {paper.issuanceId} · 第 {sheet.number} / {paper.pages.length} 页</p></header>
        {sheet.pieces.map((piece,i) => <div className="issued-line" data-prompt={piece.itemId !== null || undefined}
          key={i}>{piece.text}</div>)}
      </section>)}
    </div>}
  </>;
}
