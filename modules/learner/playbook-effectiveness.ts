import type { FactId, Outcome, Revision } from '@mangekyo/kernel';
import {
  measureInterventionLift,
  type InterventionLift,
  type LiftInput,
  type VerificationRef,
} from './intervention-lift.ts';
import { retirePlaybookCommand, type PlaybookStatus } from './playbook.ts';

export type PlaybookUsageMetrics = {
  readonly deliveredCount: number;
  readonly openedCount: number;
  readonly posttestCompletedCount: number;
  readonly quickAnswerOnlyCount?: number;
};
export type PlaybookEffectivenessEntryInput = {
  readonly playbookId: FactId;
  readonly version: Revision;
  readonly strategyId: string;
  readonly title: string;
  readonly status?: PlaybookStatus;
  readonly sticky?: boolean;
  readonly liftInput?: LiftInput;
  readonly precomputedLift?: Outcome<InterventionLift>;
  readonly usage: PlaybookUsageMetrics;
  readonly expectedRev?: Revision;
  readonly liftId?: string | null;
};
export type PlaybookEffectivenessOptions = {
  readonly minVerifiedSamples?: number;
  readonly minDemoteDelivered?: number;
  readonly lowOpenRateThreshold?: number;
  readonly lowPosttestRateThreshold?: number;
};
export type PlaybookEffectivenessBucket = 'verified' | 'demoted' | 'inconclusive';
export type PlaybookEffectivenessItem = {
  readonly playbookId: FactId;
  readonly version: Revision;
  readonly strategyId: string;
  readonly title: string;
  readonly bucket: PlaybookEffectivenessBucket;
  readonly lift: Outcome<InterventionLift>;
  readonly openRate: number;
  readonly posttestCompletionRate: number;
  readonly deliveredCount: number;
  readonly openedCount: number;
  readonly posttestCompletedCount: number;
  readonly verificationRefs: readonly VerificationRef[];
  readonly stickyProtected: boolean;
  readonly understandingProjection?: {
    readonly kind: 'verified_playbook';
    readonly strategyId: string;
    readonly evidenceRefs: readonly VerificationRef[];
    readonly requiresApproval: false;
    readonly memoryLayerBoundary: 'read_only_proposal';
  };
  readonly gardeningProposal?: {
    readonly light: 'yellow';
    readonly dedupKey: string;
    readonly command: { readonly type: typeof retirePlaybookCommand; readonly input: { readonly id: FactId; readonly expectedRev: Revision; readonly version: Revision; readonly liftId: string } };
    readonly playbookId: FactId;
    readonly version: Revision;
    readonly expectedRev: Revision;
    readonly liftId: string;
    readonly reason: string;
  };
  readonly reasonLabel: string;
};
export type PlaybookEffectivenessReport = {
  readonly verifiedPlaybooks: readonly PlaybookEffectivenessItem[];
  readonly demotedStrategies: readonly PlaybookEffectivenessItem[];
  readonly inconclusive: readonly PlaybookEffectivenessItem[];
  readonly summary: {
    readonly totalCount: number;
    readonly verifiedCount: number;
    readonly demotedCount: number;
    readonly inconclusiveCount: number;
  };
};

