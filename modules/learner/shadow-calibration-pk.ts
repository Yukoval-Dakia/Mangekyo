import type { ShadowCalibrationPkWire } from '@mangekyo/kernel';
import { summarizeRetentionReplay } from './retention-replay.ts';

export type RetentionReplaySummary = ReturnType<typeof summarizeRetentionReplay>;
export type RetentionReplayCases = Parameters<typeof summarizeRetentionReplay>[0];

export type ShadowPromotionThresholds = {
  readonly minEligibleSamples?: number;
  readonly maxCoverageDrop?: number;
  readonly minBrierImprovement?: number;
  readonly minCalibrationImprovement?: number;
};
export type ResolvedShadowPromotionThresholds = {
  readonly minEligibleSamples: number;
  readonly maxCoverageDrop: number;
  readonly minBrierImprovement: number;
  readonly minCalibrationImprovement: number;
};
export type ShadowPkVerdict = 'insufficient_sample' | 'shadow_wins_ready' | 'keep_active' | 'tied_keep_active';
export type CalibrationCurveBin = {
  readonly binIndex: number;
  readonly from: number;
  readonly through: number;
  readonly label: string;
  readonly recordedCount: number;
  readonly recordedMeanPredicted: number | null;
  readonly recordedObservedRate: number | null;
  readonly recordedAbsoluteError: number | null;
  readonly shadowCount: number;
  readonly shadowMeanPredicted: number | null;
  readonly shadowObservedRate: number | null;
  readonly shadowAbsoluteError: number | null;
  readonly baselineCount: number;
  readonly baselineMeanPredicted: number | null;
  readonly baselineObservedRate: number | null;
  readonly baselineAbsoluteError: number | null;
};
export type ShadowModelScorecard = {
  readonly eligible: number;
  readonly scored: number;
  readonly probabilityCoverage: number | null;
  readonly brier: number | null;
  readonly calibrationError: number | null;
  readonly classificationError: number | null;
};
export type ShadowCalibrationPkReport = {
  readonly verdict: ShadowPkVerdict;
  readonly verdictReason: string;
  readonly thresholds: ResolvedShadowPromotionThresholds;
  readonly calibrationCurve: readonly CalibrationCurveBin[];
  readonly brierDelta: number | null;
  readonly eceDelta: number | null;
  readonly coverageDelta: number | null;
  readonly baselineBeatMargin: number | null;
  readonly contaminatedCount: number;
  readonly missingIndependentCount: number;
  readonly nextEvidenceNeeded: number;
  readonly recorded: ShadowModelScorecard;
  readonly shadow: ShadowModelScorecard;
  readonly baseline: ShadowModelScorecard;
  readonly memoryLayerBoundary: 'read_only_proposal';
};

type AssertWire<T extends U, U> = T;
type _ShadowCalibrationPkWireCheck = AssertWire<ShadowCalibrationPkReport, ShadowCalibrationPkWire>;

