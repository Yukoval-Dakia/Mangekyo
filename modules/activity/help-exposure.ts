import type { FactRef, Tick } from '@mangekyo/kernel';
import { helpAppliesTo, sameHelpRef, sameHelpTarget, type HelpExposureEvent, type HelpTarget } from './help-exposure-values.ts';

/** 获授权的原始事件修订和其 fact_revs.tick。 */
export type AdmittedHelpEvent = {
  readonly ref: FactRef;
  readonly admittedAt: Tick;
  readonly value: HelpExposureEvent;
};

/** 截点取正式提交时的内核刻度，缺少可信截点时为 null。 */
export type HelpSubmissionCutoff = {
  readonly ref: FactRef;
  readonly target: HelpTarget;
  readonly cutoff: Tick | null;
};

/** 宿主确认指定作答范围在截点前的所有展示途径均有完整记录。 */
export type CompleteHelpObservation = {
  readonly submission: FactRef;
  readonly target: HelpTarget;
  readonly through: Tick;
};

export type HelpExposureQuery = {
  readonly submission: HelpSubmissionCutoff;
  readonly events: readonly AdmittedHelpEvent[];
  readonly coverage: CompleteHelpObservation | null;
};

export type HelpExposureEvidence =
  | { readonly kind: 'exposed'; readonly evidenceRefs: readonly FactRef[] }
  | { readonly kind: 'unexposed'; readonly evidenceRefs: readonly [] }
  | {
    readonly kind: 'unknown';
    readonly reason: 'missing-cutoff' | 'incomplete-observation' | 'unconfirmed-follow-up';
    readonly evidenceRefs: readonly [];
  };

function sameFact(first: FactRef, second: FactRef): boolean {
  return first.learner === second.learner && sameHelpRef(first, second);
}

export function projectHelpExposure({ submission, events, coverage }: HelpExposureQuery): HelpExposureEvidence {
  if (submission.cutoff === null) return { kind: 'unknown', reason: 'missing-cutoff', evidenceRefs: [] };
  const cutoff = BigInt(submission.cutoff);
  const displays = new Map<FactRef['id'], FactRef>();
  for (const { ref, admittedAt, value } of events) {
    if (value.kind === 'displayed' && ref.learner === submission.ref.learner
      && BigInt(admittedAt) < cutoff && helpAppliesTo(value, submission.target)) {
      displays.set(ref.id, ref);
    }
  }
  if (displays.size > 0) {
    const evidenceRefs = [...displays.values()].sort((first, second) => first.id.localeCompare(second.id));
    return { kind: 'exposed', evidenceRefs };
  }
  if (coverage?.through === submission.cutoff && sameFact(coverage.submission, submission.ref)
    && sameHelpTarget(coverage.target, submission.target)) {
    return { kind: 'unexposed', evidenceRefs: [] };
  }
  return { kind: 'unknown', reason: 'incomplete-observation', evidenceRefs: [] };
}

export type HelpFollowUpEvidence = Exclude<HelpExposureEvidence, { kind: 'unexposed' }>
  | { readonly kind: 'independent-follow-up'; readonly evidenceRefs: readonly FactRef[] };

export function projectHelpFollowUp(link: FactRef, query: HelpExposureQuery): HelpFollowUpEvidence {
  const { submission, events } = query;
  const followUp = events.find(event => sameFact(event.ref, link));
  if (submission.cutoff === null) return { kind: 'unknown', reason: 'missing-cutoff', evidenceRefs: [] };
  const cutoff = BigInt(submission.cutoff);
  if (followUp?.value.kind !== 'follow-up' || link.learner !== submission.ref.learner
    || !sameHelpRef(followUp.value.answer.submission, submission.ref)
    || !sameHelpTarget(followUp.value.answer.target, submission.target)
    || BigInt(followUp.admittedAt) <= cutoff) {
    return { kind: 'unknown', reason: 'unconfirmed-follow-up', evidenceRefs: [] };
  }
  const { display } = followUp.value;
  const prior = events.find(event => event.value.kind === 'displayed' && event.ref.learner === link.learner
    && sameHelpRef(event.ref, display) && BigInt(event.admittedAt) < cutoff);
  if (!prior) return { kind: 'unknown', reason: 'unconfirmed-follow-up', evidenceRefs: [] };

  const exposure = projectHelpExposure(query);
  if (exposure.kind !== 'unexposed') return exposure;
  return { kind: 'independent-follow-up', evidenceRefs: [prior.ref, submission.ref, link] };
}
