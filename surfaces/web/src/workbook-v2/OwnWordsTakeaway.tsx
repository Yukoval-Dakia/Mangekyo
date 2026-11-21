import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import MathText from '../math-text.tsx';
import {
  confirmOwnWordsDisplay,
  isNotFound,
  loadTakeawayReview,
  openOwnWords,
  requestId,
  saveTakeaway,
  undoTakeaway,
} from './api.ts';
import type {
  L0Source,
  OpenedHintState,
  OwnWordsConceptWitness,
  SavedTakeawayState,
  TakeawayReview,
  WorkbookV2Expected,
} from './types.ts';

const MAX_TAKEAWAY = 60;

const ERROR_STAGE_LABELS: Record<string, string> = {
  reading: '审题读条件',
  modeling: '列式与建模',
  strategy: '思路与方法选择',
  execution: '计算与推演过程',
  expression: '表达与作答规范',
};

function formatErrorStage(stage: string): string {
  return ERROR_STAGE_LABELS[stage] ?? '关键推演步骤';
}

function formatDaysAgo(iso?: string, referenceIso?: string): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const referenceParsed = referenceIso ? Date.parse(referenceIso) : Number.NaN;
  const baseTime = Number.isFinite(referenceParsed) ? referenceParsed : Date.now();
  const days = Math.max(0, Math.round((baseTime - parsed) / 86_400_000));
  return days === 0 ? '今天' : `${days} 天前`;
}

export function formatExpectedValue(expected: string | WorkbookV2Expected | null | undefined): string | null {
  if (!expected) return null;
  if (typeof expected === 'string') return expected.trim() || null;
  if (expected.kind === 'numeric') {
    return expected.unit ? `${expected.value} ${expected.unit}` : String(expected.value);
  }
  if (expected.kind === 'exact') {
    return expected.values.length ? expected.values.join(' / ') : null;
  }
  return expected.rubric.trim() || null;
}

function isElementVisible(element: HTMLElement | null): boolean {
  if (!element || document.visibilityState !== 'visible') return false;
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const computed = getComputedStyle(element);
  return computed.display !== 'none' && computed.visibility !== 'hidden' && parseFloat(computed.opacity) > 0;
}

function isIndependentHelpLevel(helpLevel: TakeawayReview['helpLevel']): boolean {
  return helpLevel === 'independent' || helpLevel === 0;
}

