import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deletedSubmission, requestId, submissionId, type Settings } from '../api.ts';
import { forTask, selectedRoute } from '../model-route.ts';
import type { Resource } from '../workspace.tsx';
import { QuestionPresentation, useWorkbookPresentation } from '../workbook-presentation.tsx';
import { ApiError, assessRubric, isNotFound, loadPaper, loadPreSubmitPitfalls, markCorrected, submitAttempt } from './api.ts';
import type {
  CompanionCitation,
  Confidence,
  L0Source,
  OpenedHintState,
  QuestionAttachmentsPayload,
  SavedTakeawayState,
  PreSubmitPitfall,
  PreSubmitRevisionPayload,
  WorkbookV2Assessment,
  WorkbookV2Attempt,
  WorkbookV2Detail,
} from './types.ts';
import { usePaperAttachments } from './QuestionAttachmentUploader.tsx';
import { FocusedQuestionCard } from './FocusedQuestionCard.tsx';
import { ExamTimeValueBar } from './ExamTimeValueBar.tsx';
import { PreSubmitCheckCard } from './PreSubmitCheckCard.tsx';
import { authorIqdbQuestions, describeAuthoringError, describeAuthoringOrigin } from './api.ts';
import { AuthoringFeedback } from '../AuthoringFeedback.tsx';

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
  modelSettings,
}: {
  paperId: string;
  initialPaper?: WorkbookV2Detail | undefined;
  l0Sources?: Record<string, L0Source> | undefined;
  onCiteToCompanion?: ((citation: CompanionCitation) => void) | undefined;
  modelSettings?: Resource<Settings> | undefined;
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
  const [flaggedItems, setFlaggedItems] = useState<Set<string>>(() => new Set());
  const [pitfalls, setPitfalls] = useState<readonly PreSubmitPitfall[]>([]);
  const [preSubmitCardOpen, setPreSubmitCardOpen] = useState(false);
  const [preSubmitAcknowledged, setPreSubmitAcknowledged] = useState(false);
  const [preSubmitAnchors, setPreSubmitAnchors] = useState<Record<string, PreSubmitAnchorState>>({});
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const attachments = usePaperAttachments(paperId);
  const assessmentSettings = modelSettings?.data && forTask(modelSettings.data, 'assessment');
  const [assessingItem, setAssessingItem] = useState<string | null>(null);
  const [correctingItem, setCorrectingItem] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [variantBusy, setVariantBusy] = useState<'default' | 'force' | null>(null);
  const [variantError, setVariantError] = useState<ReturnType<typeof describeAuthoringError> | null>(null);
  const [variantOrigin, setVariantOrigin] = useState<string | null>(null);
  const [variantResult, setVariantResult] = useState<{ href: string; prompt?: string | undefined; hasPaper: boolean } | null>(null);

  const questions = paper?.questions ?? [];
  const total = questions.length;
  const current = questions[index];
  const feedbackByQuestion = useMemo(() => {
    const map = new Map<string, NonNullable<WorkbookV2Attempt['feedback']>[number]>();
    for (const row of submittedAttempt?.feedback ?? []) map.set(row.questionId, row);
    return map;
  }, [submittedAttempt]);
  const assessmentByQuestion = useMemo(() => {
    const map = new Map<string, WorkbookV2Assessment>();
    for (const row of submittedAttempt?.assessments ?? []) map.set(row.questionId, row);
    return map;
  }, [submittedAttempt]);
  const correctedItemIds = useMemo(
    () => new Set(submittedAttempt?.correctedItemIds ?? []),
    [submittedAttempt],
  );
  const correctionItemIds = useMemo(
    () => new Set(submittedAttempt?.correctionItemIds ?? []),
    [submittedAttempt],
  );
  const answeringItems = useMemo(
    () => (current && !submittedAttempt ? [current.id] : []),
    [current, submittedAttempt],
  );
  const questionPresentation = useWorkbookPresentation(paperId, paper?.revision, answeringItems);
  const historicalItems = useMemo(
    () => (current && submittedAttempt ? [current.id] : []),
    [current, submittedAttempt],
  );
  const historicalPresentation = useWorkbookPresentation(
    paperId,
    submittedAttempt?.paperRev,
    historicalItems,
    submittedAttempt ? { kind: 'question', attempt: submittedAttempt } : undefined,
  );
  const currentFeedback = current ? feedbackByQuestion.get(current.id) : undefined;
  const solutionEligible =
    currentFeedback?.expected !== undefined && currentFeedback.expected !== null &&
    !(typeof currentFeedback.expected === 'object' && currentFeedback.expected.kind === 'rubric');
  const solutionItems = useMemo(
    () => (submittedAttempt && current && solutionEligible && historicalPresentation.allowed ? [current.id] : []),
    [submittedAttempt, current, solutionEligible, historicalPresentation.allowed],
  );
  const solutionPresentation = useWorkbookPresentation(
    paperId,
    submittedAttempt?.paperRev,
    solutionItems,
    submittedAttempt ? { kind: 'solution', attempt: submittedAttempt } : undefined,
  );

  useEffect(() => {
    setIndex(0);
    setError('');
    setLoadError('');
    setOpenedHints({});
    setSavedTakeaways({});
    setSubmittedAttempt(null);
    setFlaggedItems(new Set());
    requestRef.current = submissionId();
    setPitfalls([]);
    setPreSubmitCardOpen(false);
    setPreSubmitAcknowledged(false);
    setPreSubmitAnchors({});
    attachments.resetAll();

    if (initialPaper && initialPaper.id === paperId) {
      setPaper(initialPaper);
      setItems(seedItemsFor(initialPaper));
      setSubmittedAttempt(initialPaper.attempts?.[0] ?? null);
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
          setSubmittedAttempt(loaded.attempts?.[0] ?? null);
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

  const toggleFlag = useCallback((itemId: string) => {
    setFlaggedItems((previous) => {
      const next = new Set(previous);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

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

  const refreshPaper = useCallback(async () => {
    const next = await loadPaper(paperId);
    setPaper(next);
    setSubmittedAttempt((previous) => {
      if (!previous) return next.attempts?.[0] ?? null;
      return next.attempts?.find((attempt) => attempt.id === previous.id) ?? next.attempts?.[0] ?? null;
    });
  }, [paperId]);

  const handleAssess = useCallback(async (itemId: string) => {
    if (!submittedAttempt || assessingItem || !assessmentSettings) return;
    setActionError('');
    setAssessingItem(itemId);
    try {
      const route = selectedRoute(assessmentSettings);
      const next = await assessRubric(paperId, submittedAttempt.id, {
        requestId: requestId(),
        questionId: itemId,
        consent: 'send-question-answer-rubric',
        providerBaseUrl: assessmentSettings.baseUrl,
        ...(route ? { route } : {}),
      });
      setPaper(next);
      setSubmittedAttempt((previous) =>
        next.attempts?.find((attempt) => attempt.id === previous?.id) ?? next.attempts?.[0] ?? null,
      );
    } catch (caught: unknown) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof Error ? caught.message : '批改没有完成。',
      );
    } finally {
      setAssessingItem(null);
    }
  }, [submittedAttempt, assessingItem, assessmentSettings, paperId]);

  const handleCorrect = useCallback(async (itemId: string, attemptRev: number) => {
    if (!submittedAttempt || correctingItem) return;
    setActionError('');
    setCorrectingItem(itemId);
    try {
      await markCorrected(paperId, submittedAttempt.id, {
        requestId: requestId(),
        attemptRev,
        itemId,
      });
      await refreshPaper();
    } catch (caught: unknown) {
      setActionError(
        deletedSubmission(caught)
          ? '删除状态已变化，请重新打开原作答。'
          : '未能记录订正。请重新打开原作答或重试。',
      );
    } finally {
      setCorrectingItem(null);
    }
  }, [submittedAttempt, correctingItem, paperId, refreshPaper]);

  const handleMistakeVariant = useCallback(async (forceGenerate = false) => {
    if (!current || !submittedAttempt || variantBusy !== null) return;
    setVariantBusy(forceGenerate ? 'force' : 'default');
    setVariantError(null);
    setVariantOrigin(null);
    setVariantResult(null);
    try {
      const result = await authorIqdbQuestions({
        requestId: requestId(),
        mode: 'mistake_variant',
        sourceQuestionId: current.id,
        attemptId: submittedAttempt.id,
        count: 1,
        issuePaper: true,
        ...(forceGenerate ? { forceGenerate: true } : {}),
      });
      setVariantOrigin(describeAuthoringOrigin(result));
      const paperHref = result.paperHref || (result.paperId ? `/papers/${encodeURIComponent(result.paperId)}` : '');
      const href = paperHref || result.questions[0]?.href;
      if (!href) throw new Error('变式回执未包含可打开的练习。');
      const prompt = result.questions[0]?.prompt?.trim();
      setVariantResult({
        href,
        hasPaper: Boolean(paperHref),
        ...(prompt ? { prompt } : {}),
      });
      window.location.assign(href);
    } catch (failure) {
      setVariantError(describeAuthoringError(failure));
    } finally {
      setVariantBusy(null);
    }
  }, [current, submittedAttempt, variantBusy]);

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

  useEffect(() => {
    setVariantError(null);
    setVariantOrigin(null);
    setVariantResult(null);
  }, [paperId, current?.id]);

  if (loadError) {
    return <div className="wbv2"><p className="wbv2-error">{loadError}</p></div>;
  }
  if (!paper) {
    return <div className="wbv2"><p className="wbv2-attach-note info">正在打开试卷…</p></div>;
  }

  const currentItem = current ? (items[current.id] ?? emptyItem()) : emptyItem();
  const reviewAttachments = current && submittedAttempt ? submittedAttempt.questionAttachments?.[current.id] : undefined;
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
  const reviewFeedback = currentFeedback && solutionEligible && !solutionPresentation.allowed
    ? { ...currentFeedback, expected: null, explanation: null }
    : currentFeedback;

  const currentAssessment = current ? assessmentByQuestion.get(current.id) : undefined;
  const currentCorrected = current ? correctedItemIds.has(current.id) : false;
  const currentAssessEligible =
    submittedAttempt !== null &&
    current?.kind === 'rubric' &&
    (currentFeedback?.answer !== null && currentFeedback?.answer !== undefined) &&
    (currentAssessment === undefined || currentAssessment.verdict === 'pending') &&
    Boolean(assessmentSettings);
  const currentCorrection =
    submittedAttempt !== null &&
    current !== undefined &&
    currentFeedback !== undefined &&
    (currentFeedback.result === 'incorrect' || currentFeedback.result === 'partial' ||
      currentAssessment?.verdict === 'incorrect' || currentAssessment?.verdict === 'partial') &&
    currentFeedback.answer !== null && currentFeedback.answer !== undefined &&
    correctionItemIds.has(current.id) &&
    typeof submittedAttempt.rev === 'number'
      ? { attemptRev: submittedAttempt.rev, recorded: currentCorrected }
      : undefined;

  const currentMistake = submittedAttempt !== null && current !== undefined &&
    (currentFeedback?.result === 'incorrect' || currentFeedback?.result === 'partial' ||
      currentAssessment?.verdict === 'incorrect' || currentAssessment?.verdict === 'partial');

  const attemptCurrentObject =
    submittedAttempt !== null &&
    typeof submittedAttempt.rev === 'number' &&
    Number.isSafeInteger(submittedAttempt.rev) &&
    submittedAttempt.rev > 0
      ? { kind: 'attempt' as const, id: submittedAttempt.id, rev: submittedAttempt.rev }
      : undefined;

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
            const questionAssessment = assessmentByQuestion.get(question.id);
            const isCorrected = correctedItemIds.has(question.id);
            const navVerdict = questionAssessment?.verdict ?? questionFeedback?.result;
            const flagged = flaggedItems.has(question.id);
            const classes = [
              'wbv2-num',
              answered.has(question.id) ? 'is-answered' : '',
              flagged ? 'is-flagged' : '',
              summary?.failed ? 'is-upload-error' : summary?.uploading ? 'is-uploading' : '',
              isCorrected
                ? 'is-correct'
                : navVerdict === 'correct'
                  ? 'is-correct'
                  : navVerdict === 'incorrect'
                  ? 'is-incorrect'
                  : navVerdict === 'partial'
                    ? 'is-partial'
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
                title={flagged ? `第 ${order + 1} 题 · 已标记存疑` : `第 ${order + 1} 题`}
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

      {current && !submittedAttempt && (
        <>
          {!questionPresentation.allowed && (
            <p className={questionPresentation.error ? 'wbv2-error' : 'wbv2-attach-note info'} role={questionPresentation.error ? 'alert' : 'status'}>
              {questionPresentation.error ?? '正在确认题面展示许可…'}
              {questionPresentation.error && (
                <button type="button" className="wbv2-jump" onClick={questionPresentation.retry}>
                  重试
                </button>
              )}
            </p>
          )}
          <QuestionPresentation value={questionPresentation.questionPermit}>
            {questionPresentation.allowed && (
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
                disabled={busy}
                submitted={false}
                onCite={onCiteToCompanion}
              />
            )}
          </QuestionPresentation>
        </>
      )}

      {current && submittedAttempt && (
        <>
          {!historicalPresentation.allowed && (
            <p className={historicalPresentation.error ? 'wbv2-error' : 'wbv2-attach-note info'} role={historicalPresentation.error ? 'alert' : 'status'}>
              {historicalPresentation.error ?? '正在确认历史题面展示许可…'}
              {historicalPresentation.error && (
                <button type="button" className="wbv2-jump" onClick={historicalPresentation.retry}>
                  重试
                </button>
              )}
            </p>
          )}
          <QuestionPresentation value={historicalPresentation.questionPermit}>
            {historicalPresentation.allowed && (
              <FocusedQuestionCard
                key={current.id}
                paperId={paperId}
                paperRev={submittedAttempt.paperRev ?? paper.revision}
                index={index}
                total={total}
                question={current}
                answer={currentItem.answer}
                onAnswer={(itemId, nextAnswer) => patchItem(itemId, { answer: nextAnswer })}
                confidence={currentItem.confidence}
                onConfidence={(itemId, nextConfidence) => patchItem(itemId, { confidence: nextConfidence })}
                attachmentController={attachments}
                reviewAttachments={reviewAttachments}
                feedback={reviewFeedback}
                submittedAnswer={currentSubmittedAnswer}
                savedTakeaway={savedTakeaways[current.id]}
                onSavedTakeawayChange={handleSavedTakeawayChange}
                attemptId={submittedAttempt.id}
                attemptRev={submittedAttempt.rev}
                assessment={currentAssessment}
                assessEligible={currentAssessEligible}
                assessing={assessingItem === current.id}
                onAssess={currentAssessEligible ? () => void handleAssess(current.id) : undefined}
                correction={currentCorrection}
                correctionBusy={correctingItem === current.id}
                onCorrect={currentCorrection ? () => void handleCorrect(current.id, currentCorrection.attemptRev) : undefined}
                submitted
                disabled
                onCite={onCiteToCompanion}
              />
            )}
          </QuestionPresentation>
          {solutionEligible && !solutionPresentation.allowed && historicalPresentation.allowed && (
            <p className={solutionPresentation.error ? 'wbv2-error' : 'wbv2-attach-note info'} role={solutionPresentation.error ? 'alert' : 'status'}>
              {solutionPresentation.error ?? '正在确认参考答案与解析展示许可…'}
              {solutionPresentation.error && (
                <button type="button" className="wbv2-jump" onClick={solutionPresentation.retry}>
                  重试
                </button>
              )}
            </p>
          )}
          {currentMistake && (
            <div className="wbv2-variant">
              <button
                type="button"
                className="wbv2-action"
                disabled={variantBusy !== null}
                onClick={() => void handleMistakeVariant(false)}
              >
                {variantBusy === 'default' ? '正在准备同构变式…' : '练一道同构变式'}
              </button>
              <button
                type="button"
                className="wbv2-action"
                disabled={variantBusy !== null}
                onClick={() => void handleMistakeVariant(true)}
              >
                {variantBusy === 'force' ? '正在重出新题…' : '重出新题'}
              </button>
              {variantBusy !== null && (
                <span className="wbv2-attach-note info" role="status">
                  {variantBusy === 'force'
                    ? '正在依据这道错题重新生成新练习，请稍候。'
                    : '正在依据这道错题准备同构练习，请稍候。'}
                </span>
              )}
              {(variantOrigin || variantResult) && (
                <div className="wbv2-variant-status" role="status">
                  <span>
                    {variantOrigin ?? '已备好同构变式'}
                    {variantResult?.prompt
                      ? ` · ${variantResult.prompt.replace(/\s+/g, ' ').slice(0, 80)}${variantResult.prompt.length > 80 ? '…' : ''}`
                      : ''}
                  </span>
                  {variantResult?.href && (
                    <a className="wbv2-jump" href={variantResult.href}>
                      {variantResult.hasPaper ? '打开练习' : '查看题目'}
                    </a>
                  )}
                </div>
              )}
              {variantError && <AuthoringFeedback error={variantError} className="wbv2-variant-error" linkClassName="wbv2-jump" />}
            </div>
          )}
        </>
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
        <div className="wbv2-submitbar wbv2-submitbar--sticky">
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
            <div className="wbv2-actionbar" role="toolbar" aria-label="本题操作">
              <button
                type="button"
                className="wbv2-action"
                disabled={index === 0}
                onClick={() => go(index - 1)}
              >
                ‹ 上一题
              </button>
              {current && (
                <button
                  type="button"
                  className="wbv2-action"
                  aria-pressed={flaggedItems.has(current.id)}
                  onClick={() => toggleFlag(current.id)}
                >
                  {flaggedItems.has(current.id) ? '取消存疑' : '标记存疑'}
                </button>
              )}
              {current && onCiteToCompanion && (
                <button
                  type="button"
                  className="wbv2-action wbv2-action--companion"
                  onClick={() =>
                    onCiteToCompanion({
                      kind: 'question',
                      paperId,
                      itemId: current.id,
                      title: `第 ${index + 1} 题`,
                      excerpt: current.prompt.replace(/\s+/g, ' ').trim().slice(0, 240),
                      focusLabel: paper?.title ?? `第 ${index + 1} 题`,
                      ...(attemptCurrentObject ? { currentObject: attemptCurrentObject } : {}),
                    })
                  }
                >
                  问同伴
                </button>
              )}
              <button
                type="button"
                className="wbv2-action"
                disabled={index >= total - 1}
                onClick={() => go(index + 1)}
              >
                下一题 ›
              </button>
            </div>
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
          {actionError && <p className="wbv2-error" role="alert">{actionError}</p>}
        </div>
      )}
    </div>
  );
}
