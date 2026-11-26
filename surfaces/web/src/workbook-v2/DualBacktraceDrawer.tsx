import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Message } from '../message.tsx';
import { formatIsoDate } from '../shared/format-time.ts';
import { fetchOptionalJson, isRecord, readSafeInt, readTrimmed } from '../shared/safe-values.ts';
import type {
  DualBacktraceDrawerProps,
  DualBacktraceHelpExposure,
  DualBacktraceIndependentSuccess,
  DualBacktraceMistakeMatchBasis,
  DualBacktraceResult,
  DualBacktraceSimilarMistake,
  DualBacktraceTarget,
} from './types.ts';

const MATCH_BASIS_LABELS: Readonly<Record<DualBacktraceMistakeMatchBasis, string>> = {
  error_stage: '同错步机理',
  archetype: '同母题',
  variant_family: '同变式族',
  concept: '同概念',
  same_question: '同题',
};

const ERROR_STAGE_LABELS: Readonly<Record<string, string>> = {
  reading: '审题漏条件',
  modeling: '概念模型错误',
  strategy: '思路卡壳',
  execution: '计算或执行失误',
  expression: '表达规范丢分',
};

const HELP_EXPOSURE_LABELS: Readonly<Record<DualBacktraceHelpExposure, string>> = {
  none: '无提示独立作答',
  unexposed: '无提示独立作答',
  hint: '曾查看提示',
  solution_seen: '曾查看解析',
  worked_example: '曾对照例题',
  assisted: '有同伴协助',
  unknown: '协助情况未记',
};

function safeMatchBasisList(value: unknown): readonly DualBacktraceMistakeMatchBasis[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is DualBacktraceMistakeMatchBasis => typeof entry === 'string')
    : [];
}

