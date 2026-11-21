import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deletedSubmission, submissionId } from '../api.ts';
import { isNotFound, loadPaper, loadPreSubmitPitfalls, submitAttempt } from './api.ts';
import type {
  CompanionCitation,
  Confidence,
  L0Source,
  OpenedHintState,
  QuestionAttachmentsPayload,
  SavedTakeawayState,
  PreSubmitPitfall,
  PreSubmitRevisionPayload,
  WorkbookV2Attempt,
  WorkbookV2Detail,
} from './types.ts';
import { usePaperAttachments } from './QuestionAttachmentUploader.tsx';
import { FocusedQuestionCard } from './FocusedQuestionCard.tsx';
import { ExamTimeValueBar } from './ExamTimeValueBar.tsx';
import { PreSubmitCheckCard } from './PreSubmitCheckCard.tsx';

type ItemState = {
  answer: string;
  confidence: Confidence | null;
};

type PreSubmitAnchorState = {
  readonly paperRev: number;
  readonly originalAnswer: string;
};

const emptyItem = (): ItemState => ({ answer: '', confidence: null });

function seedItemsFor(detail: WorkbookV2Detail): Record<string, ItemState> {
  const seeded: Record<string, ItemState> = {};
  for (const question of detail.questions) seeded[question.id] = emptyItem();
  return seeded;
}

