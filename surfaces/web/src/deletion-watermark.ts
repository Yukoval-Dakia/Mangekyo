import {pruneOldWorkbookSubmissions} from './workbook-submission';
// A command keeps its original generation even if another tab observes a deletion.
export const latestKey = 'mangekyo:lifecycle-watermark';
const bindingKey = (id:string) => 'mangekyo:command-watermark:'+id;
export const validWatermark = (value:unknown):value is string => typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value);
export const watermarkHeader = 'X-Deletion-Watermark';

export function observedDeletionWatermark() {
  try { return localStorage.getItem(latestKey) ?? '0'; }
  catch { return '0'; }
}

export function subscribeDeletionWatermark(change: () => void) {
  window.addEventListener('storage', change);
  window.addEventListener(latestKey, change);
  return () => {
    window.removeEventListener('storage', change);
    window.removeEventListener(latestKey, change);
  };
}

export async function synchronizeDeletion() {
  const response = await fetch('/api/lifecycle',{cache:'no-store'});
  if (!response.ok) throw new Error('无法同步删除水位。');
  const state = await response.json();
  if (!validWatermark(state.watermark) || response.headers.get(watermarkHeader) !== state.watermark ||
      !Array.isArray(state.tombstones) || state.tombstones.some((t: {id?:unknown;generation?:unknown}|null) =>
        !t || typeof t.id !== 'string' || !validWatermark(t.generation) || BigInt(t.generation) > BigInt(state.watermark)))
    throw new Error('服务端未确认删除水位。');
  const last = localStorage.getItem(latestKey);
  if (last !== null && (!validWatermark(last) || BigInt(last) > BigInt(state.watermark)))
    throw new Error('服务端水位低于本机记录，待发内容已暂停。');
  if (last !== state.watermark) {
    localStorage.setItem(latestKey,state.watermark);
    if (state.tombstones.length) window.dispatchEvent(new Event(latestKey));
  }
  // Local cleanup only. A later synchronization retries an unavailable browser store.
  void pruneOldWorkbookSubmissions(state.watermark, bindDeletionWatermark).catch(() => {});
  return state.watermark as string;
}

export function bindDeletionWatermark(id:string):string {
  const key = bindingKey(id);
  // Unbound IDs predate generation support. Generation zero can never advance their authority.
  const value = localStorage.getItem(key) ?? '0';
  if (!validWatermark(value)) throw new Error('命令的原删除水位无法确认。');
  return value;
}

export function recordNewSubmission(id:string) {
  const value = localStorage.getItem(latestKey) ?? '0';
  if (!validWatermark(value)) throw new Error('无法读取本机删除水位。');
  localStorage.setItem(bindingKey(id),value);
  return id;
}

export function guardedPath(path:string) {
  return path === '/iqdb/proposals' || path === '/iqdb/papers' || path === '/materials' || path === '/practice/riding' || path === '/papers/sealed-practice' ||
    /^\/papers\/[0-9A-HJKMNP-TV-Z]{26}\/attempts(?:\/[0-9A-HJKMNP-TV-Z]{26}\/corrections)?$/.test(path);
}

export function verifyGenerationReceipt(response:Response, expected:string) {
  if (response.ok && response.headers.get(watermarkHeader) !== expected)
    throw new Error('未收到服务端删除水位回执，结果待核对。');
}
