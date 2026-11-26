import { useState } from 'react';
import {
  authorIqdbQuestions,
  describeAuthoringError,
  describeAuthoringOrigin,
  requestId,
  type AuthoringUiError,
  type QuestionSelectionPlan,
  type SelectionPlanCoverageItem,
  type SelectionPlanEliminatedItem,
  type SelectionPlanGapItem,
  type SelectionPlanSelectedItem,
} from './api.ts';
import { AuthoringFeedback } from './AuthoringFeedback.tsx';
import { QuestionFormatPicker, useQuestionFormat } from './QuestionFormatPicker.tsx';
import { navigateHref } from './shared/safe-navigation.ts';
import { isRecord, readArray, readNumber, readRawString, readStringList } from './shared/safe-values.ts';
import './selection-plan.css';

type LegacyCoverage = { target: string; status: 'mentioned' | 'unconfirmed' };

interface NormalizedPlan {
  readonly selected: readonly SelectionPlanSelectedItem[];
  readonly eliminated: readonly SelectionPlanEliminatedItem[];
  readonly estimatedMinutes: number | null;
  readonly coverageReport: readonly SelectionPlanCoverageItem[];
  readonly gaps: readonly SelectionPlanGapItem[];
  readonly deriverStatus: QuestionSelectionPlan['deriverStatus'] | null;
  readonly exposureLockCount: number;
  readonly legacyCoverage: readonly LegacyCoverage[];
  readonly legacyGaps: readonly string[];
}

const EMPTY_NORMALIZED: NormalizedPlan = {
  selected: [],
  eliminated: [],
  estimatedMinutes: null,
  coverageReport: [],
  gaps: [],
  deriverStatus: null,
  exposureLockCount: 0,
  legacyCoverage: [],
  legacyGaps: [],
};

function selectedItemOf(value: unknown): SelectionPlanSelectedItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return null;
  const uncertainty = isRecord(value.uncertainty)
    ? value.uncertainty.kind === 'unknown'
      ? {
          kind: 'unknown' as const,
          reason: readRawString(value.uncertainty.reason),
          needed: readRawString(value.uncertainty.needed),
        }
      : value.uncertainty.kind === 'interval'
        ? {
            kind: 'interval' as const,
            low: readNumber(value.uncertainty.low) ?? 0,
            high: readNumber(value.uncertainty.high) ?? 0,
          }
        : null
    : null;
  return {
    id: value.id,
    rev: readNumber(value.rev) ?? 0,
    title: value.title,
    prompt: readRawString(value.prompt),
    estMin: readNumber(value.estMin) ?? 0,
    infoGain: readNumber(value.infoGain) ?? null,
    reasonCode: readRawString(value.reasonCode) as SelectionPlanSelectedItem['reasonCode'],
    reasonLabel: readRawString(value.reasonLabel) || '入选',
    uncertainty,
    coveredConcepts: readStringList(value.coveredConcepts),
    matchReasons: readStringList(value.matchReasons),
    score: readNumber(value.score) ?? 0,
    novelty: readRawString(value.novelty) as SelectionPlanSelectedItem['novelty'],
  };
}

function eliminatedItemOf(value: unknown): SelectionPlanEliminatedItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return null;
  const detail = readRawString(value.detail);
  if (!detail) return null;
  const estMin = readNumber(value.estMin);
  const infoGain = readNumber(value.infoGain);
  return {
    id: value.id,
    rev: readNumber(value.rev) ?? 0,
    title: value.title,
    reasonCode: readRawString(value.reasonCode) as SelectionPlanEliminatedItem['reasonCode'],
    reasonLabel: readRawString(value.reasonLabel) || '未入选',
    detail,
    ...(estMin !== undefined ? { estMin } : {}),
    ...(value.infoGain === null || infoGain !== undefined ? { infoGain: infoGain ?? null } : {}),
  };
}

function coverageItemOf(value: unknown): SelectionPlanCoverageItem | null {
  if (!isRecord(value) || typeof value.target !== 'string' || !value.target.trim()) return null;
  return {
    target: value.target,
    ...(typeof value.conceptId === 'string' && value.conceptId ? { conceptId: value.conceptId } : {}),
    status: readRawString(value.status) as SelectionPlanCoverageItem['status'],
    statusLabel: readRawString(value.statusLabel) || '覆盖情况待核对',
    matchedQuestionIds: readStringList(value.matchedQuestionIds),
  };
}

