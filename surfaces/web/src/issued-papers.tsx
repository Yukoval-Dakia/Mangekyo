import {useEffect, useEffectEvent, useRef, useState} from 'react';
import {IssuedPaperView, hasPresentation, type IssuedPaper} from './issued-paper-view';
import {api, ApiError, remember, remembered} from './api';
import {PageTitle, ReadState, useResource} from './workspace';
import {latestKey} from './deletion-watermark';
import {PaperReturnUpload} from './issued-papers-upload';
import './issued-papers.css';

type Source = {id: string; rev: number};
type Candidate = {kind: string; title: string; source: Source; epoch: string;
  extraction?: {derivationId: string; sourceRev: number; modelMethod: string}};
type Catalog = {
  sources: Candidate[];
  returns: {title: string; source: Source; originals: {index: number; name: string}[]}[];
  issued: {issuanceId: string; title: string; pageCount: number}[];
};
type Collection = {issuanceId: string; runId: string; rev: number; page: number; independence: 'unknown'};
const path = '/capture/papers';
const candidateKey = ({source, epoch, extraction}: Candidate) => JSON.stringify([source, epoch, extraction]);

export default function IssuedPapers({embedded = false}: {embedded?: boolean}) {
  const catalog = useResource<Catalog>(path);
  const [sourceKey, setSourceKey] = useState('');
  const [id, setId] = useState('');
  const [originalKey, setOriginalKey] = useState('');
  const [page, setPage] = useState('');
  const [runId, setRunId] = useState('');
  const [view, setView] = useState<{paper: IssuedPaper; print: boolean}>();
  const generation = useRef(0);
  const [receipt, setReceipt] = useState<Collection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refreshAfterDeletion = useEffectEvent(() => {
    generation.current++; setView(undefined); setOriginalKey(''); setReceipt(undefined); catalog.reload();
  });
  useEffect(() => {
    const refresh = () => refreshAfterDeletion();
    const onStorage = (event: StorageEvent) => { if (event.key === latestKey) refresh(); };
    window.addEventListener(latestKey, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(latestKey, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const data = catalog.error ? undefined : catalog.data;
  const candidate = data?.sources.find(item => candidateKey(item) === sourceKey);
  const issued = data?.issued.find(item => item.issuanceId === id);
  const originals = data?.returns.flatMap(item => item.originals.map(original => ({
    key: JSON.stringify([item.source.id, item.source.rev, original.index]),
    label: item.title + ' · 图 ' + (original.index + 1) + ' · ' + original.name + ' · ' + item.source.id.slice(-6),
    source: item.source, original: original.index,
  }))) ?? [];
  const selected = originals.find(item => item.key === originalKey);
  function selectPaper(next: string) {
    setId(next); setPage(''); setOriginalKey(''); setRunId(remembered('paper-run:'+next) ?? ''); setReceipt(undefined);
    setView(undefined); setError('');
  }
  async function execute(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await operation(); }
    catch (e) {
      setView(undefined); setReceipt(undefined);
      setError(e instanceof ApiError ? e.message : '未收到回执，请重新确认。');
      catalog.reload();
    } finally { setBusy(false); }
  }
  async function issue() {
    if (!candidate) return;
    const {source, epoch, extraction} = candidate;
    const opening = ++generation.current;
    setView(undefined);
    const result = await api<IssuedPaper>(path + '/issue', {method:'POST', body:{
      source, epoch, layout:{lines:32, columns:56}, ...(extraction ? {extraction} : {}),
    }});
    if (opening !== generation.current) return;
    if (!hasPresentation(result)) {setError('缺少有效的卷面展示许可。'); catalog.reload(); return;}
    selectPaper(result.issuanceId); setView({paper:result, print:false}); catalog.reload();
  }
  async function reprint(print: boolean) {
    if (!issued) return;
    const opening = ++generation.current;
    setView(undefined);
    const result = await api<IssuedPaper>(path + '/reprint', {method:'POST', body:{issuanceId:id}});
    if (opening !== generation.current) return;
    if (result?.issuanceId !== id || !hasPresentation(result)) {setError('缺少有效的卷面展示许可。'); return;}
    setView({paper:result, print});
  }
  async function collect() {
    if (!issued || !selected || !page) return;
    setReceipt(await api<Collection>(path + '/collect', {method:'POST', body:{
      issuanceId:id, source:selected.source, original:selected.original, page:Number(page), ...(runId ? {retryId:runId} : {}),
    }}));
  }
  return <div className={embedded ? "issued-papers issued-papers--embedded" : "issued-papers"}>
    <div className="print-controls">
      {!embedded && <>
        <a className="back-link" href="/papers">‹ 返回试卷</a>
        <PageTitle title="纸面试卷"/>
      </>}
      <ReadState resource={catalog}/>
      {error && <p role="alert">{error}</p>}
      {data && <section className="issued-panel">
        <div className="issued-panel-heading">
          <h2>{embedded ? '纸面发行' : '发行纸卷'}</h2>
          <p>把获准材料发成可打印的干净纸卷，写完后拍回回收。</p>
        </div>
        {data.sources.length ? <div className="issued-actions">
          <label className="field issued-field">卷面来源<select value={sourceKey} onChange={e => setSourceKey(e.target.value)}>
            <option value="">选择可发行来源</option>
            {data.sources.map(item => <option key={candidateKey(item)} value={candidateKey(item)}>{item.title} · 第 {item.source.rev} 版</option>)}
          </select></label>
          <button className="primary-button" disabled={!candidate || busy} onClick={() => void execute(issue)}>发行纸卷</button>
        </div> : <p className="issued-empty">当前没有获准发行的来源。</p>}
      </section>}
      {data && <section className="issued-panel">
        <div className="issued-panel-heading">
          <h2>已发行试卷</h2>
          <p>选择一份纸卷，查看冻结卷面、重印或回收本页答卷。</p>
        </div>
        {data.issued.length ? <label className="field issued-field">选择发行记录<select value={id} onChange={e => selectPaper(e.target.value)}>
          <option value="">选择已发行卷</option>
          {data.issued.map(item => <option key={item.issuanceId} value={item.issuanceId}>{item.title} · {item.pageCount} 页 · {item.issuanceId}</option>)}
        </select></label> : <p className="issued-empty">当前没有可读取的发行记录。</p>}
        {issued && <div className="study-actions">
          <button className="tonal-button" disabled={busy} onClick={() => void execute(() => reprint(false))}>查看冻结卷面</button>
          <button className="primary-button" disabled={busy} onClick={() => void execute(() => reprint(true))}>重印或存为 PDF</button>
        </div>}
      </section>}
      {issued && <section className="issued-panel">
        <div className="issued-panel-heading">
          <h2>回收答卷</h2>
          <p>核对页码与原图后，把这一页作答回收进学习记录。</p>
        </div>
        <p className="issued-meta">{runId ? '另一次作答 · ' + runId : '首次作答'}</p>
        <label className="field issued-field">与原图对应的发行页<select value={page} onChange={e => {setPage(e.target.value); setReceipt(undefined);}}>
          <option value="">核对原图后选择页码</option>
          {Array.from({length:issued.pageCount}, (_,i) => <option key={i} value={i+1}>第 {i+1} 页</option>)}
        </select></label>
        <div className="study-actions">
          <button className="text-button" onClick={() => {
            const next = Array.from(crypto.getRandomValues(new Uint8Array(13)), n => n.toString(16).padStart(2,'0')).join('').toUpperCase();
            setRunId(next); remember('paper-run:'+id, next);
            setPage(''); setOriginalKey(''); setReceipt(undefined);
          }}>开始另一次作答</button>
          {runId && <button className="text-button" onClick={() => {
            setRunId(''); remember('paper-run:'+id, null); setReceipt(undefined); setPage(''); setOriginalKey('');
          }}>返回首次作答</button>}
        </div>
        {page && <PaperReturnUpload key={JSON.stringify([id, page, runId])} issuanceId={id} page={Number(page)}
          {...(runId ? {retryId:runId} : {})} setBusy={setBusy} reload={catalog.reload}/>}
        <h3>使用已交入的原图</h3>
        {originals.length ? <>
          <label className="field issued-field">答卷原图<select value={originalKey} onChange={e => {setOriginalKey(e.target.value); setReceipt(undefined);}}>
            <option value="">选择已交入的答卷原图</option>
            {originals.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select></label>
          <button className="tonal-button" disabled={!selected || !page || busy} onClick={() => void execute(collect)}>确认并回收本页</button>
          {receipt && <p role="status">已回收第 {receipt.page} 页 · 作答 {receipt.runId} · 第 {receipt.rev} 版。独立性未知。</p>}
        </> : <p className="issued-empty">当前没有获准回收的答卷原图。</p>}
      </section>}
    </div>
    {issued && view?.paper.issuanceId === id && <IssuedPaperView paper={view.paper} print={view.print}/>}
  </div>;
}
