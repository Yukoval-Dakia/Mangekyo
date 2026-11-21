import {createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode} from 'react';
import {api, ApiError} from './api';
import {capsuleLabel, type ReadingContextEntry} from './paper-reading-capsule';

function onVisibilityChange(notify: () => void) {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
}
export function useVisibleDocument() {
  return useSyncExternalStore(onVisibilityChange, () => document.visibilityState === 'visible');
}

type Pinned = {id: string; rev: number};
type QuestionPermit = {paper: Pinned; permit: string; items: readonly string[]; attempt?: Pinned};
type DeferredLabels = {paperRev: number; attemptRef?: Pinned; items: {
  itemId: string; readingContext: ReadingContextEntry[];
}[]};
const Presentation = createContext<{grant: QuestionPermit | null; labels?: DeferredLabels | undefined}>({grant: null});

export function QuestionPresentation({value, children}: {value: QuestionPermit | null; children: ReactNode}) {
  const visible = useVisibleDocument();
  const [result, setResult] = useState<{scope: string; labels: DeferredLabels}>();
  const paper = value?.paper;
  const attempt = value?.attempt;
  const scope = visible && value ? JSON.stringify([value.paper.id, value.paper.rev, value.permit,
    attempt?.id, attempt?.rev, [...value.items].sort()]) : undefined;
  const params = new URLSearchParams({paperRev: String(paper?.rev)});
  if (attempt) {
    params.set('attemptId', attempt.id);
    params.set('attemptRev', String(attempt.rev));
  }
  const path = paper && '/papers/' + encodeURIComponent(paper.id) + '/reading-context?' + params;
  const rev = paper?.rev, attemptId = attempt?.id, attemptRev = attempt?.rev;
  useEffect(() => {
    setResult(undefined);
    if (!path || !scope) return;
    const controller = new AbortController();
    void api<DeferredLabels>(path, {signal: controller.signal}).then(labels => {
      if (!controller.signal.aborted && labels?.paperRev === rev && Array.isArray(labels.items) &&
          labels.items.every(item => typeof item?.itemId === 'string' && item.itemId.length > 0 &&
            Array.isArray(item.readingContext) && item.readingContext.every(entry =>
              entry && capsuleLabel(entry.kind) && typeof entry.ref === 'string' && entry.ref.trim())) &&
          new Set(labels.items.map(item => item.itemId)).size === labels.items.length &&
          (attemptId === undefined ? labels.attemptRef === undefined :
            labels.attemptRef?.id === attemptId && labels.attemptRef.rev === attemptRev)) {
        setResult({scope, labels});
      }
    }).catch(() => { /* Optional reading context can be unavailable. */ });
    return () => controller.abort();
  }, [path, scope, rev, attemptId, attemptRev]);
  const labels = result && result.scope === scope ? result.labels : undefined;
  return <Presentation value={{grant: value, labels}}>{children}</Presentation>;
}

export function useQuestionPresentation(itemId: string) {
  const {grant: granted, labels} = useContext(Presentation);
  if (!granted?.items.includes(itemId)) return null;
  const {paper, permit, attempt} = granted;
  // A successful snapshot covers the whole mount, including items omitted because they have no cards.
  const confirmed = labels && (labels.items.find(item => item.itemId === itemId)?.readingContext ?? []);
  return {paper, permit, confirmed, ...(attempt ? {attempt} : {})};
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
  const [confirmed, setConfirmed] = useState<{key: string; displayId: string}>();
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
    setConfirmed(undefined);
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
        api<{recorded: boolean; displayId?: string}>(path, {method: 'POST', body: {...JSON.parse(payload), phase: 'displayed', permit},
          signal: controller.signal}).then(result => {
          if (result?.recorded !== true) throw new Error();
          if (!controller.signal.aborted) {
            setConfirmationError(undefined);
            if (result.displayId) setConfirmed({key,displayId:result.displayId});
          }
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
    displayId: confirmed?.key === key && permit ? confirmed.displayId : undefined,
    error: needed && invalid ? '缺少固定版本，无法展示。' : current?.error ?? unconfirmed,
    retry: () => unconfirmed && permit ? setConfirmRetry(n => n + 1) : setRetry(n => n + 1),
  };
}
