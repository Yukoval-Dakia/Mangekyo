import {createContext, useContext, useEffect, useState, useSyncExternalStore} from 'react';
import {api, ApiError} from './api';

function onVisibilityChange(notify: () => void) {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
}
export function useVisibleDocument() {
  return useSyncExternalStore(onVisibilityChange, () => document.visibilityState === 'visible');
}

type Pinned = {id: string; rev: number};
type QuestionPermit = {paper: Pinned; permit: string; items: readonly string[]; attempt?: Pinned};
export const QuestionPresentation = createContext<QuestionPermit | null>(null);

export function useQuestionPresentation(itemId: string) {
  const granted = useContext(QuestionPresentation);
  if (!granted?.items.includes(itemId)) return null;
  const {paper, permit, attempt} = granted;
  return {paper, permit, ...(attempt ? {attempt} : {})};
}

type Receipt = {key: string; permit?: string; error?: string};
const validRev = (rev?: number): rev is number => rev !== undefined && Number.isSafeInteger(rev) && rev > 0;

/** The permit commits the possibility of exposure. Only the mounted foreground view confirms display. */
export function useWorkbookPresentation(
  paperId: string, revision: number | undefined, items: readonly string[],
  binding?: {kind: 'question' | 'solution'; attempt: {id: string; rev?: number}},
) {
  const visible = useVisibleDocument();
  const [retry, setRetry] = useState(0);
  const [receipt, setReceipt] = useState<Receipt>();
  const [confirmationError, setConfirmationError] = useState<Receipt>();
  const [confirmRetry, setConfirmRetry] = useState(0);
  const attempt = binding?.attempt;
  const invalid = !validRev(revision) || (attempt !== undefined && (!attempt.id || !validRev(attempt.rev)));
  const ref = attempt && validRev(attempt.rev) ? {id: attempt.id, rev: attempt.rev} : undefined;
  const payload = JSON.stringify({paper: {id: paperId, rev: revision}, items: [...new Set(items)].sort(),
    kind: binding?.kind ?? 'question',
    ...(ref && (binding?.kind === 'solution' ? {submission: ref} : {attemptRef: ref}))});
  const key = JSON.stringify([payload, retry]);
  const path = '/papers/' + encodeURIComponent(paperId) + '/presentation';
  const needed = items.length > 0;
  const request = visible && needed && !invalid;
  useEffect(() => {
    setReceipt(undefined);
    setConfirmationError(undefined);
    if (!request) return;
    const controller = new AbortController();
    api<{permit: string}>(path, {method: 'POST', body: {...JSON.parse(payload), phase: 'permit'}, signal: controller.signal})
      .then(result => {
        if (!result || typeof result.permit !== 'string' || !result.permit) throw new Error();
        if (!controller.signal.aborted) setReceipt({key, permit: result.permit});
      })
      .catch(error => {
        if (!controller.signal.aborted) setReceipt({key, error: error instanceof ApiError ? error.message : '无法确认展示许可。'});
      });
    return () => controller.abort();
  }, [request, path, key, payload]);
  const current = receipt?.key === key ? receipt : undefined;
  const permit = request && current?.permit;
  useEffect(() => {
    if (!permit) return;
    const controller = new AbortController();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (document.visibilityState !== 'visible') return;
        api<{recorded: boolean}>(path, {method: 'POST', body: {...JSON.parse(payload), phase: 'displayed', permit},
          signal: controller.signal}).then(result => {
          if (result?.recorded !== true) throw new Error();
          if (!controller.signal.aborted) setConfirmationError(undefined);
        }).catch(error => {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            setReceipt({key, error: error.message});
          } else setConfirmationError({key, error: '未收到展示回执。'});
        });
      });
    });
    return () => { cancelAnimationFrame(frame); controller.abort(); };
  }, [path, payload, key, permit, confirmRetry]);

  const unconfirmed = confirmationError?.key === key ? confirmationError.error : undefined;
  return {
    questionPermit: permit && binding?.kind !== 'solution' && revision
      ? {paper: {id: paperId, rev: revision}, permit, items, ...(ref && {attempt: ref})} : null,
    allowed: !needed || Boolean(permit),
    error: needed && invalid ? '缺少固定版本，无法展示。' : current?.error ?? unconfirmed,
    retry: () => unconfirmed && permit ? setConfirmRetry(n => n + 1) : setRetry(n => n + 1),
  };
}