function isSafeImageRef(ref: string | undefined): ref is string {
  const trimmed = readTrimmed(ref);
  if (!trimmed) return false;
  return (
    trimmed.startsWith('/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('blob:')
  );
}

type NormalizableEntry = {
  evidence: { attemptId: string; questionId: string; helpExposure?: unknown };
  inference: { matchBasis: readonly string[] };
};

function normalizeEntries<T extends NormalizableEntry>(
  rawList: unknown[] | null,
  requireUnassisted: boolean,
): T[] {
  const items: T[] = [];
  for (const item of rawList ?? []) {
    if (!isRecord(item) || !isRecord(item.evidence) || !isRecord(item.inference)) continue;
    const ev = item.evidence;
    const inf = item.inference;
    if (typeof ev.attemptId !== 'string' || typeof ev.questionId !== 'string') continue;
    // Enforce zero-contamination invariant: strictly unassisted successes only.
    if (requireUnassisted && ev.helpExposure !== 'none' && ev.helpExposure !== 'unexposed') continue;
    items.push({
      ...(item as unknown as T),
      inference: {
        ...(inf as unknown as T['inference']),
        matchBasis: Array.isArray(inf.matchBasis)
          ? inf.matchBasis.filter((b): b is string => typeof b === 'string')
          : [],
      },
    });
  }
  return items;
}

function normalizeResult(raw: unknown): DualBacktraceResult | null {
  if (!isRecord(raw)) return null;
  const source = isRecord(raw.backtrace) ? raw.backtrace : isRecord(raw.dualBacktrace) ? raw.dualBacktrace : raw;
  const rawMistakes = Array.isArray(source.similarMistakes) ? source.similarMistakes : null;
  const rawSuccesses = Array.isArray(source.independentSuccesses) ? source.independentSuccesses : null;
  if (!rawMistakes && !rawSuccesses) return null;

  return {
    ...(isRecord(source.target) ? { target: source.target as DualBacktraceTarget } : {}),
    similarMistakes: normalizeEntries<DualBacktraceSimilarMistake>(rawMistakes, false),
    independentSuccesses: normalizeEntries<DualBacktraceIndependentSuccess>(rawSuccesses, true),
    excludedRevokedCount: readSafeInt(source.excludedRevokedCount, 1) ?? 0,
  };
}

function QuestionOriginAction({
  questionId,
  label,
  onNavigateQuestion,
}: {
  readonly questionId: string;
  readonly label: string;
  readonly onNavigateQuestion?: ((href: string) => void) | undefined;
}) {
  if (!questionId.trim()) return null;
  const href = `/materials/records/${encodeURIComponent(questionId)}`;
  if (onNavigateQuestion) {
    return (
      <button type="button" className="wbv2-bt-link" onClick={() => onNavigateQuestion(href)}>
        {label}
      </button>
    );
  }
  return <a className="wbv2-bt-link" href={href}>{label}</a>;
}

type SharedEvidence = {
  readonly questionId: string;
  readonly paperId?: string | undefined;
  readonly chapterTitle?: string | undefined;
  readonly submittedAt?: string | undefined;
  readonly questionTitle?: string | undefined;
  readonly learnerAnswer?: string | undefined;
  readonly learnerQuote?: string | undefined;
  readonly sourceImageRef?: string | undefined;
};

function BacktraceCardMeta({
  leadChips,
  crossChapter,
  matchBasis,
  chapterTitle,
  submittedAt,
}: {
  readonly leadChips?: ReactNode;
  readonly crossChapter?: boolean | undefined;
  readonly matchBasis: readonly DualBacktraceMistakeMatchBasis[] | unknown;
  readonly chapterTitle?: string | undefined;
  readonly submittedAt?: string | undefined;
}) {
  const dateLabel = formatIsoDate(submittedAt);
  return (
    <div className="wbv2-bt-card-meta">
      {leadChips}
      {crossChapter && <span className="wbv2-bt-chip wbv2-bt-chip--amber">跨章</span>}
      {safeMatchBasisList(matchBasis).map((basis) => (
        <span key={basis} className="wbv2-bt-chip">
          {MATCH_BASIS_LABELS[basis] ?? basis}
        </span>
      ))}
      {chapterTitle && <span className="wbv2-bt-meta-text">{chapterTitle}</span>}
      {dateLabel && (
        <time className="wbv2-bt-meta-text" dateTime={dateLabel}>
          {dateLabel}
        </time>
      )}
    </div>
  );
}

function BacktraceEvidenceBlock({
  evidence,
  metaText,
  answerLabel,
  imageAltSuffix,
}: {
  readonly evidence: SharedEvidence;
  readonly metaText: string;
  readonly answerLabel: string;
  readonly imageAltSuffix: string;
}) {
  return (
    <div className="wbv2-bt-provenance wbv2-bt-provenance--evidence">
      <div className="wbv2-bt-provenance-head">
        <span className="wbv2-bt-provenance-tag">学习者证据</span>
        <span className="wbv2-bt-meta-text">{metaText}</span>
      </div>
      {evidence.questionTitle && <p className="wbv2-bt-question-title">{evidence.questionTitle}</p>}
      {evidence.learnerAnswer && (
        <div className="wbv2-bt-answer-row">
          <span>{answerLabel}</span>
          <div className="wbv2-bt-answer-val">
            <Message text={evidence.learnerAnswer} />
          </div>
        </div>
      )}
      {evidence.learnerQuote && <blockquote className="wbv2-bt-quote">「{evidence.learnerQuote}」</blockquote>}
      {isSafeImageRef(evidence.sourceImageRef) && (
        <div className="wbv2-bt-image-wrap">
          <img
            src={evidence.sourceImageRef}
            alt={evidence.questionTitle ? `${evidence.questionTitle} ${imageAltSuffix}` : imageAltSuffix}
            loading="lazy"
          />
        </div>
      )}
    </div>
  );
}

function resolveCitedPaperId(evidence: SharedEvidence, currentQuestionId: string, currentPaperId: string): string {
  return readTrimmed(evidence.paperId) ?? (evidence.questionId === currentQuestionId ? currentPaperId : '');
}

export function DualBacktraceDrawer({
  open,
  onClose,
  paperId,
  questionId,
  questionNumber,
  questionTitle,
  initialData,
  endpoint,
  onCite,
  onNavigateQuestion,
}: DualBacktraceDrawerProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const hasInitialData = initialData !== undefined && initialData !== null;
  const resolvedEndpoint =
    endpoint ?? `/api/papers/${encodeURIComponent(paperId)}/items/${encodeURIComponent(questionId)}/backtrace`;

  const [fetched, setFetched] = useState<DualBacktraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    abortRef.current?.abort();
    setFetched(null);
    setUnavailable(false);
    setLoading(false);
  }, [paperId, questionId, endpoint]);

  const loadBacktrace = useCallback(async () => {
    if (hasInitialData) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setUnavailable(false);
    try {
      const body = await fetchOptionalJson(resolvedEndpoint, controller.signal);
      if (controller.signal.aborted) return;
      const normalized = normalizeResult(body);
      setFetched(normalized);
      setUnavailable(normalized === null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [hasInitialData, resolvedEndpoint]);

  useEffect(() => {
    if (!open || hasInitialData) return;
    void loadBacktrace();
    return () => abortRef.current?.abort();
  }, [open, hasInitialData, loadBacktrace]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown, true);
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  const data = useMemo(
    () => (hasInitialData ? normalizeResult(initialData) : fetched),
    [fetched, hasInitialData, initialData],
  );

  if (!open) return null;

  const similarMistakes = data?.similarMistakes ?? [];
  const independentSuccesses = data?.independentSuccesses ?? [];
  const excludedRevokedCount = data?.excludedRevokedCount ?? 0;
  const bothEmpty = similarMistakes.length === 0 && independentSuccesses.length === 0;
  const headingLabel =
    questionNumber !== undefined
      ? `第 ${questionNumber} 题 · 双通道错因回溯`
      : questionTitle
        ? `${questionTitle} · 双通道错因回溯`
        : '错题双通道回溯';

  return (
    <div
      className="wbv2-bt-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="wbv2-bt-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="wbv2-bt-head">
          <div className="wbv2-bt-head-copy">
            <span className="wbv2-bt-kicker">活数据矿山 · 双通道回溯</span>
            <h3 id={titleId} className="wbv2-bt-title">{headingLabel}</h3>
            {data && (
              <div className="wbv2-bt-summary-pills">
                <span className="wbv2-bt-chip wbv2-bt-chip--warn">同类错法 {similarMistakes.length}</span>
                <span className="wbv2-bt-chip wbv2-bt-chip--ok">独立做对先例 {independentSuccesses.length}</span>
              </div>
            )}
          </div>
          <div className="wbv2-bt-head-actions">
            {!hasInitialData && (
              <button
                type="button"
                className="wbv2-bt-icon-btn"
                disabled={loading}
                onClick={() => void loadBacktrace()}
                aria-label="重新检索双通道回溯"
              >
                {loading ? '检索中…' : '刷新'}
              </button>
            )}
            <button
              ref={closeButtonRef}
              type="button"
              className="wbv2-bt-close"
              onClick={onClose}
              aria-label="关闭双通道回溯抽屉"
            >
              ×
            </button>
          </div>
        </header>

        <div className="wbv2-bt-body">
          {loading ? (
            <div className="wbv2-bt-empty" role="status">
              <p>正在从你的历史练习中检索同类错法与独立做对先例…</p>
            </div>
          ) : unavailable || (bothEmpty && data !== null) ? (
            <div className="wbv2-bt-empty" role="status">
              <h4>{unavailable ? '暂未获取到双通道回溯记录' : '当前还没有匹配的回溯先例'}</h4>
              <p>
                {unavailable
                  ? '该试卷的双通道回溯接口暂未返回历史记录；你可以先查看本题解析，或引用给学习同伴一起定位错因。'
                  : '你在同错步机理、同母题或同概念下尚未沉淀可对照的历史记录。继续完成独立练习后，系统会自动建立双通道对照。'}
              </p>
            </div>
          ) : (
            <>
              <section className="wbv2-bt-channel wbv2-bt-channel--mistake" aria-label="通道一：历史上同类错法">
                <div className="wbv2-bt-channel-head">
                  <span className="wbv2-bt-channel-badge wbv2-bt-channel-badge--warn">通道一 · 警惕复发</span>
                  <h4>历史上同类错法（{similarMistakes.length}）</h4>
                </div>
                {similarMistakes.length === 0 ? (
                  <p className="wbv2-bt-channel-empty">暂未检索到历史同类错法记录，这是一次新的错因样本。</p>
                ) : (
                  <ul className="wbv2-bt-list">
                    {similarMistakes.map(({ evidence, inference }) => {
                      const stageLabel = inference.errorStage
                        ? ERROR_STAGE_LABELS[inference.errorStage] ?? inference.errorStage
                        : null;
                      return (
                        <li key={`${evidence.attemptId}:${evidence.questionId}`} className="wbv2-bt-card">
                          <BacktraceCardMeta
                            leadChips={stageLabel && <span className="wbv2-bt-chip wbv2-bt-chip--warn">{stageLabel}</span>}
                            crossChapter={inference.crossChapter}
                            matchBasis={inference.matchBasis}
                            chapterTitle={evidence.chapterTitle}
                            submittedAt={evidence.submittedAt}
                          />
                          <BacktraceEvidenceBlock
                            evidence={evidence}
                            metaText={HELP_EXPOSURE_LABELS[evidence.helpExposure] ?? evidence.helpExposure}
                            answerLabel="当时作答"
                            imageAltSuffix="历史作答原图"
                          />
                          <div className="wbv2-bt-provenance wbv2-bt-provenance--inference">
                            <div className="wbv2-bt-provenance-head">
                              <span className="wbv2-bt-provenance-tag wbv2-bt-provenance-tag--infer">系统推断</span>
                              <span className="wbv2-bt-meta-text">错因机理摘要</span>
                            </div>
                            <p className="wbv2-bt-inference-text">{inference.mechanismSummary}</p>
                          </div>
                          <div className="wbv2-bt-card-actions">
                            <QuestionOriginAction
                              questionId={evidence.questionId}
                              label="查看历史原题"
                              onNavigateQuestion={onNavigateQuestion}
                            />
                            {onCite && (
                              <button
                                type="button"
                                className="wbv2-bt-link"
                                onClick={() =>
                                  onCite({
                                    kind: 'question',
                                    paperId: resolveCitedPaperId(evidence, questionId, paperId),
                                    itemId: evidence.questionId,
                                    title: evidence.questionTitle ?? '历史同类错题',
                                    excerpt: [
                                      evidence.chapterTitle ? `历史来源：${evidence.chapterTitle}` : '历史来源：过往作答记录',
                                      evidence.learnerQuote ? `原话：${evidence.learnerQuote}` : '',
                                      evidence.learnerAnswer ? `原答：${evidence.learnerAnswer}` : '',
                                      `机理：${inference.mechanismSummary}`,
                                    ]
                                      .filter(Boolean)
                                      .join(' · ')
                                      .slice(0, 240),
                                    focusLabel: evidence.chapterTitle
                                      ? `历史同类错法对照 · ${evidence.chapterTitle}`
                                      : '历史同类错法对照（历史来源）',
                                  })
                                }
                              >
                                引用到同伴
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="wbv2-bt-channel wbv2-bt-channel--success" aria-label="通道二：曾独立做对的成功原题">
                <div className="wbv2-bt-channel-head">
                  <span className="wbv2-bt-channel-badge wbv2-bt-channel-badge--ok">通道二 · 借力迁移</span>
                  <h4>曾独立做对的成功原题（{independentSuccesses.length}）</h4>
                </div>
                {independentSuccesses.length === 0 ? (
                  <p className="wbv2-bt-channel-empty">
                    暂未检索到无提示独立做对的可迁移原题；完成更多独立作答后会自动汇聚在此。
                  </p>
                ) : (
                  <ul className="wbv2-bt-list">
                    {independentSuccesses.map(({ evidence, inference }) => (
                      <li key={`${evidence.attemptId}:${evidence.questionId}`} className="wbv2-bt-card wbv2-bt-card--success">
                        <BacktraceCardMeta
                          leadChips={<span className="wbv2-bt-chip wbv2-bt-chip--ok">无提示独立做对</span>}
                          crossChapter={inference.crossChapter}
                          matchBasis={inference.matchBasis}
                          chapterTitle={evidence.chapterTitle}
                          submittedAt={evidence.submittedAt}
                        />
                        <div className="wbv2-bt-provenance wbv2-bt-provenance--bridge">
                          <div className="wbv2-bt-provenance-head">
                            <span className="wbv2-bt-provenance-tag wbv2-bt-provenance-tag--bridge">系统推断 · 迁移桥</span>
                          </div>
                          <p className="wbv2-bt-inference-text">{inference.transferBridge}</p>
                        </div>
                        <BacktraceEvidenceBlock
                          evidence={evidence}
                          metaText="独立作答原件"
                          answerLabel="独立作答"
                          imageAltSuffix="独立作答原图"
                        />
                        <div className="wbv2-bt-card-actions">
                          <QuestionOriginAction
                            questionId={evidence.questionId}
                            label="直达成功原题"
                            onNavigateQuestion={onNavigateQuestion}
                          />
                          {onCite && (
                            <button
                              type="button"
                              className="wbv2-bt-link"
                              onClick={() =>
                                onCite({
                                  kind: 'question',
                                  paperId: resolveCitedPaperId(evidence, questionId, paperId),
                                  itemId: evidence.questionId,
                                  title: evidence.questionTitle ?? '独立做对先例题',
                                  excerpt: [
                                    evidence.chapterTitle ? `历史来源：${evidence.chapterTitle}` : '历史来源：过往独立作答',
                                    inference.transferBridge,
                                    evidence.learnerAnswer ? `当时作答：${evidence.learnerAnswer}` : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')
                                    .slice(0, 240),
                                  focusLabel: evidence.chapterTitle
                                    ? `独立做对迁移先例 · ${evidence.chapterTitle}`
                                    : '独立做对迁移先例（历史来源）',
                                })
                              }
                            >
                              引用到同伴
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          {excludedRevokedCount > 0 && (
            <footer className="wbv2-bt-privacy-note" role="note">
              已依隐私授权自动排除 {excludedRevokedCount} 条已撤回记录
            </footer>
          )}
        </div>
      </aside>
    </div>
  );
}
