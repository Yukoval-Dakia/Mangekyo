import { useMemo } from 'react';
import MathText from '../math-text.tsx';
import type {
  CompanionCitation,
  Confidence,
  FocusedQuestion,
  L0Source,
  OpenedHintState,
  PendingAttachment,
  ReviewAttachment,
  SavedTakeawayState,
  WorkbookV2Feedback,
} from './types.ts';
import { ConfidenceSelector } from './ConfidenceSelector.tsx';
import {
  type PaperAttachmentController,
  QuestionAttachmentUploader,
  ReviewAttachmentWall,
  type UploadSummary,
} from './QuestionAttachmentUploader.tsx';
import { OwnWordsHint, OwnWordsTakeawayEditor, formatExpectedValue } from './OwnWordsTakeaway.tsx';

function excerptOf(prompt: string, max = 60): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function formatVerdict(result: string): { label: string; tone: 'ok' | 'warn' | 'info' } {
  if (result === 'correct') return { label: '答对了', tone: 'ok' };
  if (result === 'incorrect') return { label: '有偏差', tone: 'warn' };
  if (result === 'partial') return { label: '部分正确', tone: 'info' };
  if (result === 'pending') return { label: '待评阅', tone: 'info' };
  if (result === 'self-check') return { label: '请自查', tone: 'info' };
  return { label: '未作答', tone: 'info' };
}

function formatSubmittedAnswer(answer: string | number | null | undefined, fallback: string): string | null {
  if (typeof answer === 'number') return String(answer);
  if (typeof answer === 'string' && answer.trim()) return answer.trim();
  if (fallback.trim()) return fallback.trim();
  return null;
}

