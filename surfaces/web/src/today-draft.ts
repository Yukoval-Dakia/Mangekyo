import { bindDeletionWatermark, validWatermark } from './deletion-watermark';

export type Draft = { choice: number; requestId: string; pending?: boolean; deletionWatermark?: string };
type PackRef = { id: string; rev: number };
type Pending = PackRef & { choice: number; requestId: string; deletionWatermark: string; pending: true };

export const answerKey = ({ id, rev }: PackRef) => 'mangekyo:today-pack:' + encodeURIComponent(id) + '@' + rev + ':answer';

function parse(value: string | null) {
  try { return JSON.parse(value ?? 'null'); } catch { return null; }
}

function edit(value: unknown): Draft | null {
  if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string' ||
      !('choice' in value) || typeof value.choice !== 'number' || !Number.isInteger(value.choice)) return null;
  return { requestId: value.requestId, choice: value.choice, pending: 'pending' in value && value.pending === true };
}

function currentDraft(key: string) {
  const id = localStorage.getItem(key + ':latest');
  return edit(parse(localStorage.getItem(id === null ? key : key + ':' + id)));
}

function readPending(pack: PackRef, requestId: string): Pending | null {
  const value = parse(localStorage.getItem(answerKey(pack) + ':pending:' + requestId));
  if (value?.id !== pack.id || value.rev !== pack.rev || value.requestId !== requestId ||
      value.pending !== true || !Number.isSafeInteger(value.choice) || value.choice < 0 ||
      !validWatermark(value.deletionWatermark)) return null;
  return value;
}

export function recoverDraft(pack: PackRef, requested: string | null) {
  try {
    const key = answerKey(pack);
    const current = currentDraft(key);
    if (requested !== null) return readPending(pack, requested) ?? (current?.requestId === requested ? current : null);
    const marker = parse(sessionStorage.getItem(key));
    // Before durable pending records, this tab could hold the only copy.
    const legacy = edit(marker);
    if (legacy?.pending) return legacy;
    return (typeof marker === 'string' && readPending(pack, marker)) || current;
  } catch { return null; }
}

// Only an explicit edit moves the shared pointer. Submission records have a
// separate key space and survive the removal of a superseded editable draft.
export function selectDraft(key: string, draft: Draft) {
  const previous = localStorage.getItem(key + ':latest');
  localStorage.setItem(key + ':' + draft.requestId, JSON.stringify(draft));
  localStorage.setItem(key + ':latest', draft.requestId);
  if (previous) localStorage.removeItem(key + ':' + previous);
  localStorage.removeItem(key);
}

export function pendingDraft(pack: PackRef, draft: Draft, deletionWatermark: string): Pending {
  const { id, rev } = pack;
  const { requestId, choice } = draft;
  const key = answerKey(pack);
  const storageKey = key + ':pending:' + requestId;
  const frozen: Pending = { id, rev, choice, requestId, deletionWatermark, pending: true };
  const existing = readPending(pack, requestId);
  if (existing) {
    if (existing.choice !== choice || existing.deletionWatermark !== deletionWatermark) throw new Error('请求已变化。');
  } else {
    if (draft.deletionWatermark !== undefined || localStorage.getItem(storageKey) !== null) throw new Error('原请求不可用。');
    localStorage.setItem(storageKey, JSON.stringify(frozen));
  }
  // This marker only selects the request when the submitting tab reloads.
  try { sessionStorage.setItem(key, JSON.stringify(requestId)); } catch { /* Still recoverable from the list. */ }
  return frozen;
}

export function settleDraft(key: string, id: string, discard: boolean) {
  localStorage.removeItem(key + ':pending:' + id);
  try {
    const marker = parse(sessionStorage.getItem(key));
    if (marker === id || marker?.requestId === id) sessionStorage.removeItem(key);
  } catch { /* The durable request has already been cleared. */ }
  if (!discard) return;
  localStorage.removeItem(key + ':' + id);
  if (parse(localStorage.getItem(key))?.requestId === id) localStorage.removeItem(key);
}

export function forgetPackDrafts(key: string) {
  for (const stored of Object.keys(localStorage)) {
    if (stored === key || stored.startsWith(key + ':')) localStorage.removeItem(stored);
  }
  sessionStorage.removeItem(key);
}

export function savedDrafts(pack: PackRef, watermark: string): Draft[] {
  const key = answerKey(pack);
  const prefix = key + ':pending:';
  const drafts: Draft[] = [];
  for (const storageKey of Object.keys(localStorage)) {
    if (!storageKey.startsWith(prefix)) continue;
    const pending = readPending(pack, storageKey.slice(prefix.length));
    if (pending) drafts.push(pending);
  }
  const current = currentDraft(key);
  if (current && !drafts.some(draft => draft.requestId === current.requestId)) drafts.push(current);
  return drafts.filter(draft => {
    let original: string;
    try { original = draft.deletionWatermark ?? bindDeletionWatermark(draft.requestId); }
    catch { return false; }
    if (BigInt(original) < BigInt(watermark)) settleDraft(key, draft.requestId, true);
    return original === watermark;
  });
}
