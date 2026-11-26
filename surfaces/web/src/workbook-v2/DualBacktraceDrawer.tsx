import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Message } from '../message.tsx';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeImageRef(ref: string | undefined): ref is string {
  if (!ref) return false;
  const trimmed = ref.trim();
  return (
    trimmed.startsWith('/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('blob:')
  );
}

function formatDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (match?.[1]) return match[1];
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const d = new Date(parsed);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeResult(raw: unknown): DualBacktraceResult | null {
  if (!isRecord(raw)) return null;
  const source = isRecord(raw.backtrace) ? raw.backtrace : isRecord(raw.dualBacktrace) ? raw.dualBacktrace : raw;
  const rawMistakes = Array.isArray(source.similarMistakes) ? source.similarMistakes : null;
  const rawSuccesses = Array.isArray(source.independentSuccesses) ? source.independentSuccesses : null;
  if (!rawMistakes && !rawSuccesses) return null;

  const similarMistakes: DualBacktraceSimilarMistake[] = [];
  for (const item of rawMistakes ?? []) {
    if (!isRecord(item) || !isRecord(item.evidence) || !isRecord(item.inference)) continue;
    const ev = item.evidence;
    const inf = item.inference;
    if (typeof ev.attemptId !== 'string' || typeof ev.questionId !== 'string') continue;
    similarMistakes.push(item as unknown as DualBacktraceSimilarMistake);
  }

  const independentSuccesses: DualBacktraceIndependentSuccess[] = [];
  for (const item of rawSuccesses ?? []) {
    if (!isRecord(item) || !isRecord(item.evidence) || !isRecord(item.inference)) continue;
    const ev = item.evidence;
    if (typeof ev.attemptId !== 'string' || typeof ev.questionId !== 'string') continue;
    // Enforce zero-contamination invariant: strictly unassisted successes only.
    if (ev.helpExposure !== 'none' && ev.helpExposure !== 'unexposed') continue;
    independentSuccesses.push(item as unknown as DualBacktraceIndependentSuccess);
  }

  const excludedRevokedCount =
    typeof source.excludedRevokedCount === 'number' &&
    Number.isSafeInteger(source.excludedRevokedCount) &&
    source.excludedRevokedCount > 0
      ? source.excludedRevokedCount
      : 0;

  return {
    ...(isRecord(source.target) ? { target: source.target as DualBacktraceTarget } : {}),
    similarMistakes,
    independentSuccesses,
    excludedRevokedCount,
  };
}

async function fetchOptionalBacktrace(
  url: string,
  signal: AbortSignal,
): Promise<{ readonly status: 'ready'; readonly data: DualBacktraceResult } | { readonly status: 'unavailable' }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return { status: 'unavailable' };
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('json')) {
      return { status: 'unavailable' };
    }
    const body: unknown = await response.json().catch(() => null);
    const normalized = normalizeResult(body);
    if (!normalized) return { status: 'unavailable' };
    return { status: 'ready', data: normalized };
  } catch {
    return { status: 'unavailable' };
  }
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
  return (
    <a className="wbv2-bt-link" href={href}>
      {label}
    </a>
  );
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

  const loadBacktrace = useCallback(async () => {
    if (hasInitialData) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setUnavailable(false);
    try {
      const outcome = await fetchOptionalBacktrace(resolvedEndpoint, controller.signal);
      if (controller.signal.aborted) return;
      if (outcome.status === 'ready') {
        setFetched(outcome.data);
      } else {
        setFetched(null);
        setUnavailable(true);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [hasInitialData, resolvedEndpoint]);

  useEffect(() => {
    if (!open) return;
    if (!hasInitialData) {
      void loadBacktrace();
    }
    return () => abortRef.current?.abort();
  }, [open, hasInitialData, loadBacktrace]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown, true);
      previousFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  const data = useMemo(() => {
    if (hasInitialData) return normalizeResult(initialData);
    return fetched;
  }, [fetched, hasInitialData, initialData]);

  if (!open) return null;

  const similarMistakes = data?.similarMistakes ?? [];
  const independentSuccesses = data?.independentSuccesses ?? [];
  const excludedRevokedCount = data?.excludedRevokedCount ?? 0;
  const bothEmpty = similarMistakes.length === 0 && independentSuccesses.length === 0;
  const headingLabel = questionNumber !== undefined
    ? `第 ${questionNumber} 题 · 双通道错因回溯`
    : questionTitle
      ? `${questionTitle} · 双通道错因回溯`
      : '错题双通道回溯';

  return (
    <div
      className="wbv2-bt-backdrop"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="wbv2-bt-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="wbv2-bt-head">
          <div className="wbv2-bt-head-copy">
            <span className="wbv2-bt-kicker">活数据矿山 · 双通道回溯</span>
            <h3 id={titleId} className="wbv2-bt-title">{headingLabel}</h3>
            {data && (
              <div className="wbv2-bt-summary-pills">
                <span className="wbv2-bt-chip wbv2-bt-chip--warn">
                  同类错法 {similarMistakes.length}
                </span>
                <span className="wbv2-bt-chip wbv2-bt-chip--ok">
                  独立做对先例 {independentSuccesses.length}
                </span>
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
                  <p className="wbv2-bt-channel-empty">
                    暂未检索到历史同类错法记录，这是一次新的错因样本。
                  </p>
                ) : (
                  <ul className="wbv2-bt-list">
                    {similarMistakes.map(item => {
                      const { evidence, inference } = item;
                      const stageLabel = inference.errorStage
                        ? ERROR_STAGE_LABELS[inference.errorStage] ?? inference.errorStage
                        : null;
                      const dateLabel = formatDate(evidence.submittedAt);
                      const helpLabel = HELP_EXPOSURE_LABELS[evidence.helpExposure] ?? evidence.helpExposure;
                      return (
                        <li key={`${evidence.attemptId}:${evidence.questionId}`} className="wbv2-bt-card">
                          <div className="wbv2-bt-card-meta">
                            {inference.crossChapter && (
                              <span className="wbv2-bt-chip wbv2-bt-chip--amber">跨章</span>
                            )}
                            {stageLabel && (
                              <span className="wbv2-bt-chip wbv2-bt-chip--warn">{stageLabel}</span>
                            )}
                            {inference.matchBasis.map(basis => (
                              <span key={basis} className="wbv2-bt-chip">
                                {MATCH_BASIS_LABELS[basis] ?? basis}
                              </span>
                            ))}
                            {evidence.chapterTitle && (
                              <span className="wbv2-bt-meta-text">{evidence.chapterTitle}</span>
                            )}
                            {dateLabel && (
                              <time className="wbv2-bt-meta-text" dateTime={dateLabel}>{dateLabel}</time>
                            )}
                          </div>

                          <div className="wbv2-bt-provenance wbv2-bt-provenance--evidence">
                            <div className="wbv2-bt-provenance-head">
                              <span className="wbv2-bt-provenance-tag">学习者证据</span>
                              <span className="wbv2-bt-meta-text">{helpLabel}</span>
                            </div>
                            {evidence.questionTitle && (
                              <p className="wbv2-bt-question-title">{evidence.questionTitle}</p>
                            )}
                            {evidence.learnerAnswer && (
                              <div className="wbv2-bt-answer-row">
                                <span>当时作答</span>
                                <div className="wbv2-bt-answer-val">
                                  <Message text={evidence.learnerAnswer} />
                                </div>
                              </div>
                            )}
                            {evidence.learnerQuote && (
                              <blockquote className="wbv2-bt-quote">
                                「{evidence.learnerQuote}」
                              </blockquote>
                            )}
                            {isSafeImageRef(evidence.sourceImageRef) && (
                              <div className="wbv2-bt-image-wrap">
                                <img src={evidence.sourceImageRef} alt={evidence.questionTitle ? `${evidence.questionTitle} 历史作答原图` : '历史作答原图'} loading="lazy" />
                              </div>
                            )}
                          </div>

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
                                    paperId,
                                    itemId: evidence.questionId,
                                    title: evidence.questionTitle ?? '历史同类错题',
                                    excerpt: [
                                      evidence.learnerQuote ? `原话：${evidence.learnerQuote}` : '',
                                      evidence.learnerAnswer ? `原答：${evidence.learnerAnswer}` : '',
                                      `机理：${inference.mechanismSummary}`,
                                    ]
                                      .filter(Boolean)
                                      .join(' · ')
                                      .slice(0, 240),
                                    focusLabel: '历史同类错法对照',
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
                    {independentSuccesses.map(item => {
                      const { evidence, inference } = item;
                      const dateLabel = formatDate(evidence.submittedAt);
                      return (
                        <li key={`${evidence.attemptId}:${evidence.questionId}`} className="wbv2-bt-card wbv2-bt-card--success">
                          <div className="wbv2-bt-card-meta">
                            <span className="wbv2-bt-chip wbv2-bt-chip--ok">无提示独立做对</span>
                            {inference.crossChapter && (
                              <span className="wbv2-bt-chip wbv2-bt-chip--amber">跨章</span>
                            )}
                            {inference.matchBasis.map(basis => (
                              <span key={basis} className="wbv2-bt-chip">
                                {MATCH_BASIS_LABELS[basis] ?? basis}
                              </span>
                            ))}
                            {evidence.chapterTitle && (
                              <span className="wbv2-bt-meta-text">{evidence.chapterTitle}</span>
                            )}
                            {dateLabel && (
                              <time className="wbv2-bt-meta-text" dateTime={dateLabel}>{dateLabel}</time>
                            )}
                          </div>

                          <div className="wbv2-bt-provenance wbv2-bt-provenance--bridge">
                            <div className="wbv2-bt-provenance-head">
                              <span className="wbv2-bt-provenance-tag wbv2-bt-provenance-tag--bridge">系统推断 · 迁移桥</span>
                            </div>
                            <p className="wbv2-bt-inference-text">{inference.transferBridge}</p>
                          </div>

                          <div className="wbv2-bt-provenance wbv2-bt-provenance--evidence">
                            <div className="wbv2-bt-provenance-head">
                              <span className="wbv2-bt-provenance-tag">学习者证据</span>
                              <span className="wbv2-bt-meta-text">独立作答原件</span>
                            </div>
                            {evidence.questionTitle && (
                              <p className="wbv2-bt-question-title">{evidence.questionTitle}</p>
                            )}
                            {evidence.learnerAnswer && (
                              <div className="wbv2-bt-answer-row">
                                <span>独立作答</span>
                                <div className="wbv2-bt-answer-val">
                                  <Message text={evidence.learnerAnswer} />
                                </div>
                              </div>
                            )}
                            {evidence.learnerQuote && (
                              <blockquote className="wbv2-bt-quote">
                                「{evidence.learnerQuote}」
                              </blockquote>
                            )}
                            {isSafeImageRef(evidence.sourceImageRef) && (
                              <div className="wbv2-bt-image-wrap">
                                <img src={evidence.sourceImageRef} alt={evidence.questionTitle ? `${evidence.questionTitle} 独立作答原图` : '独立作答原图'} loading="lazy" />
                              </div>
                            )}
                          </div>

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
                                    paperId,
                                    itemId: evidence.questionId,
                                    title: evidence.questionTitle ?? '独立做对先例题',
                                    excerpt: `${inference.transferBridge}${evidence.learnerAnswer ? ` · 当时作答：${evidence.learnerAnswer}` : ''}`.slice(0, 240),
                                    focusLabel: '独立做对迁移先例',
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