function gapItemOf(value: unknown): SelectionPlanGapItem | null {
  if (!isRecord(value) || typeof value.detail !== 'string' || !value.detail.trim()) return null;
  const kind = readRawString(value.kind);
  if (!kind) return null;
  return {
    kind: kind as SelectionPlanGapItem['kind'],
    ...(typeof value.target === 'string' && value.target ? { target: value.target } : {}),
    ...(typeof value.conceptId === 'string' && value.conceptId ? { conceptId: value.conceptId } : {}),
    ...(typeof value.errorStage === 'string' && value.errorStage ? { errorStage: value.errorStage } : {}),
    detail: value.detail,
    ...(value.suggestedAction === 'author_concept_gap' || value.suggestedAction === 'author_mistake_variant'
      ? { suggestedAction: value.suggestedAction }
      : {}),
  };
}

function deriverStatusOf(value: unknown): QuestionSelectionPlan['deriverStatus'] | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'ok' && value.methodVersion === 'plan/information-gain@1') {
    return { kind: 'ok', methodVersion: 'plan/information-gain@1' };
  }
  if (value.kind === 'unavailable') {
    return { kind: 'unavailable', reason: readRawString(value.reason) || '信息增益计算引擎不可用' };
  }
  return null;
}

function planOf(value: unknown): QuestionSelectionPlan | null {
  if (!isRecord(value)) return null;
  const selected = readArray(value.selected, selectedItemOf);
  const eliminated = readArray(value.eliminated, eliminatedItemOf);
  const coverageReport = readArray(value.coverageReport, coverageItemOf);
  const gaps = readArray(value.gaps, gapItemOf);
  const estimatedMinutes = readNumber(value.estimatedMinutes) ?? null;
  const deriverStatus = deriverStatusOf(value.deriverStatus);
  const exposureLockCount = readNumber(value.exposureLockCount) ?? 0;
  const looksStructured =
    Array.isArray(value.selected) ||
    Array.isArray(value.eliminated) ||
    Array.isArray(value.coverageReport) ||
    estimatedMinutes !== null ||
    deriverStatus !== null ||
    exposureLockCount > 0 ||
    gaps.length > 0;
  if (!looksStructured) return null;
  return {
    selected,
    eliminated,
    estimatedMinutes: estimatedMinutes ?? 0,
    coverageReport,
    gaps,
    deriverStatus: deriverStatus ?? { kind: 'unavailable', reason: '选题方案未附带信息增益引擎状态' },
    exposureLockCount,
  };
}

/** 同时兼容增强版（selectionPlan / 顶层增强字段）与旧版（字符串 gaps + coverage）提案载荷。 */
export function normalizePlanSource(source: unknown): NormalizedPlan {
  if (!isRecord(source)) return EMPTY_NORMALIZED;
  const nested = planOf(source.selectionPlan);
  const plan = nested ?? planOf(source);

  if (!plan) {
    const legacyCoverage = readArray<LegacyCoverage>(source.coverage, (item) =>
      isRecord(item) && typeof item.target === 'string' && item.target.trim()
        ? { target: item.target, status: item.status === 'mentioned' ? 'mentioned' : 'unconfirmed' }
        : null,
    );
    return { ...EMPTY_NORMALIZED, legacyCoverage, legacyGaps: readStringList(source.gaps) };
  }
  const minutesPresent = typeof plan.estimatedMinutes === 'number' && Number.isFinite(plan.estimatedMinutes);
  return {
    selected: plan.selected,
    eliminated: plan.eliminated,
    estimatedMinutes: minutesPresent ? plan.estimatedMinutes : null,
    coverageReport: plan.coverageReport,
    gaps: plan.gaps,
    deriverStatus: plan.deriverStatus,
    exposureLockCount: plan.exposureLockCount,
    legacyCoverage: [],
    legacyGaps: [],
  };
}

const legacyGapLabels: Record<string, string> = {
  duration_unestimated: '当前缺少完成这些题目的用时估计。',
  coverage_unconfirmed: '目标覆盖还需核对。',
  no_matching_question: '没有找到相符题目，可修改覆盖关键词或勾选题目。',
  question_unavailable: '原提案中有题目或版本已不可用。',
  needs_verification: '部分题目仍需独立核验。',
  restricted: '部分题目已限制发放。',
  draft: '部分题目仍是草稿。',
};

