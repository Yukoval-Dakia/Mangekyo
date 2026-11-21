import type {PaperTiming} from './workbook-pacing';

export type PaperSubmission = PaperTiming & {
  requestId: string;
  answers: Record<string, string | null>;
  paperRev?: number;
  deletionWatermark: string;
};

// The first read/write transaction owns the immutable input for this sitting. Another tab,
// a reload, and the offline sender all use the same body after an ambiguous network result.
async function withFrozenStore<T>(work: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('mangekyo-workbook-submissions', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('bodies');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('bodies', 'readwrite');
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('交卷请求未能固定在本机。'));
      work(tx.objectStore('bodies'), value => { result = value; });
    });
  } finally { db.close(); }
}

export async function freezeSubmission(paperId: string, requestId: string, build: () => PaperSubmission) {
  let failure: unknown;
  try {
    return await withFrozenStore<PaperSubmission>((store, done) => {
      const key = [paperId, requestId];
      const read = store.get(key);
      read.onsuccess = () => {
        try {
          if (read.result) { done(read.result); return; }
          const body = build();
          store.add(body, key);
          done(body);
        } catch (error) { failure = error; store.transaction.abort(); }
      };
    });
  } catch (error) { throw failure ?? error; }
}

export function forgetSubmission(paperId: string, requestId: string) {
  return withFrozenStore<void>((store, done) => { store.delete([paperId, requestId]); done(); });
}

export function readFrozenSubmission(paperId: string, requestId: string) {
  return withFrozenStore<PaperSubmission | undefined>((store, done) => {
    const read = store.get([paperId, requestId]);
    read.onsuccess = () => done(read.result);
  });
}

type PaperReceipt = PaperTiming & {requestId: string; paperRev?: number};
export function confirmsPaperSubmission(receipt: PaperReceipt | undefined, sent: PaperSubmission): boolean {
  if (receipt?.requestId !== sent.requestId) return false;
  if (sent.paperRev === undefined) return true;
  if (receipt.paperRev !== sent.paperRev || receipt.effectiveDurationMs !== sent.effectiveDurationMs) return false;
  if (!sent.pacing) return receipt.pacing === undefined;
  const items = receipt.pacing?.items;
  return receipt.pacing?.version === 1 && Array.isArray(items) && items.length === sent.pacing.items.length &&
    sent.pacing.items.every(row => items.some(item => item.questionId === row.questionId &&
      item.effectiveDurationMs === row.effectiveDurationMs && item.skipped === row.skipped && item.returned === row.returned));
}
