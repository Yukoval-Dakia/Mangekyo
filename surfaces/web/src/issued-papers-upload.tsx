import {useEffect, useRef, useState} from 'react';
import {ApiError} from './api';
import {EraseOriginal, ErasureProgress, readErasure} from './erasure';
import {bindUpload, forgetUpload, returnPurposes, submitUpload,
  type ReturnPurpose, type ReturnReceipt, type UploadIntent} from './issued-papers-upload-request';

function OriginalReceipt({receipt, onReset}: {receipt: ReturnReceipt; onReset: () => void}) {
  const id = receipt.source.id;
  const [erasure, setErasure] = useState(() => readErasure(id));
  const [start, setStart] = useState(false);
  useEffect(() => {
    const restore = () => setErasure(readErasure(id));
    window.addEventListener('storage', restore);
    return () => window.removeEventListener('storage', restore);
  }, [id]);
  if (erasure) return <ErasureProgress id={id} initial={erasure} start={start} onReset={onReset}/>;
  return <>
    <p role="status">已回收第 {receipt.page} 页，尚未判分，独立性未知。</p>
    <p>{receipt.title} · 原件第 {receipt.source.rev} 版</p>
    <div className="study-actions">
      <a className="tonal-button" download href={'/api/materials/'+encodeURIComponent(id)+'/original'}>下载原件</a>
      <EraseOriginal id={id} revision={receipt.source.rev} onConfirmed={() => {setStart(true); setErasure(readErasure(id));}}/>
    </div>
  </>;
}

export function PaperReturnUpload({issuanceId, page, retryId, setBusy, reload}: {
  issuanceId: string; page: number; retryId?: string; setBusy: (busy: boolean) => void; reload: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [purpose, setPurpose] = useState<ReturnPurpose | ''>('');
  const [receipt, setReceipt] = useState<ReturnReceipt>();
  const [intent, setIntent] = useState<UploadIntent>();
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  function choose(next?: File) {
    if (!next) return;
    setReceipt(undefined); setIntent(undefined); setRejected(false); setError('');
    if (!next.size || next.size > 25 * 1024 * 1024) {
      setFile(null); setError('请选择一份非空且不超过 25 MB 的照片或 PDF。');
    } else setFile(next);
  }
  async function send() {
    if (sending.current || !file || !purpose || rejected) return;
    sending.current = true; setBusy(true); setError('');
    const upload = {issuanceId, page, purpose, file, ...(retryId ? {retryId} : {})};
    try {
      const binding = intent ?? await bindUpload(upload);
      setIntent(binding);
      setReceipt(await submitUpload(upload, binding));
      setFile(null); setPurpose(''); setIntent(undefined); reload();
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 409 || failure.status === 410)) {
        setRejected(true);
        if (failure.status === 410) setError('这份原件已永久删除，原请求无法恢复它。');
        else if (failure.code === 'deletion_watermark_stale') setError('设备上的删除状态已过期。请放弃旧请求，再重新选择文件和用途。');
        else setError('回收请求发生冲突，请核对卷号、页码和作答。' + failure.message);
      } else {
        setError(failure instanceof Error && !(failure instanceof TypeError || failure instanceof SyntaxError) ?
          failure.message : '未能确认回收结果，请用原请求重试。');
      }
    } finally {sending.current = false; setBusy(false);}
  }
  return <section aria-label="拍照或上传答卷">
    <h3>拍照或上传第 {page} 页</h3>
    <div className="study-actions">
      <input hidden ref={camera} type="file" accept="image/*" capture="environment" aria-label="拍摄答卷照片"
        onChange={e => {choose(e.currentTarget.files?.[0]); e.currentTarget.value='';}}/>
      <button type="button" className="tonal-button" disabled={rejected} onClick={() => camera.current?.click()}>拍照</button>
      <input hidden ref={picker} type="file" accept="image/*,application/pdf,.pdf" aria-label="上传答卷文件"
        onChange={e => {choose(e.currentTarget.files?.[0]); e.currentTarget.value='';}}/>
      <button type="button" className="tonal-button" disabled={rejected} onClick={() => picker.current?.click()}>选择照片或 PDF</button>
    </div>
    {file && <p>{file.name}</p>}
    <label className="field">原件用途<select disabled={rejected} value={purpose} onChange={e => {
      setPurpose(e.target.value as ReturnPurpose | ''); setIntent(undefined); setError('');
    }}>
      <option value="">选择本次上传的用途</option>
      {Object.entries(returnPurposes).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    {error && <p role="alert">{error}</p>}
    {rejected && intent ? <button type="button" className="tonal-button" onClick={() => {
      forgetUpload(intent); setIntent(undefined); setFile(null); setPurpose(''); setRejected(false); setError('');
    }}>放弃旧请求并重新选择</button> :
      <button type="button" className="primary-button" disabled={!file || !purpose} onClick={() => void send()}>
        {intent ? '用原请求重试' : '上传并回收本页'}
      </button>}
    {receipt && <OriginalReceipt key={receipt.source.id} receipt={receipt} onReset={() => {setReceipt(undefined); reload();}}/>}
  </section>;
}