export function OwnWordsHint({
  paperId,
  paperRev,
  itemId,
  source,
  submitted,
  initialOpened,
  onOpenedChange,
}: {
  paperId: string;
  paperRev?: number | undefined;
  itemId: string;
  source?: L0Source | undefined;
  submitted: boolean;
  initialOpened?: OpenedHintState | null | undefined;
  onOpenedChange?: ((next: OpenedHintState) => void) | undefined;
}) {
  const [state, setState] = useState<
    | { phase: 'idle' }
    | { phase: 'opening' }
    | { phase: 'shown'; text: string; displayRef: string; reported: boolean }
    | { phase: 'error'; message: string }
    | { phase: 'unsupported' }
  >(() =>
    initialOpened
      ? { phase: 'shown', text: initialOpened.text, displayRef: initialOpened.displayRef, reported: initialOpened.reported }
      : { phase: 'idle' },
  );
  const textRef = useRef<HTMLDivElement | null>(null);
  const submittedRef = useRef(submitted);
  submittedRef.current = submitted;
  const displaySentRef = useRef<string | null>(initialOpened?.reported ? initialOpened.displayRef : null);

  const open = useCallback(() => {
    if (!source || paperRev === undefined || submittedRef.current || state.phase !== 'idle') return;
    setState({ phase: 'opening' });
    const payload = {
      paperRev,
      itemId,
      sourcePaperId: source.sourcePaperId,
      sourceAttempt: source.sourceAttempt,
      sourceItemId: source.sourceItemId,
      ...(source.issuance !== undefined ? { issuance: source.issuance } : {}),
    };
    openOwnWords(paperId, payload)
      .then((result) => {
        if (submittedRef.current) return;
        const opened: OpenedHintState = { text: result.text, displayRef: result.displayRef, reported: false };
        setState({ phase: 'shown', ...opened });
        onOpenedChange?.(opened);
      })
      .catch((error: unknown) => {
        if (submittedRef.current) return;
        if (isNotFound(error)) {
          setState({ phase: 'unsupported' });
          return;
        }
        setState({ phase: 'error', message: error instanceof Error ? error.message : '暂时无法获取提示' });
      });
  }, [paperId, paperRev, itemId, source, state.phase, onOpenedChange]);

  useEffect(() => {
    if (
      state.phase !== 'shown' ||
      state.reported ||
      submitted ||
      submittedRef.current ||
      !source ||
      paperRev === undefined ||
      displaySentRef.current === state.displayRef
    ) {
      return;
    }
    let cancelled = false;
    let firstFrame = 0;
    let secondFrame = 0;
    const scheduleConfirm = () => {
      if (cancelled || submittedRef.current || displaySentRef.current === state.displayRef) return;
      if (firstFrame) cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          if (cancelled || submittedRef.current || displaySentRef.current === state.displayRef) return;
          if (!isElementVisible(textRef.current)) return;
          displaySentRef.current = state.displayRef;
          const payload = {
            paperRev,
            itemId,
            displayRef: state.displayRef,
            sourcePaperId: source.sourcePaperId,
            sourceAttempt: source.sourceAttempt,
            sourceItemId: source.sourceItemId,
            ...(source.issuance !== undefined ? { issuance: source.issuance } : {}),
          };
          confirmOwnWordsDisplay(paperId, payload)
            .then(() => {
              const reportedState: OpenedHintState = { text: state.text, displayRef: state.displayRef, reported: true };
              onOpenedChange?.(reportedState);
              if (!cancelled) setState((current) => (current.phase === 'shown' ? { ...current, reported: true } : current));
            })
            .catch(() => {
              displaySentRef.current = null;
            });
        });
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleConfirm();
    };
    if (document.visibilityState === 'visible') scheduleConfirm();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (firstFrame) cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [state, submitted, paperId, paperRev, itemId, source, onOpenedChange]);

  if (!source || paperRev === undefined || submitted) return null;

  return (
    <div className="wbv2-ownwords">
      <div className="wbv2-l0">
        {state.phase === 'idle' && (
          <>
            <p>这道题的「自己留的口诀」默认不展示，避免提前剧透。</p>
            <button type="button" className="wbv2-l0-btn" onClick={open}>
              给点方向
            </button>
          </>
        )}
        {state.phase === 'opening' && <p>正在读取你之前留的口诀…</p>}
        {state.phase === 'unsupported' && <p>当前后端还不支持这项提示功能，不影响作答。</p>}
        {state.phase === 'error' && (
          <>
            <p>{state.message}</p>
            <button type="button" className="wbv2-l0-btn" onClick={() => setState({ phase: 'idle' })}>
              重试
            </button>
          </>
        )}
        {state.phase === 'shown' && (
          <>
            <p>你之前给自己留的方向：</p>
            <div className="hint-text" ref={textRef}>
              <MathText text={state.text} />
            </div>
            <p className="src">来自你上一次作答的自留口诀</p>
          </>
        )}
      </div>
    </div>
  );
}