function clamp01(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function count(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
function threshold(value: number | undefined, fallback: number, minimum: number): number {
  return Math.max(minimum, Number.isFinite(value) ? Math.floor(value!) : fallback);
}
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? clamp01(numerator / denominator) : 0; }
function unknownLift(): Outcome<InterventionLift> { return {kind: 'unknown', reason: 'insufficient_evidence'}; }

function reasonFor(lift: Outcome<InterventionLift>, delivered: number, opened: number, posttests: number, minSamples: number, verified: boolean, demoted: boolean): string {
  if (verified) return '独立后测显示该教法带来正向提升，证据充足';
  if (demoted) return lift.kind === 'value' && lift.value.verdict === 'negative' ? '独立后测显示该教法带来负向提升' : '样本已达标但打开率低且尚无正向提升';
  if (lift.kind === 'unknown') return `独立前后测样本不足（至少需要 ${minSamples} 个有效样本）`;
  if (lift.value.verdict === 'positive' && lift.value.verificationRefs.length === 0) return '虽有正向提升判断，但缺少可核验依据';
  if (lift.value.verdict === 'positive' && posttests === 0) return '虽有正向提升判断，但尚无独立后测完成';
  if (delivered > 0 && opened === 0) return '尚无打开记录，无法判断教法效果';
  return lift.value.verdict === 'inconclusive' ? '独立后测尚不足以判断效果' : '样本或独立后测不足，暂不晋升教法';
}

export function evaluatePlaybookEffectiveness(entries: readonly PlaybookEffectivenessEntryInput[], options: PlaybookEffectivenessOptions = {}): PlaybookEffectivenessReport {
  const minVerifiedSamples = threshold(options.minVerifiedSamples, 8, 2);
  const minDemoteDelivered = threshold(options.minDemoteDelivered, 8, 3);
  const lowOpenRateThreshold = clamp01(options.lowOpenRateThreshold ?? 0.2);
  const lowPosttestRateThreshold = clamp01(options.lowPosttestRateThreshold ?? 0.2);
  const verifiedPlaybooks: PlaybookEffectivenessItem[] = [];
  const demotedStrategies: PlaybookEffectivenessItem[] = [];
  const inconclusive: PlaybookEffectivenessItem[] = [];
  for (const entry of entries) {
    const deliveredCount = count(entry.usage.deliveredCount);
    const openedCount = count(entry.usage.openedCount);
    const posttestCompletedCount = count(entry.usage.posttestCompletedCount);
    const quickAnswerOnlyCount = count(entry.usage.quickAnswerOnlyCount ?? 0);
    const openRate = ratio(openedCount, deliveredCount);
    const posttestCompletionRate = openedCount > 0 ? ratio(posttestCompletedCount, openedCount) : ratio(posttestCompletedCount, deliveredCount);
    // One bad entry must never take the whole batch down: isolate measurement failures per entry.
    let measureError: string | null = null;
    let measured: Outcome<InterventionLift> = unknownLift();
    if (!entry.precomputedLift && entry.liftInput) {
      try {
        measured = measureInterventionLift(entry.liftInput);
      } catch (error) {
        measureError = `该条 Lift 输入异常（${error instanceof Error ? error.message : '格式错误'}），已安全降级为待定`;
      }
    }
    const rawLift = entry.precomputedLift ?? measured;
    // A precomputed lift targeting another playbook, version or strategy is never trusted.
    const liftMismatch = rawLift.kind === 'value' && entry.precomputedLift !== undefined &&
      (rawLift.value.playbookId !== entry.playbookId || rawLift.value.version !== entry.version || rawLift.value.strategyId !== entry.strategyId);
    const distrusted = measureError !== null || liftMismatch;
    const lift = distrusted ? unknownLift() : rawLift;
    const verificationRefs = lift.kind === 'value' ? lift.value.verificationRefs : [];
    const positive = lift.kind === 'value' && lift.value.verdict === 'positive';
    // Quick-answer-only usage or a low posttest completion rate cannot promote a playbook.
    const quickOnly = deliveredCount > 0 && quickAnswerOnlyCount >= deliveredCount;
    const lowPosttest = posttestCompletedCount <= 0 || (deliveredCount > 0 && ratio(posttestCompletedCount, deliveredCount) < lowPosttestRateThreshold);
    const verified = positive && verificationRefs.length > 0 && lift.value.eligible >= minVerifiedSamples && posttestCompletedCount > 0 && !quickOnly && !lowPosttest;
    const demoted = lift.kind === 'value' && lift.value.verdict === 'negative' || deliveredCount >= minDemoteDelivered && openRate <= lowOpenRateThreshold && !positive;
    const bucket: PlaybookEffectivenessBucket = distrusted ? 'inconclusive' : verified ? 'verified' : demoted ? 'demoted' : 'inconclusive';
    const stickyProtected = entry.sticky === true;
    const baseReason = measureError ?? (liftMismatch ? '预计算 Lift 与当前策略或版本不匹配，已退回待定'
      : quickOnly || (positive && lowPosttest) ? '缺少有效独立后测（单次快答或后测完成率不足），暂不晋升'
      : reasonFor(lift, deliveredCount, openedCount, posttestCompletedCount, minVerifiedSamples, verified, demoted));
    const base: PlaybookEffectivenessItem = {playbookId: entry.playbookId, version: entry.version, strategyId: entry.strategyId, title: entry.title, bucket, lift, openRate, posttestCompletionRate, deliveredCount, openedCount, posttestCompletedCount, verificationRefs, stickyProtected, reasonLabel: baseReason};
    // A yellow retirement proposal is executable only with a settled negative lift plus the
    // exact revision and settled lift identity; low open rates alone never retire a playbook.
    const negativeSettled = lift.kind === 'value' && lift.value.verdict === 'negative';
    const liftId = entry.liftId ?? entry.status?.liftId ?? null;
    const canRetire = bucket === 'demoted' && !stickyProtected && negativeSettled && entry.expectedRev !== undefined && typeof liftId === 'string' && liftId.length > 0;
    const item: PlaybookEffectivenessItem = verified ? {...base, understandingProjection: {kind: 'verified_playbook', strategyId: entry.strategyId, evidenceRefs: verificationRefs, requiresApproval: false, memoryLayerBoundary: 'read_only_proposal'}} : canRetire ? {...base, gardeningProposal: {light: 'yellow', dedupKey: `retire-playbook/${entry.playbookId}/${entry.expectedRev}/${liftId}`, command: {type: retirePlaybookCommand, input: {id: entry.playbookId, expectedRev: entry.expectedRev as Revision, version: entry.version, liftId}}, playbookId: entry.playbookId, version: entry.version, expectedRev: entry.expectedRev as Revision, liftId, reason: base.reasonLabel}} : base;
    if (bucket === 'verified') verifiedPlaybooks.push(item);
    else if (bucket === 'demoted') demotedStrategies.push(item);
    else inconclusive.push(item);
  }
  return {verifiedPlaybooks, demotedStrategies, inconclusive, summary: {totalCount: entries.length, verifiedCount: verifiedPlaybooks.length, demotedCount: demotedStrategies.length, inconclusiveCount: inconclusive.length}};
}