export function FocusedQuestionCard({
  paperId,
  paperRev,
  index,
  total,
  question,
  answer,
  onAnswer,
  confidence,
  onConfidence,
  attachmentController,
  onAttachments,
  registerAttachments,
  l0Source,
  openedHint,
  onOpenedHintChange,
  reviewAttachments,
  feedback,
  submittedAnswer,
  savedTakeaway,
  onSavedTakeawayChange,
  attemptId,
  attemptRev,
  submitted,
  disabled,
  onCite,
}: {
  paperId: string;
  paperRev?: number | undefined;
  index: number;
  total: number;
  question: FocusedQuestion;
  answer: string;
  onAnswer: (itemId: string, value: string) => void;
  confidence: Confidence | null;
  onConfidence: (itemId: string, value: Confidence | null) => void;
  attachmentController?: PaperAttachmentController | undefined;
  onAttachments?: ((itemId: string, attachments: readonly PendingAttachment[], summary: UploadSummary) => void) | undefined;
  registerAttachments?: ((itemId: string, restore: readonly PendingAttachment[] | null) => readonly PendingAttachment[]) | undefined;
  l0Source?: L0Source | undefined;
  openedHint?: OpenedHintState | null | undefined;
  onOpenedHintChange?: ((itemId: string, next: OpenedHintState) => void) | undefined;
  reviewAttachments?: readonly ReviewAttachment[] | undefined;
  feedback?: WorkbookV2Feedback | undefined;
  submittedAnswer?: string | number | null | undefined;
  savedTakeaway?: SavedTakeawayState | null | undefined;
  onSavedTakeawayChange?: ((itemId: string, next: SavedTakeawayState | null) => void) | undefined;
  attemptId?: string | undefined;
  attemptRev?: number | undefined;
  submitted: boolean;
  disabled?: boolean | undefined;
  onCite?: ((citation: CompanionCitation) => void) | undefined;
}) {
  const cite = useMemo<CompanionCitation>(
    () => ({
      kind: 'question',
      paperId,
      itemId: question.id,
      title: `第 ${index + 1} 题`,
      excerpt: excerptOf(question.prompt),
    }),
    [paperId, question.id, question.prompt, index],
  );

  const verdict = feedback ? formatVerdict(feedback.result) : null;
  const shownAnswer = formatSubmittedAnswer(submittedAnswer ?? feedback?.answer, answer);
  const formattedExpected = formatExpectedValue(feedback?.expected);

  return (
    <article className="wbv2-card" tabIndex={-1} data-wbv2-question-id={question.id} aria-label={`第 ${index + 1} 题，共 ${total} 题`}>
      <header className="wbv2-qhead">
        <span className="wbv2-qnum">
          <span className="wbv2-pill">第 {index + 1} / {total} 题</span>
          {submitted && verdict && <span className={`wbv2-verdict is-${verdict.tone}`}>{verdict.label}</span>}
        </span>
        {onCite && (
          <button type="button" className="wbv2-cite" onClick={() => onCite(cite)} title="引用此题到右侧同伴">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
              <path d="M8 11h8M8 15h5M21 12a9 9 0 1 1-4.4-7.7" strokeLinecap="round" />
              <path d="M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            引用到同伴
          </button>
        )}
      </header>

      <div className="wbv2-prompt">
        <MathText text={question.prompt} />
      </div>

      {!submitted ? (
        <>
          <div className="wbv2-answer">
            {question.kind === 'numeric' || question.kind === 'exact' ? (
              <input
                type="text"
                value={answer}
                disabled={disabled}
                placeholder="写下你的答案"
                onChange={(event) => onAnswer(question.id, event.currentTarget.value)}
                aria-label="答案"
              />
            ) : (
              <textarea
                value={answer}
                disabled={disabled}
                placeholder="写下你的解答过程与答案"
                onChange={(event) => onAnswer(question.id, event.currentTarget.value)}
                aria-label="解答"
              />
            )}
            {question.kind === 'numeric' && question.unit && <p className="wbv2-unit">单位：{question.unit}</p>}
          </div>

          <ConfidenceSelector value={confidence} onChange={(nextValue) => onConfidence(question.id, nextValue)} disabled={disabled} />

          <QuestionAttachmentUploader
            paperId={paperId}
            itemId={question.id}
            disabled={disabled}
            controller={attachmentController}
            onChange={onAttachments}
            register={registerAttachments}
          />

          <OwnWordsHint
            paperId={paperId}
            paperRev={paperRev}
            itemId={question.id}
            source={l0Source}
            submitted={submitted}
            initialOpened={openedHint}
            onOpenedChange={onOpenedHintChange ? (next) => onOpenedHintChange(question.id, next) : undefined}
          />
        </>
      ) : (
        <>
          {(shownAnswer || formattedExpected || feedback?.explanation) && (
            <section className="wbv2-feedback" aria-label="本题复盘">
              {shownAnswer && (
                <div className="wbv2-feedback-row">
                  <span className="wbv2-feedback-label">你的作答</span>
                  <div className="wbv2-feedback-value">{shownAnswer}</div>
                </div>
              )}
              {formattedExpected && (
                <div className="wbv2-feedback-row">
                  <span className="wbv2-feedback-label">参考答案</span>
                  <div className="wbv2-feedback-value">
                    <MathText text={formattedExpected} />
                  </div>
                </div>
              )}
              {feedback?.explanation && (
                <div className="wbv2-feedback-row">
                  <span className="wbv2-feedback-label">解析要点</span>
                  <div className="wbv2-feedback-value">
                    <MathText text={feedback.explanation} />
                  </div>
                </div>
              )}
            </section>
          )}
          {reviewAttachments && reviewAttachments.length > 0 && <ReviewAttachmentWall attachments={reviewAttachments} />}
          {attemptId && (
            <OwnWordsTakeawayEditor
              paperId={paperId}
              attemptId={attemptId}
              attemptRev={attemptRev}
              itemId={question.id}
              submitted={submitted}
              initialSaved={savedTakeaway}
              onSavedChange={onSavedTakeawayChange ? (next) => onSavedTakeawayChange(question.id, next) : undefined}
            />
          )}
        </>
      )}
    </article>
  );
}
