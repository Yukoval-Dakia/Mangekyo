import { useEffect, useMemo, useState } from 'react';
import {
  validateArtifact,
  type Answer,
  type Artifact,
  type ArtifactIntentV1,
} from '../../../shared/presentation/index.ts';
import { ArtifactView } from '../presentation/ArtifactView.tsx';
import { extractCalcBindingsFromUnknown } from '../presentation/CalcBindingBadge.tsx';
import { QuestionCalcBindings } from '../workbook-presentation.tsx';
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
  WorkbookV2Assessment,
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
import { CodeSandboxCard, detectCodeQuestion } from './CodeSandboxCard.tsx';
import {
  AssessTrigger,
  MarkCorrectedButton,
  RubricAssessmentCard,
  verdictMeta,
} from './RubricAssessmentCard.tsx';

const RUBRIC_PLACEHOLDER = '请独立完成并结合题目思路核对。';

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

const BOARD_BEGIN = '【交互画板作答】';
const BOARD_END = '【画板作答完】';

type BankSchemaField = { readonly path: string; readonly kind: string };
type BankSchemaSlot = { readonly slotId: string; readonly fields: readonly BankSchemaField[] };
type StructuredAnswerRow = {
  readonly slotId: string;
  readonly path: string;
  readonly value: Record<string, unknown>;
};

function bankSchemaSlots(question: FocusedQuestion): readonly BankSchemaSlot[] {
  if (question.kind !== 'bank' || !Array.isArray(question.responseSchema)) return [];
  const slots: BankSchemaSlot[] = [];
  for (const entry of question.responseSchema) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as { slotId?: unknown; fields?: unknown };
    if (typeof record.slotId !== 'string' || !record.slotId || !Array.isArray(record.fields)) continue;
    const fields: BankSchemaField[] = [];
    for (const field of record.fields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
      const item = field as { path?: unknown; kind?: unknown };
      if (typeof item.path === 'string' && typeof item.kind === 'string') {
        fields.push({ path: item.path, kind: item.kind });
      }
    }
    if (fields.length) slots.push({ slotId: record.slotId, fields });
  }
  return slots;
}

function isStructuredBankSchema(slots: readonly BankSchemaSlot[]): boolean {
  if (!slots.length) return false;
  if (slots.length === 1 && slots[0]!.fields.length === 1) {
    const only = slots[0]!.fields[0]!;
    if (only.kind === 'text' && only.path === '') return false;
  }
  return true;
}

function parseStructuredRows(raw: string): StructuredAnswerRow[] | null {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const rows: StructuredAnswerRow[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const row = entry as { slotId?: unknown; path?: unknown; value?: unknown };
      if (
        typeof row.slotId !== 'string' ||
        typeof row.path !== 'string' ||
        !row.value ||
        typeof row.value !== 'object' ||
        Array.isArray(row.value)
      ) {
        return null;
      }
      rows.push({ slotId: row.slotId, path: row.path, value: row.value as Record<string, unknown> });
    }
    return rows;
  } catch {
    return null;
  }
}

// 按后端 bankAnswers 契约编码结构化画板作答：[{ slotId, path, value }]，合并既有其它槽位。
function encodeStructuredBoardAnswers(
  slots: readonly BankSchemaSlot[],
  existing: string,
  answers: Record<string, Answer>,
): string | null {
  const incoming: StructuredAnswerRow[] = [];
  const removedKeys: { readonly slotId: string; readonly path: string }[] = [];
  for (const [slotId, answer] of Object.entries(answers)) {
    const slot = slots.find((candidate) => candidate.slotId === slotId);
    if (!slot) continue;
    const field = slot.fields.find((candidate) => candidate.path === '') ?? slot.fields[0];
    if (!field) continue;
    let value: Record<string, unknown> | null = null;
    if (answer.kind === 'selection') {
      if (field.kind !== 'structured') continue;
      value = { kind: 'structured', value: { kind: 'selection', ids: [...answer.ids] } };
    } else if (answer.kind === 'quantity') {
      if (field.kind !== 'numeric' && field.kind !== 'structured') continue;
      const unit = answer.unit.trim() || null;
      value =
        field.kind === 'numeric'
          ? { kind: 'numeric', value: answer.value, unit }
          : { kind: 'structured', value: { kind: 'range', value: answer.value, unit } };
    } else if (answer.kind === 'text') {
      if (field.kind !== 'text') continue;
      if (!answer.text.trim()) {
        removedKeys.push({ slotId: slot.slotId, path: field.path });
        continue;
      }
      value = { kind: 'text', value: answer.text };
    }
    if (value) incoming.push({ slotId: slot.slotId, path: field.path, value });
  }
  if (!incoming.length && !removedKeys.length) return null;
  const previous = parseStructuredRows(existing) ?? [];
  const kept = previous.filter(
    (row) =>
      !incoming.some((next) => next.slotId === row.slotId && next.path === row.path) &&
      !removedKeys.some((rem) => rem.slotId === row.slotId && rem.path === row.path),
  );
  const merged = [...kept, ...incoming];
  return merged.length > 0 ? JSON.stringify(merged) : '';
}

