import {confirmsPaperSubmission, type PaperSubmission} from './workbook-submission';
import { bindDeletionWatermark, synchronizeDeletion, validWatermark, verifyGenerationReceipt } from './deletion-watermark';
export type PendingCommand =
  | {kind:'material'; id:string; title:string; text:string}
  | {kind:'file'; id:string; title:string; file:File}
  | {kind:'practice'; id:string; version:string; answers:Record<string,number|null>}
  | {kind:'paper'; id:string; paperId:string; submission:PaperSubmission}
  | {kind:'paper'; id:string; paperId:string; answers:Record<string,string|null>; effectiveDurationMs?:number|undefined};

export const queueChanged = 'mangekyo-offline-changed';

function notifyQueueChanged() {
  window.dispatchEvent(new Event(queueChanged));
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(queueChanged);
  channel.postMessage(null);
  channel.close();
}

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open('mangekyo-pending',1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('commands',{keyPath:'position',autoIncrement:true});
      store.createIndex('id','id',{unique:true});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode:IDBTransactionMode, operation:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db = await openQueue();
  try {
    return await new Promise<T>((resolve,reject) => {
      const tx = db.transaction('commands',mode);
      const request = operation(tx.objectStore('commands'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function enqueue(command:PendingCommand) {
  const frozen = command.kind === 'paper' && 'submission' in command ? command.submission : undefined;
  const deletionWatermark = bindDeletionWatermark(command.id);
  if (frozen && (frozen.requestId !== command.id || frozen.deletionWatermark !== deletionWatermark))
    throw new Error('待发交卷与原提交标识或删除水位不符。');
  try {
    await transact('readwrite',store => store.add({...command,deletionWatermark}));
  } catch (error) {
    if (!frozen || !(error instanceof DOMException) || error.name !== 'ConstraintError') throw error;
    const existing: Row | undefined = await transact('readonly',store => store.index('id').get(command.id));
    if (existing?.kind !== 'paper' || command.kind !== 'paper' || existing.paperId !== command.paperId ||
        existing.deletionWatermark !== deletionWatermark || !('submission' in existing) ||
        JSON.stringify(existing.submission) !== JSON.stringify(frozen)) throw error;
  }
  notifyQueueChanged();
}

export function pendingCount() { return transact('readonly',store => store.count()); }

type Row = PendingCommand & {position:number; deletionWatermark?:string};
function bodyFor(row:Row) {
  const deletionWatermark = row.deletionWatermark!;
  const requestId = row.id;
  if (row.kind === 'file') {
    const form = new FormData();
    form.set('requestId',requestId);
    form.set('deletionWatermark',deletionWatermark);
    form.set('extraction','local');
    form.set('title',row.title);
    form.set('file',row.file);
    return {path:'/api/intake',init:{method:'POST',body:form}};
  }
  const payload = row.kind === 'material' ? {title:row.title,text:row.text} :
    row.kind === 'practice' ? {version:row.version,answers:row.answers} :
    'submission' in row ? row.submission : {answers:row.answers,effectiveDurationMs:row.effectiveDurationMs};
  const path = row.kind === 'material' ? '/api/materials' :
    row.kind === 'practice' ? '/api/practice/riding' : '/api/papers/'+encodeURIComponent(row.paperId)+'/attempts';
  return {path,init:{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...payload,requestId,deletionWatermark})}};
}

export async function discardQueued(position:number) {
  await transact('readwrite',store => store.delete(position));
  notifyQueueChanged();
}

export type SyncResult = {sent:number;removed:number;reason?:string;blocked?:number;legacy?:boolean};
export async function synchronizeQueue(allowLegacyPosition?:number):Promise<SyncResult> {
  // The server deduplicates after a crash. The device lock also orders two open tabs.
  return navigator.locks.request('mangekyo-offline-replay',async () => {
    const result:SyncResult = {sent:0,removed:0};
    let current = await synchronizeDeletion();
    while (navigator.onLine) {
      const first = await transact('readonly',store => store.openCursor());
      const row:Row|undefined = first?.value;
      if (!row) break;
      if (row.deletionWatermark === undefined) {
        if (row.position !== allowLegacyPosition)
          return {...result,blocked:row.position,legacy:true,reason:'旧命令未保存删除水位。可按旧设备水位 0 核对或丢弃。'};
        row.deletionWatermark = '0';
      }
      if (!validWatermark(row.deletionWatermark))
        return {...result,reason:'无法确认待发项的原删除水位。'};
      const original = BigInt(row.deletionWatermark);
      if (original > BigInt(current)) {
        current = await synchronizeDeletion();
        if (original > BigInt(current))
          return {...result,reason:'服务端尚未确认待发项的删除水位。'};
      }
      if (original < BigInt(current)) {
        await discardQueued(row.position);
        result.removed++;
        continue;
      }
      const {path,init} = bodyFor(row);
      const response = await fetch(path,init);
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        if (response.status === 409 && error?.code === 'deletion_watermark_stale') {
          current = await synchronizeDeletion();
          if (original < BigInt(current)) continue;
          return {...result,reason:'服务端未确认待发项已过期。'};
        }
        if (response.status === 410) {
          await discardQueued(row.position);
          result.removed++;
          continue;
        }
        return {...result,blocked:row.position,reason:typeof error?.error === 'string' ? error.error : '服务端未接受这项提交。'};
      }
      verifyGenerationReceipt(response,row.deletionWatermark);
      const receipt = await response.json();
      const valid = row.kind === 'material' || row.kind === 'file' ? typeof receipt?.id === 'string' :
        row.kind === 'practice' ? typeof receipt?.submission?.id === 'string' :
        'submission' in row ? receipt?.id === row.paperId && Array.isArray(receipt.attempts) &&
          confirmsPaperSubmission(receipt.attempts.find((a:{requestId?:string}) => a.requestId === row.id), row.submission) :
          receipt?.attempts?.some((a:{requestId?:string}) => a.requestId === row.id);
      if (!valid) return {...result,reason:'提交结果待核对，待发命令已保留。'};
      await discardQueued(row.position);
      result.sent++;
    }
    return result;
  });
}
