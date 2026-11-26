type ExamPacingScoreLike = { readonly earned: number; readonly maximum: number };
type ExamPacingRefLike = { readonly id: string; readonly rev: number };
type ExamPacingProcessItemLike = {
  readonly item_id: string; readonly position: number; readonly evidence_ref: ExamPacingRefLike; readonly occurred_at: string;
  readonly skipped?: boolean; readonly returned?: boolean; readonly estimated_duration_ms?: number; readonly effective_duration_ms?: number;
  readonly over_estimate?: boolean; readonly later_score_context?: 'timely-skip-with-later-credit' | 'overrun-with-later-shortfall';
};
type ExamPacingItemAnchorLike = { readonly item_id: string; readonly position: number; readonly evidence_ref: ExamPacingRefLike; readonly occurred_at: string };
export type ExamPacingWithinAttemptLike = {
  readonly attempt_ref: ExamPacingRefLike;
  readonly process: { readonly kind: 'unknown' } | { readonly kind: 'observed'; readonly items: readonly ExamPacingProcessItemLike[] };
  readonly later_scores: { readonly kind: 'unknown' } | { readonly kind: 'observed'; readonly items: readonly (ExamPacingItemAnchorLike & { readonly score: ExamPacingScoreLike })[] };
};
type ExamPacingObservedAttemptLike = { readonly id: string; readonly kind: 'observed'; readonly effective_duration_ms: number; readonly score: ExamPacingScoreLike; readonly score_rate: number; readonly paper_key?: string; readonly scale_key?: string };
type ExamPacingUnknownAttemptLike = { readonly id: string; readonly kind: 'unknown'; readonly missing: readonly ('effective_duration_ms' | 'score' | 'paper_key' | 'scale_key')[] };
export type ExamPacingAttemptRowLike = ExamPacingObservedAttemptLike | ExamPacingUnknownAttemptLike;
export type ExamPacingResultLike = {
  readonly method_version: 'plan/exam-pacing@1';
  readonly attempts: readonly ExamPacingAttemptRowLike[];
  readonly within_attempt?: readonly ExamPacingWithinAttemptLike[];
  readonly strategy: { readonly kind: 'unknown'; readonly reason: 'insufficient-comparable-attempts' } | { readonly kind: 'observed'; readonly comparisons: readonly { readonly slower_attempt_id: string; readonly faster_attempt_id: string; readonly extra_duration_ms: number; readonly score_rate_gap: number }[] };
};

type PacingMissingField = 'effective_duration_ms' | 'score' | 'paper_key' | 'scale_key';
export type ExamPacingBottleneckItem = {
  readonly attemptId: string; readonly attemptRev: number; readonly itemId: string; readonly position: number;
  readonly effectiveDurationMs?: number; readonly estimatedDurationMs?: number; readonly overrunRatio?: number;
  readonly laterShortfallCount: number; readonly summaryLabel: string;
};
export type ExamPacingPositiveExample = {
  readonly attemptId: string; readonly attemptRev: number; readonly itemId: string; readonly position: number;
  readonly skipped: boolean; readonly returned: boolean; readonly laterCreditCount: number; readonly summaryLabel: string;
};
export type ExamPacingTradeoff = {
  readonly slowerAttemptId: string; readonly fasterAttemptId: string; readonly extraDurationMs: number; readonly scoreRateGap: number; readonly summaryLabel: string;
};
export type ExamPacingReview = {
  readonly methodVersion: 'plan/exam-pacing@1'; readonly status: 'ready' | 'unknown'; readonly headline: string;
  readonly observedAttemptCount: number; readonly unknownAttemptCount: number; readonly missingFields: readonly PacingMissingField[]; readonly missingReasons: readonly string[];
  readonly bottleneckItems: readonly ExamPacingBottleneckItem[]; readonly positiveStrategyExamples: readonly ExamPacingPositiveExample[]; readonly crossAttemptTradeoffs: readonly ExamPacingTradeoff[];
};

const pacingFields: readonly PacingMissingField[] = ['effective_duration_ms', 'score', 'paper_key', 'scale_key'];
const fieldReasons: Record<PacingMissingField, string> = {
  effective_duration_ms: '缺少整场有效作答时长，无法判断整场节奏。', score: '缺少得分，无法判断时间投入换来的结果。',
  paper_key: '缺少试卷标识，无法确认不同考次是否可比。', scale_key: '缺少评分尺度标识，无法确认得分率是否可比。',
};

function missingData(result: ExamPacingResultLike): { fields: readonly PacingMissingField[]; reasons: readonly string[] } {
  const listed = result.attempts.flatMap(row => row.kind === 'unknown' ? row.missing : [
    ...(row.paper_key === undefined ? ['paper_key' as const] : []), ...(row.scale_key === undefined ? ['scale_key' as const] : []),
  ]);
  const fields = pacingFields.filter(field => listed.includes(field));
  return { fields, reasons: fields.map(field => fieldReasons[field]) };
}