function formatSelectionIds(node: Artifact['sections'][number]['nodes'][number] | undefined, ids: readonly string[]): string {
  if (node?.kind === 'selection') {
    if (node.layout === 'passage') {
      return node.items.map((item) => item.label + (ids.includes(item.id) ? '／' : '')).join('') + node.tail;
    }
    return node.items.filter((item) => ids.includes(item.id)).map((item) => item.label).join('、') || '（未选择）';
  }
  return ids.join('、') || '（未选择）';
}

// 将结构化 bank 作答 JSON 格式化为人类可读摘要（供画板确认条与交卷复盘共用）。
function formatStructuredBankAnswer(raw: string, view: Artifact | null): string | null {
  const rows = parseStructuredRows(raw);
  if (!rows || !rows.length) return null;
  const nodes = view
    ? new Map(view.sections.flatMap((section) => section.nodes).map((node) => [node.id, node]))
    : new Map<string, Artifact['sections'][number]['nodes'][number]>();
  const lines: string[] = [];
  for (const row of rows) {
    const node = nodes.get(row.slotId);
    const label = node && 'label' in node ? node.label : `${row.slotId}${row.path}`;
    const val = row.value;
    if (val.kind === 'numeric' && typeof val.value === 'number') {
      const unit = typeof val.unit === 'string' && val.unit.trim() ? ` ${val.unit.trim()}` : '';
      lines.push(`${label}：${val.value}${unit}`);
    } else if (val.kind === 'text' && typeof val.value === 'string') {
      if (val.value.trim()) lines.push(`${label}：${val.value.trim()}`);
    } else if (val.kind === 'structured' && val.value && typeof val.value === 'object' && !Array.isArray(val.value)) {
      const structured = val.value as Record<string, unknown>;
      if ((structured.kind === 'selection' || structured.kind === 'breaks') && Array.isArray(structured.ids)) {
        const ids = structured.ids.filter((id): id is string => typeof id === 'string');
        lines.push(`${label}：${formatSelectionIds(node, ids)}`);
      } else if (structured.kind === 'range' && typeof structured.value === 'number') {
        const unit = typeof structured.unit === 'string' && structured.unit.trim() ? ` ${structured.unit.trim()}` : '';
        lines.push(`${label}：${structured.value}${unit}`);
      }
    }
  }
  return lines.length ? lines.join('\n') : null;
}

// 把画板动作的作答载荷映射为清晰可读的文本，写入纯文字题的交卷作答。
function describeBoardAnswers(view: Artifact, answers: Record<string, Answer>): string | null {
  const nodes = new Map(view.sections.flatMap(section => section.nodes).map(node => [node.id, node]));
  const lines: string[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    const node = nodes.get(id);
    if (!node || !('label' in node)) continue;
    if (answer.kind === 'quantity') {
      lines.push(`${node.label}：${answer.value} ${answer.unit}`);
    } else if (answer.kind === 'text') {
      if (answer.text.trim()) lines.push(`${node.label}：${answer.text.trim()}`);
    } else if (answer.kind === 'selection' && node.kind === 'selection') {
      lines.push(`${node.label}：${formatSelectionIds(node, answer.ids)}`);
    }
  }
  return lines.length ? lines.join('\n') : null;
}

