import { useEffect,useEffectEvent,useRef,useState } from 'react';
import { api,ApiError,requestId } from './api';
import { synchronizeDeletion } from './deletion-watermark';

type Receipt = {id:string; generation:string; blocked:true; original:'removed'|'pending';
  copies:'unverified'; backups:'unverified'; devices:'unverified'};
type Intent = {requestId:string; expectedRev:number; receipt?:Receipt};
const keyPrefix = 'mangekyo:erase-original:';
const key = (id:string) => keyPrefix+id;
export function pendingErasures() {
  try {
    return Object.keys(localStorage).filter(k => k.startsWith(keyPrefix)).map(k => k.slice(keyPrefix.length))
      .filter(id => {const intent = readErasure(id);return intent && intent.receipt?.original !== 'removed';});
  } catch {return [];}
}

function validReceipt(data:Receipt|undefined,id:string):data is Receipt {
  return data?.blocked === true && data.id === id && /^(0|[1-9]\d*)$/.test(data.generation) &&
    typeof data.generation === 'string' && data.copies === 'unverified' && data.backups === 'unverified' &&
    data.devices === 'unverified' && (data.original === 'removed' || data.original === 'pending');
}

export function readErasure(id:string):Intent|null {
  try {
    const intent = JSON.parse(localStorage.getItem(key(id)) ?? 'null');
    return intent && typeof intent.requestId === 'string' && Number.isSafeInteger(intent.expectedRev) &&
      intent.expectedRev > 0 && (!intent.receipt || validReceipt(intent.receipt,id)) ? intent : null;
  } catch {return null;}
}

export function EraseOriginal({id,revision,onConfirmed}:{id:string;revision:number;onConfirmed:()=>void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error,setError] = useState('');
  function confirm() {
    try {
      // Write once before sending. A reload or a lost response reuses the same identity.
      if (!readErasure(id)) localStorage.setItem(key(id),JSON.stringify({requestId:requestId(),expectedRev:revision}));
      onConfirmed();
    } catch {setError('无法保存删除请求标识，操作尚未开始。');}
  }
  return <>
    <button type="button" className="text-button danger erasure-trigger" onClick={() => dialog.current?.showModal()}>永久删除原件</button>
    <dialog ref={dialog} className="settings-dialog" aria-label="确认永久删除原件">
      <h2>永久删除这份原件？</h2>
      <p>将删除此材料、交入记录、关联命令和已归属的本机原件。此操作无法撤回。</p>
      <p>其他产物、第三方副本、离线设备与备份的清除状态均未核实。</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" className="tonal-button" autoFocus onClick={() => dialog.current?.close()}>取消</button>
      <button type="button" className="text-button danger" onClick={confirm}>确认永久删除</button>
    </dialog>
  </>;
}

export function ErasureProgress({id,initial,start,onReset}:{id:string;initial:Intent;start:boolean;onReset:()=>void}) {
  const [intent,setIntent] = useState(initial);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [rejected,setRejected] = useState(false);
  const started = useRef(false);
  async function send() {
    if (busy || intent.receipt?.original === 'removed') return;
    setBusy(true);setError('');
    try {
      const result = await api<Receipt>('/materials/'+encodeURIComponent(id)+'/erasure',{method:'POST',
        body:{requestId:intent.requestId,expectedRev:intent.expectedRev,confirmation:'permanently-delete-original'}});
      if (!validReceipt(result,id)) throw new Error('删除回执格式不完整。');
      const saved = {...intent,receipt:result};
      localStorage.setItem(key(id),JSON.stringify(saved));
      setIntent(saved);
      void synchronizeDeletion().catch(() => {});
    } catch (failure) {
      setRejected(failure instanceof ApiError && (failure.status === 409 || failure.status === 403));
      setError(failure instanceof ApiError ? failure.message : '删除结果尚未确认，请沿用原请求核对。');
    } finally {setBusy(false);}
  }
  const sendConfirmed = useEffectEvent(send);
  useEffect(() => {
    if (start && !started.current) {started.current=true;void sendConfirmed();}
  },[start]);
  return <section className="goal-panel">
    <h1>原件删除进度</h1>
    {intent.receipt && <p>已阻断访问 · 删除代次 {intent.receipt.generation} ·
      {intent.receipt.original === 'removed' ? '本机原件已清除' : '本机原件待清除'}。</p>}
    <p>其他产物、第三方副本、离线设备与备份的清除状态未核实。</p>
    {error && <p role="alert">{error}</p>}
    {intent.receipt?.original !== 'removed' && <button className="tonal-button" disabled={busy} onClick={() => void send()}>
      {busy ? '正在核对…' : '以原请求继续核对'}</button>}
    {rejected && !intent.receipt && <button className="text-button" onClick={() => {localStorage.removeItem(key(id));onReset();}}>重新查看原件版本</button>}
    <a className="text-button" href="/materials">返回材料</a>
  </section>;
}
