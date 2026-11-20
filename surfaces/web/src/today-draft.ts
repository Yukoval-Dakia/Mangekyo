export type Draft = { choice: number; requestId: string; pending?: boolean };

function parse(value: string | null): Draft | null {
  try {
    const draft = JSON.parse(value ?? 'null');
    return typeof draft?.requestId === 'string' && Number.isInteger(draft.choice) ? draft : null;
  } catch { return null; }
}

export function recoverDraft(key: string) {
  try {
    const pending = parse(sessionStorage.getItem(key));
    if (pending?.pending) return pending;
    const id = localStorage.getItem(key + ':latest');
    return id === null ? parse(localStorage.getItem(key)) : parse(localStorage.getItem(key + ':' + id));
  } catch { return null; }
}

// Only an explicit edit moves the shared pointer. Completion can remove the
// submitting request's payload even if another tab selects at that instant.
export function selectDraft(key: string, draft: Draft) {
  const previous = localStorage.getItem(key + ':latest');
  localStorage.setItem(key + ':' + draft.requestId, JSON.stringify(draft));
  localStorage.setItem(key + ':latest', draft.requestId);
  if (previous) localStorage.removeItem(key + ':' + previous);
  localStorage.removeItem(key); // superseded inline draft from older clients
}

export function pendingDraft(key: string, draft: Draft) {
  // The original tab can replay from session storage after another edit.
  sessionStorage.setItem(key, JSON.stringify({ ...draft, pending: true }));
}

export function settleDraft(key: string, id: string, discard: boolean) {
  if (parse(sessionStorage.getItem(key))?.requestId === id) sessionStorage.removeItem(key);
  if (!discard) return;
  localStorage.removeItem(key + ':' + id);
  if (parse(localStorage.getItem(key))?.requestId === id) localStorage.removeItem(key);
}