function gapActionKind(gap: SelectionPlanGapItem): 'concept' | 'variant' | null {
  if (gap.kind === 'zero_question_concept' || gap.suggestedAction === 'author_concept_gap') return 'concept';
  if (gap.kind === 'all_exposed_need_variant' || gap.suggestedAction === 'author_mistake_variant') return 'variant';
  return null;
}

function CoverageRow({ item }: { item: SelectionPlanCoverageItem }) {
  return (
    <li className="spp-coverage-item">
      <span className="spp-coverage-target">{item.target}</span>
      <span className={`spp-pill spp-coverage-${item.status}`}>{item.statusLabel}</span>
    </li>
  );
}

export function SelectionPlanPanel({
  source,
  onNavigate,
}: {
  source: unknown;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const plan = normalizePlanSource(source);
  const [format, setFormat] = useQuestionFormat();
  const [busyGap, setBusyGap] = useState<number | null>(null);
  const [gapError, setGapError] = useState<{ index: number; error: AuthoringUiError } | null>(null);
  const [gapResult, setGapResult] = useState<{ index: number; text: string } | null>(null);

  const hasEnhanced =
    plan.estimatedMinutes !== null ||
    plan.exposureLockCount > 0 ||
    plan.deriverStatus !== null ||
    plan.selected.length > 0 ||
    plan.eliminated.length > 0 ||
    plan.coverageReport.length > 0 ||
    plan.gaps.length > 0;
  const hasLegacy = plan.legacyCoverage.length > 0 || plan.legacyGaps.length > 0;
  if (!hasEnhanced && !hasLegacy) return null;

  const navigate = (href: string) => navigateHref(href, onNavigate);

  async function fillGap(gap: SelectionPlanGapItem, index: number) {
    if (busyGap !== null) return;
    const action = gapActionKind(gap);
    if (!action) return;
    setBusyGap(index);
    setGapError(null);
    setGapResult(null);
    try {
      // 后端 mistake_variant 需绑定原错题；缺口面板没有原题上下文，
      // 统一走 concept_gap 出题（同族变式缺口同样靠它补出未曝光新题）。
      const result = await authorIqdbQuestions({
        requestId: requestId(),
        mode: 'concept_gap',
        ...(gap.conceptId ? { conceptId: gap.conceptId } : {}),
        format,
        count: 2,
        issuePaper: true,
      });
      const paperHref = result.paperHref || (result.paperId ? `/papers/${encodeURIComponent(result.paperId)}` : '');
      const href = paperHref || result.questions[0]?.href || '';
      if (href) {
        navigate(href);
        return;
      }
      if (!result.questions.length) throw new Error('出题回执没有返回新题，请稍后重试。');
      const origin = describeAuthoringOrigin(result);
      setGapResult({
        index,
        text: `${origin ? `${origin} · ` : ''}已生成 ${result.questions.length} 道补缺题，可在题库中查看。`,
      });
    } catch (failure) {
      setGapError({ index, error: describeAuthoringError(failure) });
    } finally {
      setBusyGap(null);
    }
  }

  const hasActionableGap = plan.gaps.some(gap => gapActionKind(gap) !== null);

  return (
    <div className="spp">
      {(plan.estimatedMinutes !== null || plan.exposureLockCount > 0 || plan.deriverStatus?.kind === 'unavailable') && (
        <div className="spp-overview">
          {plan.estimatedMinutes !== null && (
            <span className="spp-meta">预计 {plan.estimatedMinutes} 分钟</span>
          )}
          {plan.exposureLockCount > 0 && (
            <span className="spp-meta">已避开 {plan.exposureLockCount} 道已曝光/剧透题</span>
          )}
          {plan.deriverStatus?.kind === 'unavailable' && (
            <span className="spp-meta spp-meta-honest">当前未连接信息增益计算引擎，已按语义与概念覆盖排序</span>
          )}
        </div>
      )}

      {plan.selected.length > 0 && (
        <section className="spp-section" aria-label="为什么选这些题">
          <h4 className="spp-heading">为什么选这些题</h4>
          <ul className="spp-selected">
            {plan.selected.map(item => (
              <li key={`${item.id}:${item.rev}`} className="spp-selected-item">
                <div className="spp-item-head">
                  <span className="spp-item-title">{item.title}</span>
                  <span className="spp-item-meta">{item.estMin} 分钟</span>
                  {item.infoGain !== null && (
                    <span className="spp-pill spp-pill-gain">信息增益 {item.infoGain.toFixed(2)}</span>
                  )}
                  <span className="spp-pill">{item.reasonLabel}</span>
                </div>
                {(item.coveredConcepts.length > 0 || item.matchReasons.length > 0) && (
                  <div className="spp-tags">
                    {item.coveredConcepts.map(concept => (
                      <span key={`c:${concept}`} className="spp-tag">{concept}</span>
                    ))}
                    {item.matchReasons.map(reason => (
                      <span key={`m:${reason}`} className="spp-tag spp-tag-reason">{reason}</span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.eliminated.length > 0 && (
        <details className="spp-eliminated">
          <summary>淘汰了哪几道（{plan.eliminated.length}）</summary>
          <ul>
            {plan.eliminated.map(item => (
              <li key={`${item.id}:${item.rev}`} className="spp-eliminated-item">
                <div className="spp-item-head">
                  <span className="spp-item-title">{item.title}</span>
                  <span className="spp-pill spp-pill-out">{item.reasonLabel}</span>
                </div>
                <p className="spp-eliminated-detail">{item.detail}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {plan.coverageReport.length > 0 && (
        <section className="spp-section" aria-label="覆盖目标">
          <h4 className="spp-heading">覆盖目标</h4>
          <ul className="spp-coverage">
            {plan.coverageReport.map(item => (
              <CoverageRow key={item.conceptId ?? item.target} item={item} />
            ))}
          </ul>
        </section>
      )}

      {plan.legacyCoverage.length > 0 && (
        <section className="spp-section" aria-label="覆盖目标">
          <h4 className="spp-heading">覆盖目标</h4>
          <ul className="spp-coverage">
            {plan.legacyCoverage.map(item => (
              <li key={item.target} className="spp-coverage-item">
                <span className="spp-coverage-target">{item.target}</span>
                <span className="spp-pill">{item.status === 'mentioned' ? '题名或题面提及' : '尚未确认'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.gaps.length > 0 && (
        <section className="spp-section" aria-label="缺口与一键补缺">
          <h4 className="spp-heading">缺口</h4>
          <ul className="spp-gaps">
            {plan.gaps.map((gap, index) => {
              const action = gapActionKind(gap);
              return (
                <li key={`${gap.kind}:${gap.target ?? gap.conceptId ?? index}`} className="spp-gap-item">
                  <p className="spp-gap-detail">{gap.detail}</p>
                  {action && (
                    <div className="spp-gap-actions">
                      <button
                        type="button"
                        className="spp-gap-button"
                        disabled={busyGap !== null}
                        onClick={() => void fillGap(gap, index)}
                      >
                        {busyGap === index
                          ? '正在生成…'
                          : action === 'concept'
                            ? 'AI 补缺口题'
                            : 'AI 生成未曝光同族变式'}
                      </button>
                    </div>
                  )}
                  {gapError?.index === index && (
                    <AuthoringFeedback error={gapError.error} className="spp-gap-error" linkClassName="spp-gap-link" onNavigate={onNavigate} />
                  )}
                  {gapResult?.index === index && (
                    <p className="spp-gap-result" role="status">{gapResult.text}</p>
                  )}
                </li>
              );
            })}
          </ul>
          {hasActionableGap && (
            <div className="spp-gap-format">
              <span className="spp-gap-format-label">补缺题题型</span>
              <QuestionFormatPicker value={format} onChange={setFormat} disabled={busyGap !== null} compact />
            </div>
          )}
        </section>
      )}

      {plan.legacyGaps.length > 0 && (
        <section className="spp-section" aria-label="缺口">
          <h4 className="spp-heading">缺口</h4>
          <ul className="spp-gaps">
            {plan.legacyGaps.map(gap => (
              <li key={gap} className="spp-gap-item">
                <p className="spp-gap-detail">{legacyGapLabels[gap] ?? gap}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