function processExamples(result: ExamPacingResultLike) {
  const bottleneckItems: ExamPacingBottleneckItem[] = [];
  const positiveStrategyExamples: ExamPacingPositiveExample[] = [];
  for (const within of result.within_attempt ?? []) {
    const later = within.later_scores.kind === 'observed' ? within.later_scores.items : [];
    const laterShortfallCount = later.filter(item => item.score.earned < item.score.maximum).length;
    const laterCreditCount = later.filter(item => item.score.earned > 0).length;
    if (within.process.kind !== 'observed') continue;
    for (const item of within.process.items) {
      if (item.later_score_context === 'overrun-with-later-shortfall') {
        const overrunRatio = item.effective_duration_ms !== undefined && item.estimated_duration_ms !== undefined && item.estimated_duration_ms > 0 ? item.effective_duration_ms / item.estimated_duration_ms : undefined;
        bottleneckItems.push({
          attemptId: within.attempt_ref.id, attemptRev: within.attempt_ref.rev, itemId: item.item_id, position: item.position,
          ...(item.effective_duration_ms !== undefined ? { effectiveDurationMs: item.effective_duration_ms } : {}),
          ...(item.estimated_duration_ms !== undefined ? { estimatedDurationMs: item.estimated_duration_ms } : {}),
          ...(overrunRatio !== undefined ? { overrunRatio } : {}), laterShortfallCount,
          summaryLabel: '这道压轴或难题过度耗时，挤压了后段可得分题。',
        });
      }
      if (item.later_score_context === 'timely-skip-with-later-credit') {
        positiveStrategyExamples.push({
          attemptId: within.attempt_ref.id, attemptRev: within.attempt_ref.rev, itemId: item.item_id, position: item.position,
          skipped: item.skipped === true, returned: item.returned === true, laterCreditCount,
          summaryLabel: '及时跳过难题，为后段稳拿分留出了时间。',
        });
      }
    }
  }
  return { bottleneckItems, positiveStrategyExamples };
}

function tradeoffs(result: ExamPacingResultLike): readonly ExamPacingTradeoff[] {
  if (result.strategy.kind !== 'observed') return [];
  return result.strategy.comparisons.map(comparison => ({
    slowerAttemptId: comparison.slower_attempt_id, fasterAttemptId: comparison.faster_attempt_id,
    extraDurationMs: comparison.extra_duration_ms, scoreRateGap: comparison.score_rate_gap,
    summaryLabel: '较慢的考次多花了时间，但得分率没有相应提升。',
  }));
}

export function projectExamPacingReview(result: ExamPacingResultLike): ExamPacingReview {
  const observedAttemptCount = result.attempts.filter(row => row.kind === 'observed').length;
  const unknownAttemptCount = result.attempts.length - observedAttemptCount;
  const missing = missingData(result);
  const examples = processExamples(result);
  const crossAttemptTradeoffs = tradeoffs(result);
  const hasObservedProcess = (result.within_attempt ?? []).some(within => within.process.kind === 'observed');
  const processItems = (result.within_attempt ?? []).flatMap(within => within.process.kind === 'observed' ? within.process.items : []);
  const hasEffectiveDuration = processItems.some(item => item.effective_duration_ms !== undefined);
  const hasLaterContext = processItems.some(item => item.later_score_context !== undefined);
  const lacksUsableProcess = result.strategy.kind === 'unknown' && (!hasObservedProcess ||
    (!hasEffectiveDuration && !hasLaterContext && observedAttemptCount === 0));
  if (lacksUsableProcess) {
    const missingFields = [...missing.fields];
    if (!hasEffectiveDuration && !missingFields.includes('effective_duration_ms')) missingFields.unshift('effective_duration_ms');
    const reasons = missingFields.map(field => fieldReasons[field]);
    if (!reasons.length) reasons.push('没有卷内逐题节奏观测，无法判断及时跳过或超时挤压。');
    if (result.attempts.length === 0) reasons.push('当前没有可用考次，暂不生成节奏建议。');
    return { methodVersion: 'plan/exam-pacing@1', status: 'unknown', headline: '考场节奏证据还不够，先补齐作答时长或逐题过程记录。', observedAttemptCount, unknownAttemptCount, missingFields, missingReasons: reasons, bottleneckItems: [], positiveStrategyExamples: [], crossAttemptTradeoffs: [] };
  }
  const headline = examples.bottleneckItems.length ? `已发现 ${examples.bottleneckItems.length} 道题的耗时挤压后段现象。` : examples.positiveStrategyExamples.length ? `已发现 ${examples.positiveStrategyExamples.length} 个及时跳过后稳住后段的例子。` : crossAttemptTradeoffs.length ? `已发现 ${crossAttemptTradeoffs.length} 组跨次节奏取舍。` : '已有考场节奏观测，可以继续积累可比证据。';
  return { methodVersion: 'plan/exam-pacing@1', status: 'ready', headline, observedAttemptCount, unknownAttemptCount, missingFields: missing.fields, missingReasons: missing.reasons, bottleneckItems: examples.bottleneckItems, positiveStrategyExamples: examples.positiveStrategyExamples, crossAttemptTradeoffs };
}

