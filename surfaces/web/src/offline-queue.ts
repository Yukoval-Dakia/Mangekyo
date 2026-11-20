import { bindDeletionWatermark, synchronizeDeletion, validWatermark, verifyGenerationReceipt } from './deletion-watermark';
export type PendingCommand =
  | {kind:'material'; id:string; title:string; text:string}
  | {kind:'file'; id:string; title:string; file:File}
  | {kind:'practice'; id:string; version:string; answers:Record<string,number|null>}
  | {kind:'paper'; id:string; paperId:string; answers:Record<string,string|null>; effectiveDurationMs?:number|undefined};

export const queueChanged = 'mangekyo-offline-changed';

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
  await transact('readwrite',store => store.add({...command,deletionWatermark:bindDeletionWatermark(command.id)}));
  window.dispatchEvent(new Event(queueChanged));
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
    {answers:row.answers,effectiveDurationMs:row.effectiveDurationMs};
  const path = row.kind === 'material' ? '/api/materials' :
    row.kind === 'practice' ? '/api/practice/riding' : '/api/papers/'+encodeURIComponent(row.paperId)+'/attempts';
  return {path,init:{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...payload,requestId,deletionWatermark})}};
}

export async function discardQueued(position:number) {
  await transact('readwrite',store => store.delete(position));
  window.dispatchEvent(new Event(queueChanged));
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
        receipt?.attempts?.some((a:{requestId?:string}) => a.requestId === row.id);
      if (!valid) return {...result,reason:'提交结果待核对，待发命令已保留。'};
      await discardQueued(row.position);
      result.sent++;
    }
    return result;
  });
}