const EPS = 1e-12;
const clamp01 = (value: number, fallback: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
const nonNegative = (value: number, fallback: number) => Number.isFinite(value) ? Math.max(0, value) : fallback;

function resolveThresholds(thresholds: ShadowPromotionThresholds | undefined): ResolvedShadowPromotionThresholds {
  const minEligibleSamples = Math.max(1, Math.floor(Number.isFinite(thresholds?.minEligibleSamples ?? 20) ? thresholds?.minEligibleSamples ?? 20 : 20));
  return {
    minEligibleSamples,
    maxCoverageDrop: clamp01(thresholds?.maxCoverageDrop ?? 0.05, 0.05),
    minBrierImprovement: nonNegative(thresholds?.minBrierImprovement ?? 0.005, 0.005),
    minCalibrationImprovement: nonNegative(thresholds?.minCalibrationImprovement ?? 0.005, 0.005),
  };
}

function scorecard(summary: RetentionReplaySummary["recorded"]): ShadowModelScorecard {
  return {
    eligible: summary.eligible,
    scored: summary.scored,
    probabilityCoverage: summary.probabilityCoverage,
    brier: summary.brier,
    calibrationError: summary.calibrationError,
    classificationError: summary.classificationError,
  };
}

function calibrationCurve(summary: RetentionReplaySummary): readonly CalibrationCurveBin[] {
  return summary.recorded.bins.map((recorded, binIndex) => {
    const shadow = summary.shadow.bins[binIndex]!;
    const baseline = summary.baseline.bins[binIndex]!;
    return {
      binIndex,
      from: recorded.from,
      through: recorded.through,
      label: `${Math.round(recorded.from * 100)}%–${Math.round(recorded.through * 100)}%`,
      recordedCount: recorded.count,
      recordedMeanPredicted: recorded.meanPredicted,
      recordedObservedRate: recorded.observedRate,
      recordedAbsoluteError: recorded.absoluteError,
      shadowCount: shadow.count,
      shadowMeanPredicted: shadow.meanPredicted,
      shadowObservedRate: shadow.observedRate,
      shadowAbsoluteError: shadow.absoluteError,
      baselineCount: baseline.count,
      baselineMeanPredicted: baseline.meanPredicted,
      baselineObservedRate: baseline.observedRate,
      baselineAbsoluteError: baseline.absoluteError,
    };
  });
}

export function evaluateShadowCalibrationPk(replaySummary: RetentionReplaySummary,
  thresholds?: ShadowPromotionThresholds): ShadowCalibrationPkReport {
  const resolved = resolveThresholds(thresholds);
  const recorded = scorecard(replaySummary.recorded);
  const shadow = scorecard(replaySummary.shadow);
  const baseline = scorecard(replaySummary.baseline);
  const contaminatedCount = replaySummary.recorded.contaminated;
  const missingIndependentCount = replaySummary.recorded.missingIndependent;
  const usableSamples = Math.min(recorded.eligible, recorded.scored, shadow.scored);
  const nextEvidenceNeeded = Math.max(0, resolved.minEligibleSamples - usableSamples);
  const brierDelta = recorded.brier !== null && shadow.brier !== null ? recorded.brier - shadow.brier : null;
  const eceDelta = recorded.calibrationError !== null && shadow.calibrationError !== null ? recorded.calibrationError - shadow.calibrationError : null;
  const coverageDelta = recorded.probabilityCoverage !== null && shadow.probabilityCoverage !== null ? shadow.probabilityCoverage - recorded.probabilityCoverage : null;
  const baselineBeatMargin = baseline.brier !== null && shadow.brier !== null ? baseline.brier - shadow.brier : null;
  const reportBase = {
    thresholds: resolved,
    calibrationCurve: calibrationCurve(replaySummary),
    brierDelta, eceDelta, coverageDelta, baselineBeatMargin,
    contaminatedCount, missingIndependentCount, nextEvidenceNeeded,
    recorded, shadow, baseline, memoryLayerBoundary: 'read_only_proposal' as const,
  };
  const insufficient = recorded.eligible < resolved.minEligibleSamples || shadow.scored < resolved.minEligibleSamples ||
    recorded.scored < resolved.minEligibleSamples || recorded.brier === null || shadow.brier === null ||
    recorded.calibrationError === null || shadow.calibrationError === null || recorded.probabilityCoverage === null ||
    shadow.probabilityCoverage === null;
  if (insufficient) {
    const reasons = ['独立有效样本不足或评测指标尚未齐备'];
    if (contaminatedCount > 0) reasons.push(`受助或污染样本 ${contaminatedCount} 条不计入独立评测`);
    reasons.push(`还需 ${nextEvidenceNeeded} 条独立有效样本`);
    return { ...reportBase, verdict: 'insufficient_sample', verdictReason: reasons.join('，') + '。' };
  }
  const coverageOk = shadow.probabilityCoverage >= recorded.probabilityCoverage - resolved.maxCoverageDrop - EPS;
  const brierWins = shadow.brier <= recorded.brier - resolved.minBrierImprovement + EPS;
  const eceNotWorse = shadow.calibrationError <= recorded.calibrationError + EPS;
  const baselineOk = baseline.brier === null || shadow.brier <= baseline.brier + EPS;
  if (coverageOk && brierWins && eceNotWorse && baselineOk) {
    return { ...reportBase, verdict: 'shadow_wins_ready', verdictReason: 'Shadow 模型的 Brier 评分显著更低，校准误差未变差，覆盖率达标且不劣于基准模型，可以进入提议阶段。' };
  }
  const reasons: string[] = [];
  if (!coverageOk) reasons.push('概率覆盖率下降超过允许范围');
  if (!baselineOk) reasons.push('Brier 评分劣于基准模型');
  if (shadow.brier > recorded.brier + resolved.minBrierImprovement - EPS) reasons.push('Brier 评分出现退化');
  if (shadow.calibrationError > recorded.calibrationError + resolved.minCalibrationImprovement - EPS) reasons.push('校准误差出现退化');
  if (reasons.length) return { ...reportBase, verdict: 'keep_active', verdictReason: reasons.join('，') + '，继续保持当前线上模型。' };
  return { ...reportBase, verdict: 'tied_keep_active', verdictReason: 'Shadow 模型与当前线上模型的 Brier 评分和校准误差尚未拉开足够优势，继续保持当前线上模型。' };
}

export function evaluateShadowCalibrationPkFromCases(cases: RetentionReplayCases,
  thresholds?: ShadowPromotionThresholds): ShadowCalibrationPkReport {
  return evaluateShadowCalibrationPk(summarizeRetentionReplay(cases), thresholds);
}