// 画板作答块只替换上一轮完整块；学习者手写的补充说明始终原样保留。
function composeBoardAnswer(existing: string, board: string): string {
  const block = `${BOARD_BEGIN}\n${board}\n${BOARD_END}`;
  const begin = existing.indexOf(BOARD_BEGIN);
  const end = begin >= 0 ? existing.indexOf(BOARD_END, begin + BOARD_BEGIN.length) : -1;
  if (begin >= 0 && end > begin) {
    const stripped = (existing.slice(0, begin) + existing.slice(end + BOARD_END.length)).trim();
    return stripped ? `${block}\n\n${stripped}` : block;
  }
  const supplement = existing.trim();
  return supplement ? `${block}\n\n${supplement}` : block;
}

// P2-3：参考答案为空或默认占位语时不展示「参考答案」区块。
function showExpected(expected: string | WorkbookV2Feedback['expected'] | null | undefined): boolean {
  if (expected === null || expected === undefined) return false;
  if (typeof expected === 'string') {
    const trimmed = expected.trim();
    return trimmed !== '' && trimmed !== RUBRIC_PLACEHOLDER;
  }
  if (expected.kind === 'rubric') {
    const trimmed = expected.rubric.trim();
    return trimmed !== '' && trimmed !== RUBRIC_PLACEHOLDER;
  }
  return true;
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
  assessment,
  assessEligible,
  assessing,
  onAssess,
  correction,
  correctionBusy,
  onCorrect,
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
  assessment?: WorkbookV2Assessment | undefined;
  assessEligible?: boolean | undefined;
  assessing?: boolean | undefined;
  onAssess?: (() => void) | undefined;
  correction?: { attemptRev: number; recorded: boolean } | undefined;
  correctionBusy?: boolean | undefined;
  onCorrect?: (() => void) | undefined;
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

  // 交互画板题：interaction 校验为合法 Artifact v1 时在作答区直接渲染。
  const artifact = useMemo(() => {
    if (question.kind !== 'bank' || question.interaction === null || question.interaction === undefined) return null;
    const result = validateArtifact(question.interaction);
    return result.ok ? result.view : null;
  }, [question]);
  const schemaSlots = useMemo(() => bankSchemaSlots(question), [question]);
  const codeQuestion = useMemo(() => detectCodeQuestion(question), [question]);
  const isStructuredBank = useMemo(() => isStructuredBankSchema(schemaSlots), [schemaSlots]);
  const sandboxResult = submitted
    ? (assessment?.sandboxResult ??
      assessment?.codeSandboxResult ??
      feedback?.sandboxResult ??
      feedback?.codeSandboxResult)
    : undefined;
  const lockedActions = useMemo(() => {
    if (!artifact || !submitted) return undefined;
    return Object.fromEntries(
      artifact.sections
        .flatMap(section => section.nodes)
        .filter(node => node.kind === 'action')
        .map(node => [node.id, '本题已交卷，画板仅作回看。']),
    );
  }, [artifact, submitted]);
  const structuredBoardSummary = useMemo(
    () => (isStructuredBank ? formatStructuredBankAnswer(answer, artifact) : null),
    [isStructuredBank, answer, artifact],
  );
  const boardRecorded = isStructuredBank ? structuredBoardSummary !== null : answer.includes(BOARD_BEGIN);

  function captureBoardAction(request: ArtifactIntentV1) {
    if (!artifact) return;
    if (isStructuredBank) {
      const encoded = encodeStructuredBoardAnswers(schemaSlots, answer, request.action.answers);
      if (encoded !== null) onAnswer(question.id, encoded);
      return;
    }
    const board = describeBoardAnswers(artifact, request.action.answers);
    if (!board) return;
    onAnswer(question.id, composeBoardAnswer(answer, board));
  }

  const rubricVerdict = verdictMeta(assessment);
  const corrected = correction?.recorded === true;
  const verdict = corrected
    ? { label: '已订正', tone: 'ok' as const }
    : rubricVerdict ?? (feedback ? formatVerdict(feedback.result) : null);
  const rawShownAnswer = formatSubmittedAnswer(submittedAnswer ?? feedback?.answer, answer);
  const shownAnswer =
    rawShownAnswer && isStructuredBank
      ? formatStructuredBankAnswer(rawShownAnswer, artifact) ?? rawShownAnswer
      : rawShownAnswer;
  const formattedExpected = showExpected(feedback?.expected) ? formatExpectedValue(feedback?.expected) : null;

  const scratchKey = `wbv2-scratch:${paperId}:${question.id}`;
  const [scratch, setScratch] = useState(() => {
    try { return localStorage.getItem(scratchKey) ?? ''; } catch { return ''; }
  });
  useEffect(() => {
    try { setScratch(localStorage.getItem(scratchKey) ?? ''); } catch { setScratch(''); }
  }, [scratchKey]);
  function updateScratch(value: string) {
    setScratch(value);
    try {
      if (value) localStorage.setItem(scratchKey, value);
      else localStorage.removeItem(scratchKey);
    } catch {
      // localStorage 不可用时仅保留内存草稿。
    }
  }

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

      {(() => {
        const questionCalc = extractCalcBindingsFromUnknown(question);
        return (
          <QuestionCalcBindings
            itemId={question.id}
            bindings={questionCalc?.bindings}
            verification={questionCalc?.verification}
          />
        );
      })()}

      {artifact && (
        <div className="wbv2-artifact">
          <ArtifactView
            view={artifact}
            mount={{ mountId: `workbook-${paperId}-${question.id}`, stateRev: 0 }}
            unavailable={lockedActions}
            onAction={(request) => {
              if (!submitted) captureBoardAction(request);
            }}
          />
          {!submitted && isStructuredBank ? (
            <div className="wbv2-board-note" role="status">
              {structuredBoardSummary ? (
                <>
                  <span>已记录画板作答，可直接交卷：</span>
                  {structuredBoardSummary.split('\n').map((line, lineIndex) => (
                    <div key={lineIndex}>{line}</div>
                  ))}
                </>
              ) : (
                <span>请在上方交互画板完成操作并点击画板提交按钮记录作答。</span>
              )}
            </div>
          ) : !submitted && boardRecorded ? (
            <p className="wbv2-board-note" role="status">
              已记录画板作答，可补充说明或直接交卷。
            </p>
          ) : null}
        </div>
      )}

      {!submitted ? (
        <>
          {codeQuestion ? (
            <CodeSandboxCard
              spec={codeQuestion}
              rawAnswer={answer}
              onRawAnswerChange={(encoded) => onAnswer(question.id, encoded)}
              submitted={false}
              disabled={disabled}
              sandboxResult={undefined}
            />
          ) : !(isStructuredBank && artifact) ? (
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
          ) : null}

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

          <details className="wbv2-scratch">
            <summary>
              草稿 / 解题思路
              {scratch.trim() ? <span className="wbv2-scratch-badge">有草稿</span> : null}
            </summary>
            <div className="wbv2-scratch-body">
              <textarea
                rows={4}
                maxLength={4000}
                value={scratch}
                disabled={disabled}
                placeholder="在这里推演、列式、记疑点…（仅保存在这台电脑上）"
                onChange={(event) => updateScratch(event.currentTarget.value)}
              />
              <div className="wbv2-scratch-foot">
                <span className="wbv2-scratch-hint">
                  {scratch.trim() ? `${scratch.trim().length} 字 · 本机自动保存` : '本机自动保存'}
                </span>
                <button type="button" className="wbv2-scratch-clear" disabled={disabled || !scratch} onClick={() => updateScratch('')}>
                  清空草稿
                </button>
              </div>
            </div>
          </details>
        </>
      ) : (
        <>
          {codeQuestion && (
            <CodeSandboxCard
              spec={codeQuestion}
              rawAnswer={answer}
              submittedRawAnswer={rawShownAnswer}
              onRawAnswerChange={(encoded) => onAnswer(question.id, encoded)}
              submitted
              disabled={disabled}
              sandboxResult={sandboxResult}
            />
          )}
          {((!codeQuestion && shownAnswer) || formattedExpected || feedback?.explanation) && (
            <section className="wbv2-feedback" aria-label="本题复盘">
              {!codeQuestion && shownAnswer && (
                <div className="wbv2-feedback-row">
                  <span className="wbv2-feedback-label">你的作答</span>
                  <div className="wbv2-feedback-value">
                    {shownAnswer.includes('\n')
                      ? shownAnswer.split('\n').map((line, lineIndex) => <div key={lineIndex}>{line}</div>)
                      : shownAnswer}
                  </div>
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
          {assessment && <RubricAssessmentCard assessment={assessment} />}
          {assessEligible && onAssess && (
            <AssessTrigger assessing={assessing === true} onAssess={onAssess} />
          )}
          {correction && onCorrect && (
            <div className="wbv2-correction-row">
              <MarkCorrectedButton
                busy={correctionBusy === true}
                recorded={corrected}
                onMark={onCorrect}
              />
            </div>
          )}
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