export function WorkbookSurface({
  paperId,
  initialPaper,
  l0Sources,
  onCiteToCompanion,
}: {
  paperId: string;
  initialPaper?: WorkbookV2Detail | undefined;
  l0Sources?: Record<string, L0Source> | undefined;
  onCiteToCompanion?: ((citation: CompanionCitation) => void) | undefined;
}) {
  const [paper, setPaper] = useState<WorkbookV2Detail | null>(() => initialPaper ?? null);
  const [loadError, setLoadError] = useState('');
  const [index, setIndex] = useState(0);
  const [items, setItems] = useState<Record<string, ItemState>>(() => (initialPaper ? seedItemsFor(initialPaper) : {}));
  const [openedHints, setOpenedHints] = useState<Record<string, OpenedHintState>>({});
  const [savedTakeaways, setSavedTakeaways] = useState<Record<string, SavedTakeawayState | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submittedAttempt, setSubmittedAttempt] = useState<WorkbookV2Attempt | null>(null);
  const requestRef = useRef(submissionId());
  const [pitfalls, setPitfalls] = useState<readonly PreSubmitPitfall[]>([]);
  const [preSubmitCardOpen, setPreSubmitCardOpen] = useState(false);
  const [preSubmitAcknowledged, setPreSubmitAcknowledged] = useState(false);
  const [preSubmitAnchors, setPreSubmitAnchors] = useState<Record<string, PreSubmitAnchorState>>({});
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const attachments = usePaperAttachments(paperId);

  const questions = paper?.questions ?? [];
  const total = questions.length;
  const current = questions[index];

  useEffect(() => {
    setIndex(0);
    setError('');
    setLoadError('');
    setOpenedHints({});
    setSavedTakeaways({});
    setSubmittedAttempt(null);
    requestRef.current = submissionId();
    setPitfalls([]);
    setPreSubmitCardOpen(false);
    setPreSubmitAcknowledged(false);
    setPreSubmitAnchors({});
    attachments.resetAll();

    if (initialPaper && initialPaper.id === paperId) {
      setPaper(initialPaper);
      setItems(seedItemsFor(initialPaper));
    } else {
      setPaper(null);
    }

    const controller = new AbortController();
    loadPreSubmitPitfalls(paperId, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setPitfalls(loaded);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPitfalls([]);
      });

    if (!initialPaper || initialPaper.id !== paperId) {
      loadPaper(paperId, controller.signal)
        .then((loaded) => {
          if (controller.signal.aborted) return;
          setPaper(loaded);
          setItems(seedItemsFor(loaded));
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted) setLoadError(caught instanceof Error ? caught.message : '无法打开试卷。');
        });
    }
    return () => controller.abort();
  }, [paperId, initialPaper, attachments.resetAll]);

  const patchItem = useCallback((itemId: string, patch: Partial<ItemState>) => {
    setItems((previous) => ({ ...previous, [itemId]: { ...(previous[itemId] ?? emptyItem()), ...patch } }));
  }, []);

  const handleOpenedHintChange = useCallback((itemId: string, next: OpenedHintState) => {
    setOpenedHints((previous) => ({ ...previous, [itemId]: next }));
  }, []);

  const handleSavedTakeawayChange = useCallback((itemId: string, next: SavedTakeawayState | null) => {
    setSavedTakeaways((previous) => ({ ...previous, [itemId]: next }));
  }, []);

  const answered = useMemo(
    () =>
      new Set(
        questions
          .filter(
            (question) =>
              (items[question.id]?.answer ?? '').trim() !== '' ||
              (attachments.summariesByQuestion[question.id]?.done ?? 0) > 0,
          )
          .map((question) => question.id),
      ),
    [questions, items, attachments.summariesByQuestion],
  );

  const feedbackByQuestion = useMemo(() => {
    const map = new Map<string, NonNullable<WorkbookV2Attempt['feedback']>[number]>();
    for (const row of submittedAttempt?.feedback ?? []) map.set(row.questionId, row);
    return map;
  }, [submittedAttempt]);

  const go = useCallback(
    (next: number) => {
      if (next >= 0 && next < total) setIndex(next);
    },
    [total],
  );

  const submit = useCallback(async () => {
    if (!paper || attachments.lock.locked || busy || submittedAttempt) return;
    const hasAnyInput = questions.some(
      (question) =>
        (items[question.id]?.answer ?? '').trim() !== '' ||
        (attachments.summariesByQuestion[question.id]?.done ?? 0) > 0,
    );
    if (!hasAnyInput) {
      setError('请至少作答或上传一题过程图再交卷。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const answers: Record<string, string | null> = {};
      const confidence: Record<string, number> = {};
      const questionAttachments: QuestionAttachmentsPayload = {};
      for (const question of questions) {
        const item = items[question.id];
        answers[question.id] = item?.answer.trim() ? item.answer.trim() : null;
        if (item?.confidence) confidence[question.id] = item.confidence;
        const done = (attachments.itemsByQuestion[question.id] ?? [])
          .filter((entry) => entry.state.phase === 'done')
          .map((entry) => (entry.state.phase === 'done' ? { originalId: entry.state.originalId, rev: entry.state.rev } : null))
          .filter((entry): entry is { originalId: string; rev: number } => entry !== null);
        if (done.length) questionAttachments[question.id] = done;
      }
      const body = {
        requestId: requestRef.current,
        answers,
        ...(Object.keys(confidence).length ? { confidence } : {}),
        ...(Object.keys(questionAttachments).length ? { questionAttachments } : {}),
        ...(paper.revision !== undefined ? { paperRev: paper.revision } : {}),
      };
      const paperRev = paper.revision;
      const preSubmitRevisions = paperRev === undefined ? [] : Object.entries(preSubmitAnchors)
        .filter(([itemId, anchor]) => paperRev === anchor.paperRev && (items[itemId]?.answer ?? '').trim() !== anchor.originalAnswer)
        .map(([itemId, anchor]): PreSubmitRevisionPayload => ({
          draftRequestId: requestRef.current,
          paperRev,
          itemId,
          originalAnswer: anchor.originalAnswer,
        }));
      const requestBody = preSubmitRevisions.length ? { ...body, preSubmitRevisions } : body;
      const next = await submitAttempt(paperId, requestBody);
      const received = next?.attempts?.find((attempt) => attempt.requestId === requestRef.current);
      if (!received) throw new Error('未收到与原提交相符的交卷回执，可重试原提交。');
      setSubmittedAttempt(received);
      setPaper(next);
      requestRef.current = submissionId();
      setPreSubmitAnchors({});
      setPreSubmitCardOpen(false);
      setPreSubmitAcknowledged(false);
    } catch (caught: unknown) {
      if (isNotFound(caught)) {
        setError('当前后端暂不支持交卷接口，请稍后再试。');
      } else if (deletedSubmission(caught)) {
        requestRef.current = submissionId();
        setPreSubmitAnchors({});
        setPreSubmitAcknowledged(false);
        setError('删除状态已变化，旧作答标识已更新，请核对后重新交卷。');
      } else {
        setError(caught instanceof Error ? caught.message : '交卷失败，请重试。');
      }
    } finally {
      setBusy(false);
    }
  }, [paper, attachments.lock.locked, attachments.summariesByQuestion, attachments.itemsByQuestion, busy, submittedAttempt, questions, items, paperId, preSubmitAnchors]);

  const beginSubmit = useCallback(() => {
    if (pitfalls.length > 0 && !preSubmitAcknowledged) {
      setPreSubmitCardOpen(true);
      return;
    }
    void submit();
  }, [pitfalls, preSubmitAcknowledged, submit]);

  const closePreSubmitCard = useCallback(() => setPreSubmitCardOpen(false), []);

  const confirmPreSubmit = useCallback(() => {
    setPreSubmitAcknowledged(true);
    setPreSubmitCardOpen(false);
  }, []);

  const jumpToQuestion = useCallback((itemId: string) => {
    const nextIndex = questions.findIndex((question) => question.id === itemId);
    if (nextIndex < 0) return;
    setPreSubmitCardOpen(false);
    go(nextIndex);
    setFocusItemId(itemId);
  }, [questions, go]);

  const inspectPreSubmitAnchor = useCallback((itemId: string) => {
    const paperRev = paper?.revision;
    if (paperRev !== undefined && preSubmitAnchors[itemId] === undefined && (items[itemId]?.answer ?? '').trim() !== '') {
      setPreSubmitAnchors((previous) => {
        if (previous[itemId] !== undefined) return previous;
        return {
          ...previous,
          [itemId]: { paperRev, originalAnswer: (items[itemId]?.answer ?? '').trim() },
        };
      });
    }
    jumpToQuestion(itemId);
  }, [paper?.revision, preSubmitAnchors, items, jumpToQuestion]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === 'TEXTAREA' || tag === 'INPUT' || Boolean(target?.isContentEditable);
      if (event.key === 'ArrowLeft' && !typing) {
        event.preventDefault();
        go(index - 1);
      }
      if (event.key === 'ArrowRight' && !typing) {
        event.preventDefault();
        go(index + 1);
      }
      if (!typing && /^[1-9]$/.test(event.key)) {
        const targetIndex = Number(event.key) - 1;
        if (targetIndex < total) go(targetIndex);
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !attachments.lock.locked && !submittedAttempt) {
        event.preventDefault();
        beginSubmit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, total, attachments.lock.locked, submittedAttempt, go, beginSubmit]);

  useEffect(() => {
    if (preSubmitAcknowledged && !preSubmitCardOpen && !busy && !submittedAttempt) void submit();
  }, [preSubmitAcknowledged, preSubmitCardOpen, busy, submittedAttempt, submit]);

  useEffect(() => {
    if (!focusItemId) return;
    const element = document.querySelector<HTMLElement>(`[data-wbv2-question-id="${CSS.escape(focusItemId)}"]`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.focus({ preventScroll: true });
    setFocusItemId(null);
  }, [focusItemId]);

  if (loadError) {
    return <div className="wbv2"><p className="wbv2-error">{loadError}</p></div>;
  }
  if (!paper) {
    return <div className="wbv2"><p className="wbv2-attach-note info">正在打开试卷…</p></div>;
  }

  const currentItem = current ? (items[current.id] ?? emptyItem()) : emptyItem();
  const reviewAttachments = current && submittedAttempt ? submittedAttempt.questionAttachments?.[current.id] : undefined;
  const currentFeedback = current ? feedbackByQuestion.get(current.id) : undefined;
  const rawSubmittedAnswer = current && submittedAttempt?.answers ? submittedAttempt.answers[current.id] : undefined;
  const currentSubmittedAnswer =
    typeof rawSubmittedAnswer === 'string' || typeof rawSubmittedAnswer === 'number' || rawSubmittedAnswer === null
      ? rawSubmittedAnswer
      : undefined;
  const otherBlockedIndex =
    current && attachments.lock.locked
      ? questions.findIndex((question) => question.id !== current.id && attachments.lock.blockedItemIds.includes(question.id))
      : -1;
  const reviewExamTimeValue = submittedAttempt?.examTimeValue;

  return (
    <div className="wbv2">
      {paper.title && (
        <header className="wbv2-paper-head">
          <h2 className="wbv2-paper-title">{paper.title}</h2>
          <span className="wbv2-progress">
            {submittedAttempt ? `复盘模式 · 共 ${total} 题` : `${answered.size}/${total} 已作答`}
          </span>
          {submittedAttempt?.preSubmitRevised === true && (
            <span className="wbv2-pre-submit-badge">交卷前自检已修改</span>
          )}
        </header>
      )}
      {submittedAttempt && (
        <ExamTimeValueBar
          value={reviewExamTimeValue}
          focusedItemId={current?.id}
          onJump={jumpToQuestion}
        />
      )}
      <div className="wbv2-topbar">
        <button type="button" className="wbv2-arrow" aria-label="上一题" disabled={index === 0} onClick={() => go(index - 1)}>
          ‹
        </button>
        <div className="wbv2-nav" role="tablist" aria-label="题目切换">
          {questions.map((question, order) => {
            const summary = attachments.summariesByQuestion[question.id];
            const questionFeedback = feedbackByQuestion.get(question.id);
            const classes = [
              'wbv2-num',
              answered.has(question.id) ? 'is-answered' : '',
              summary?.failed ? 'is-upload-error' : summary?.uploading ? 'is-uploading' : '',
              questionFeedback?.result === 'correct'
                ? 'is-correct'
                : questionFeedback?.result === 'incorrect'
                  ? 'is-incorrect'
                  : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={question.id}
                type="button"
                role="tab"
                aria-selected={order === index}
                aria-current={order === index ? 'step' : undefined}
                className={classes}
                onClick={() => go(order)}
              >
                {order + 1}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="wbv2-arrow"
          aria-label="下一题"
          disabled={index >= total - 1}
          onClick={() => go(index + 1)}
        >
          ›
        </button>
        {!paper.title && (
          <span className="wbv2-progress">
            {answered.size}/{total} 已作答
          </span>
        )}
      </div>

      {current && (
        <FocusedQuestionCard
          key={current.id}
          paperId={paperId}
          paperRev={paper.revision}
          index={index}
          total={total}
          question={current}
          answer={currentItem.answer}
          onAnswer={(itemId, nextAnswer) => patchItem(itemId, { answer: nextAnswer })}
          confidence={currentItem.confidence}
          onConfidence={(itemId, nextConfidence) => patchItem(itemId, { confidence: nextConfidence })}
          attachmentController={attachments}
          l0Source={l0Sources?.[current.id]}
          openedHint={openedHints[current.id]}
          onOpenedHintChange={handleOpenedHintChange}
          reviewAttachments={reviewAttachments}
          feedback={currentFeedback}
          submittedAnswer={currentSubmittedAnswer}
          savedTakeaway={savedTakeaways[current.id]}
          onSavedTakeawayChange={handleSavedTakeawayChange}
          attemptId={submittedAttempt?.id}
          attemptRev={submittedAttempt?.rev}
          submitted={!!submittedAttempt}
          disabled={busy || !!submittedAttempt}
          onCite={onCiteToCompanion}
        />
      )}

      {preSubmitCardOpen && pitfalls.length > 0 && (
        <PreSubmitCheckCard
          pitfalls={pitfalls}
          onAnchor={inspectPreSubmitAnchor}
          onContinue={closePreSubmitCard}
          onConfirm={confirmPreSubmit}
        />
      )}

      {!submittedAttempt && (
        <div className="wbv2-submitbar">
          {attachments.lock.uploading > 0 && (
            <p className="lock-note" role="status">
              尚有 {attachments.lock.uploading} 张手写过程图正在上传，完成后即可交卷。
              {otherBlockedIndex >= 0 && (
                <button type="button" className="wbv2-jump" onClick={() => go(otherBlockedIndex)}>
                  前往第 {otherBlockedIndex + 1} 题
                </button>
              )}
            </p>
          )}
          {attachments.lock.failed > 0 && (
            <p className="lock-note" role="alert">
              有 {attachments.lock.failed} 张图片上传失败，请重试或移除后再交卷。
              {otherBlockedIndex >= 0 && (
                <button type="button" className="wbv2-jump" onClick={() => go(otherBlockedIndex)}>
                  前往第 {otherBlockedIndex + 1} 题
                </button>
              )}
            </p>
          )}
          {error && <p className="wbv2-error">{error}</p>}
          <div className="main">
            <button
              type="button"
              className="wbv2-submit"
              disabled={attachments.lock.locked || busy}
              onClick={beginSubmit}
            >
              {busy ? '交卷中…' : '交卷'}
            </button>
          </div>
        </div>
      )}
      {submittedAttempt && (
        <div className="wbv2-submitbar">
          <p className="wbv2-attach-note ok">
            已交卷{submittedAttempt.correctCount !== undefined && submittedAttempt.total
              ? `：答对 ${submittedAttempt.correctCount} / ${submittedAttempt.total}`
              : '，可在上方回看每题反馈与口诀对照。'}
          </p>
        </div>
      )}
    </div>
  );
}
