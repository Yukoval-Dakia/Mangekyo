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
  const paired = (summary as { paired?: RetentionReplaySummary['paired'] }).paired;
  const recordedBins = (paired?.recorded ?? summary.recorded).bins;
  const shadowBins = (paired?.shadow ?? summary.shadow).bins;
  const baselineBins = (paired?.baselineCommon.baseline ?? paired?.baseline ?? summary.baseline).bins;
  return recordedBins.map((recorded, binIndex) => {
    const shadow = shadowBins[binIndex]!;
    const baseline = baselineBins[binIndex]!;
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
  const paired = (replaySummary as { paired?: RetentionReplaySummary['paired'] }).paired;
  // Probability coverage is a full-sample property; win/loss metrics compare on the
  // strict same-sample intersection so mismatched prediction sets cannot bias the PK.
  const fullRecorded = scorecard(replaySummary.recorded);
  const fullShadow = scorecard(replaySummary.shadow);
  const fullBaseline = scorecard(replaySummary.baseline);
  const pairedMissing = !paired;
  const cmpRecorded = paired ? scorecard(paired.recorded) : fullRecorded;
  const cmpShadow = paired ? scorecard(paired.shadow) : fullShadow;
  const cmpBaseline = scorecard(paired?.baselineCommon.baseline ?? replaySummary.baseline);
  // Compare shadow against baseline on their shared three-way intersection so
  // missing baseline probabilities cannot skew the baseline gate.
  const baselineShadow = paired ? scorecard(paired.baselineCommon.shadow) : cmpShadow;
  const recorded: ShadowModelScorecard = { ...cmpRecorded, probabilityCoverage: fullRecorded.probabilityCoverage };
  const shadow: ShadowModelScorecard = { ...cmpShadow, probabilityCoverage: fullShadow.probabilityCoverage };
  const baseline: ShadowModelScorecard = { ...cmpBaseline, probabilityCoverage: fullBaseline.probabilityCoverage };
  const contaminatedCount = replaySummary.recorded.contaminated;
  const missingIndependentCount = replaySummary.recorded.missingIndependent;
  const usableSamples = paired ? paired.recorded.eligible : 0;
  const nextEvidenceNeeded = Math.max(0, resolved.minEligibleSamples - usableSamples);
  const brierDelta = recorded.brier !== null && shadow.brier !== null ? recorded.brier - shadow.brier : null;
  const eceDelta = recorded.calibrationError !== null && shadow.calibrationError !== null ? recorded.calibrationError - shadow.calibrationError : null;
  const coverageDelta = fullRecorded.probabilityCoverage !== null && fullShadow.probabilityCoverage !== null
    ? fullShadow.probabilityCoverage - fullRecorded.probabilityCoverage : null;
  const baselineBeatMargin = baseline.brier !== null && baselineShadow.brier !== null ? baseline.brier - baselineShadow.brier : null;
  const reportBase = {
    thresholds: resolved,
    calibrationCurve: calibrationCurve(replaySummary),
    brierDelta, eceDelta, coverageDelta, baselineBeatMargin,
    contaminatedCount, missingIndependentCount, nextEvidenceNeeded,
    recorded, shadow, baseline, memoryLayerBoundary: 'read_only_proposal' as const,
  };
  const insufficient = pairedMissing || usableSamples < resolved.minEligibleSamples ||
    recorded.eligible < resolved.minEligibleSamples || shadow.scored < resolved.minEligibleSamples ||
    recorded.scored < resolved.minEligibleSamples || recorded.brier === null || shadow.brier === null ||
    recorded.calibrationError === null || shadow.calibrationError === null || recorded.probabilityCoverage === null ||
    shadow.probabilityCoverage === null;
  if (insufficient) {
    const reasons = ['独立有效样本不足或评测指标尚未齐备'];
    if (pairedMissing) reasons.unshift('摘要未提供成对样本交集，无法进行公平 PK 对比');
    if (contaminatedCount > 0) reasons.push(`受助或污染样本 ${contaminatedCount} 条不计入独立评测`);
    reasons.push(`还需 ${nextEvidenceNeeded} 条独立有效样本`);
    return { ...reportBase, verdict: 'insufficient_sample', verdictReason: reasons.join('，') + '。' };
  }
  const coverageOk = fullShadow.probabilityCoverage !== null && fullRecorded.probabilityCoverage !== null &&
    fullShadow.probabilityCoverage >= fullRecorded.probabilityCoverage - resolved.maxCoverageDrop - EPS;
  const brierWins = shadow.brier <= recorded.brier - resolved.minBrierImprovement + EPS;
  const eceWins = shadow.calibrationError <= recorded.calibrationError - resolved.minCalibrationImprovement + EPS;
  const baselineOk = baseline.brier === null || (baselineShadow.brier !== null && baselineShadow.brier <= baseline.brier + EPS);
  if (coverageOk && brierWins && eceWins && baselineOk) {
    return { ...reportBase, verdict: 'shadow_wins_ready', verdictReason: 'Shadow 模型的 Brier 评分与校准误差在同一样本交集上显著更优，覆盖率达标且不劣于基准模型，可以进入提议阶段。' };
  }
  const reasons: string[] = [];
  if (!coverageOk) reasons.push('概率覆盖率下降超过允许范围');
  if (!baselineOk) reasons.push('Brier 评分劣于基准模型');
  if (shadow.brier > recorded.brier + resolved.minBrierImprovement - EPS) reasons.push('Brier 评分出现退化');
  if (shadow.calibrationError > recorded.calibrationError + resolved.minCalibrationImprovement - EPS) reasons.push('校准误差出现退化');
  if (reasons.length) return { ...reportBase, verdict: 'keep_active', verdictReason: reasons.join('，') + '，继续保持当前线上模型。' };
  const tiedReasons: string[] = [];
  if (!brierWins) tiedReasons.push('Brier 评分改善未达门槛');
  if (!eceWins) tiedReasons.push('校准误差改善未达门槛');
  return { ...reportBase, verdict: 'tied_keep_active',
    verdictReason: `Shadow 模型与当前线上模型尚未拉开足够优势（${tiedReasons.join('，')}），继续保持当前线上模型。` };
}

export function evaluateShadowCalibrationPkFromCases(cases: RetentionReplayCases,
  thresholds?: ShadowPromotionThresholds): ShadowCalibrationPkReport {
  return evaluateShadowCalibrationPk(summarizeRetentionReplay(cases), thresholds);
}
