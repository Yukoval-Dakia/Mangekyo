import type { DerivationId, GatherContext } from '@mangekyo/kernel';
import type { LiftAssessment, VerificationRef } from './intervention-lift.ts';
import { instant, openWitness } from './memory-evidence.ts';
import { reconciliationType, type RetentionObservation, type reconcileRetention } from './retention.ts';

// Keep the formal activity judgment: a displayed hint is exposed and an opened
// but unconfirmed hint is unknown. Only explicitly independent results score.
export async function liftAssessment(
  ctx: GatherContext, submission: VerificationRef, observation: RetentionObservation,
  target: {item: string; comparisonKey: string; asOf: string},
): Promise<LiftAssessment | null> {
  if (submission.id !== observation.submission.id || submission.rev !== observation.submission.rev ||
      BigInt(observation.admittedAt) > BigInt(ctx.snapshotTick) ||
      instant(observation.submittedAt) > instant(target.asOf)) return null;
  const fact = await openWitness(ctx.read, submission, 'background-research');
  if (fact.type !== 'activity.workbookAttempt' && fact.type !== 'activity.retentionPosttestSubmission')
    throw new Error('前后测需要正式交卷记录。');
  const novelty = { 'same-item': 'same', variant: 'isomorphic', 'fresh-context': 'transfer' } as const;
  const independence = observation.exposure.kind === 'exposed' ? 'assisted' : observation.exposure.kind;
  const score = independence !== 'independent' || observation.result === 'unknown' ? null
    : observation.scoreNorm ?? Number(observation.result === 'correct');
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 1)) return null;
  return {submission, item: target.item, comparisonKey: target.comparisonKey, occurredAt: observation.submittedAt,
    novelty: observation.novelty ? novelty[observation.novelty] : 'unknown', independence, score};
}

export async function reconciledLiftAssessment(
  ctx: GatherContext, submission: VerificationRef,
  target: {key: string; forecastId: DerivationId; item: string; comparisonKey: string; asOf: string},
): Promise<LiftAssessment | null> {
  const current = await ctx.read.slot<ReturnType<typeof reconcileRetention> & {forecastId: DerivationId}>(
    {learner: ctx.learner, type: reconciliationType, key: target.key}, {mode: 'following'});
  if (current.outcome.kind !== 'value') return null;
  const {forecastId, status, observation} = current.outcome.value;
  if (forecastId !== target.forecastId || (status !== 'observed' && status !== 'matched' && status !== 'missed'))
    return null;
  return liftAssessment(ctx, submission, observation, target);
}