export type LongBreakConceptCandidate = {
  readonly conceptId: string; readonly title: string; readonly retentionProbability: number | null; readonly examWeight?: number;
  readonly overdueReviewCount?: number; readonly refused?: boolean; readonly activityId?: string;
};
export type LongBreakReentryInput = { readonly inactiveDays: number; readonly minInactiveDays?: number; readonly maxProbeCount?: number; readonly totalOverdueCount?: number; readonly concepts: readonly LongBreakConceptCandidate[]; readonly lockedActivityIds?: readonly string[] };
type ReentryBucket = 'likelyStillSolid' | 'likelyFaded' | 'uncertainNeedsProbe';
export type LongBreakConceptBucketItem = LongBreakConceptCandidate & { readonly examWeight: number; readonly bucket: ReentryBucket };
export type LongBreakProbeItem = LongBreakConceptBucketItem & { readonly informationGainScore: number; readonly reasonLabel: string };
export type LongBreakReentryPlan = {
  readonly triggered: boolean; readonly inactiveDays: number; readonly minInactiveDays: number; readonly maxProbeCount: number; readonly headline: string; readonly reassuranceMessage: string;
  readonly buckets: { readonly likelyStillSolid: readonly LongBreakConceptBucketItem[]; readonly likelyFaded: readonly LongBreakConceptBucketItem[]; readonly uncertainNeedsProbe: readonly LongBreakConceptBucketItem[] };
  readonly probeItems: readonly LongBreakProbeItem[]; readonly lockedActivityIds: readonly string[]; readonly filteredRefusedCount: number; readonly rawOverdueCount: number; readonly suppressedOverdueCount: number;
};

function finiteInteger(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isFinite(value ?? fallback) ? Math.max(minimum, Math.floor(value ?? fallback)) : fallback;
}
function bucketFor(probability: number | null): ReentryBucket {
  return probability !== null && probability >= 0.7 ? 'likelyStillSolid' : probability !== null && probability < 0.45 ? 'likelyFaded' : 'uncertainNeedsProbe';
}
function informationGain(probability: number | null): number {
  return probability === null ? 1 : Math.max(0, 1 - Math.abs(probability - 0.5) * 2);
}

export function buildLongBreakReentryPlan(input: LongBreakReentryInput): LongBreakReentryPlan {
  const minInactiveDays = finiteInteger(input.minInactiveDays, 7, 1);
  const maxProbeCount = Math.min(5, finiteInteger(input.maxProbeCount, 4, 1));
  const available = input.concepts.filter(concept => concept.refused !== true).map(concept => ({ ...concept, examWeight: Number.isFinite(concept.examWeight ?? 1) ? Math.max(0, concept.examWeight ?? 1) : 1, bucket: bucketFor(concept.retentionProbability) }));
  const sortByInformation = (a: LongBreakConceptBucketItem, b: LongBreakConceptBucketItem) => informationGain(b.retentionProbability) * b.examWeight - informationGain(a.retentionProbability) * a.examWeight || a.conceptId.localeCompare(b.conceptId);
  const uncertain = available.filter(item => item.bucket === 'uncertainNeedsProbe').sort(sortByInformation);
  const faded = available.filter(item => item.bucket === 'likelyFaded').sort(sortByInformation);
  const candidates = [...uncertain, ...faded].slice(0, maxProbeCount);
  const probeItems = candidates.map(item => ({ ...item, informationGainScore: informationGain(item.retentionProbability) * item.examWeight, reasonLabel: item.bucket === 'uncertainNeedsProbe' ? '记忆把握仍不确定，先用一道轻量摸底题确认。' : '这项内容可能已变淡，先用一道轻量摸底题确认。' }));
  const rawOverdueCount = Number.isFinite(input.totalOverdueCount ?? 0) ? Math.max(0, Math.floor(input.totalOverdueCount ?? 0)) : 0;
  const lockedActivityIds = [...new Set(input.lockedActivityIds ?? [])];
  const triggered = input.inactiveDays >= minInactiveDays;
  return {
    triggered, inactiveDays: input.inactiveDays, minInactiveDays, maxProbeCount,
    headline: triggered ? '欢迎回来，先轻轻找回学习节奏' : '按你的节奏继续学习',
    reassuranceMessage: '我们会先用少量摸底题确认状态，把机械逾期折叠起来，不把一整面欠账墙压到你面前。',
    buckets: { likelyStillSolid: available.filter(item => item.bucket === 'likelyStillSolid'), likelyFaded: faded, uncertainNeedsProbe: uncertain },
    probeItems, lockedActivityIds, filteredRefusedCount: input.concepts.length - available.length, rawOverdueCount,
    suppressedOverdueCount: Math.max(0, rawOverdueCount - probeItems.length),
  };
}