export function OwnWordsTakeawayEditor({
  paperId,
  attemptId,
  attemptRev,
  itemId,
  concept,
  submitted,
  initialSaved,
  onSavedChange,
}: {
  paperId: string;
  attemptId: string;
  attemptRev?: number | undefined;
  itemId: string;
  concept?: OwnWordsConceptWitness | string | undefined;
  submitted: boolean;
  initialSaved?: SavedTakeawayState | null | undefined;
  onSavedChange?: ((next: SavedTakeawayState | null) => void) | undefined;
}) {
  const [text, setText] = useState(initialSaved?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedTakeawayState | null>(initialSaved ?? null);
  const [error, setError] = useState('');
  const [statusNotice, setStatusNotice] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [review, setReview] = useState<TakeawayReview | null>(null);

  useEffect(() => {
    if (!submitted) return;
    const controller = new AbortController();
    loadTakeawayReview(paperId, attemptId, itemId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReview(result);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (isNotFound(caught) || (caught instanceof ApiError && caught.status === 403)) return;
      });
    return () => controller.abort();
  }, [submitted, paperId, attemptId, itemId]);

  const trimmed = text.trim();
  const hasNullChar = trimmed.includes('\u0000');
  const length = trimmed.length;
  const remaining = MAX_TAKEAWAY - length;
  const canSave = attemptRev !== undefined && length > 0 && remaining >= 0 && !hasNullChar && !busy && !saved;

  const save = useCallback(() => {
    if (!canSave || attemptRev === undefined) return;
    setBusy(true);
    setError('');
    setStatusNotice('');
    saveTakeaway(paperId, attemptId, {
      requestId: requestId(),
      attemptRev,
      itemId,
      text: trimmed,
      ...(concept ? { concept } : {}),
    })
      .then((receipt) => {
        const nextSaved: SavedTakeawayState = { id: receipt.id, undoToken: receipt.undo_token, text: trimmed };
        setSaved(nextSaved);
        onSavedChange?.(nextSaved);
      })
      .catch((caught: unknown) => {
        if (isNotFound(caught)) {
          setUnsupported(true);
          return;
        }
        setError(caught instanceof Error ? caught.message : '保存失败，请重试。');
      })
      .finally(() => setBusy(false));
  }, [canSave, paperId, attemptId, attemptRev, itemId, trimmed, concept, onSavedChange]);

  const undo = useCallback(() => {
    if (!saved) return;
    setBusy(true);
    setError('');
    undoTakeaway(paperId, saved.undoToken)
      .then(() => {
        setSaved(null);
        setStatusNotice('已撤回这条口诀，可重新编辑或留空。');
        onSavedChange?.(null);
      })
      .catch((caught: unknown) => {
        if (isNotFound(caught)) {
          setSaved(null);
          setStatusNotice('已撤回这条口诀，可重新编辑或留空。');
          onSavedChange?.(null);
          return;
        }
        setError(caught instanceof Error ? caught.message : '撤回失败，请重试。');
      })
      .finally(() => setBusy(false));
  }, [saved, paperId, onSavedChange]);

  if (!submitted) return null;

  const reviewText = review?.text?.trim() ? review.text.trim() : null;
  const daysLabel = formatDaysAgo(review?.takeawaySavedAt, review?.submittedAt);
  const hasPriorTakeaway =
    reviewText !== null || review?.takeawayRev !== undefined || Boolean(review?.takeawaySavedAt);
  const pureIndependentHit =
    review !== null &&
    hasPriorTakeaway &&
    review.result === 'correct' &&
    isIndependentHelpLevel(review.helpLevel);
  const realErrorStage =
    typeof review?.errorStage === 'string' && review.errorStage.trim() !== '' ? review.errorStage.trim() : null;
  const lostWithErrorStage =
    review !== null &&
    reviewText !== null &&
    (review.result === 'incorrect' || review.result === 'partial') &&
    review.helpLevel !== 'unknown' &&
    realErrorStage !== null;
  const formattedExpected = formatExpectedValue(review?.expected);

  return (
    <div className="wbv2-takeaway">
      {pureIndependentHit && (
        <div className="wbv2-hit-quiet" role="status">
          <em>命中你{daysLabel ? ` ${daysLabel}` : '之前'}留的口诀{reviewText ? '：' : ''}</em>
          {reviewText && <span>「{reviewText}」</span>}
        </div>
      )}
      {lostWithErrorStage && (
        <div className="wbv2-compare-grid" aria-label="旧口诀与本次错步对照">
          <section className="wbv2-compare-col">
            <h5>你之前留的口诀{daysLabel ? `（${daysLabel}）` : ''}</h5>
            <div className="wbv2-compare-body">
              <MathText text={reviewText} />
            </div>
          </section>
          <section className="wbv2-compare-col is-diverge">
            <h5>本次错步分叉 · {formatErrorStage(realErrorStage)}</h5>
            <div className="wbv2-compare-body">
              {review.explanation ? (
                <MathText text={review.explanation} />
              ) : formattedExpected ? (
                <MathText text={`参考答案：${formattedExpected}`} />
              ) : (
                <p>本题在「{formatErrorStage(realErrorStage)}」环节出现分叉，可结合旧口诀补一句更贴近错步的提醒。</p>
              )}
            </div>
          </section>
        </div>
      )}
      {attemptRev !== undefined && (
        <>
          <h4>给自己留句口诀（选填，≤{MAX_TAKEAWAY} 字）</h4>
          {unsupported ? (
            <p className="hit">当前后端暂不支持口诀保存，不影响本次复盘。</p>
          ) : (
            <>
              <textarea
                value={saved ? saved.text : text}
                maxLength={MAX_TAKEAWAY * 2}
                placeholder="下次看到这类题，先想到的一句话…"
                disabled={busy || !!saved}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  if (statusNotice) setStatusNotice('');
                }}
                aria-label="自留口诀"
              />
              <div className="row">
                <span className={`count${remaining < 0 ? ' is-over' : ''}`}>
                  {saved ? '已保存' : remaining >= 0 ? `还可写 ${remaining} 字` : `已超出 ${-remaining} 字`}
                </span>
                {!saved && (
                  <button type="button" className="wbv2-l0-btn" disabled={!canSave} onClick={save}>
                    {busy ? '保存中…' : '留一句'}
                  </button>
                )}
              </div>
              {saved && (
                <div className="undo-bar">
                  <span>已帮你记住，下次做同类题可能用到。</span>
                  <button type="button" onClick={undo} disabled={busy}>
                    撤回
                  </button>
                </div>
              )}
              {statusNotice && !saved && <p className="hit">{statusNotice}</p>}
              {error && <p className="wbv2-error">{error}</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}
