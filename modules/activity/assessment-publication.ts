import { factId } from '@mangekyo/kernel';
import {
  assessmentPublicationInput, assessmentRelease, assessmentResult, assessmentSubmission,
  type AssessmentCriterion, type AssessmentCriterionOutcome, type AssessmentEvaluatorRef,
  type AssessmentRelease, type AssessmentRevisionRef,
} from './assessment-values.ts';
import { sameWorkbookJson } from './workbook-values.ts';

type AssessmentItem = AssessmentRelease['items'][number];

export type AssessmentPublicationTarget = {
  readonly releaseRef: AssessmentRevisionRef;
  readonly itemId: string;
};

export type AssessmentPublicationWitness = {
  readonly ref: AssessmentRevisionRef;
  readonly origin: 'independent-solution' | 'trusted-gold';
  readonly releaseRef: AssessmentRevisionRef;
  readonly frozenItem: AssessmentItem;
  readonly requiredSampleRefs: readonly AssessmentRevisionRef[];
};

export type TrustedAssessmentPublicationSample = {
  readonly sampleRef: AssessmentRevisionRef;
  readonly submission: unknown;
  readonly expected: unknown;
};

export type AssessmentPublicationRun =
  | { readonly state: 'pending' | 'failed'; readonly reason: string }
  | {
      readonly state: 'completed';
      readonly witnessRef: AssessmentRevisionRef;
      readonly sampleRef: AssessmentRevisionRef;
      readonly receiptRef: AssessmentRevisionRef;
      readonly evaluators: readonly { readonly criterionId: string; readonly evaluator: AssessmentEvaluatorRef }[];
      readonly actual: unknown;
    };

export type VerifiedAssessmentPublicationEvidence = {
  readonly witness: AssessmentPublicationWitness;
  readonly samples: readonly {
    readonly sample: TrustedAssessmentPublicationSample;
    readonly run?: AssessmentPublicationRun;
  }[];
};

export type ReadVerifiedAssessmentPublicationEvidence = (
  target: AssessmentPublicationTarget,
) => VerifiedAssessmentPublicationEvidence | null | undefined;

export type AssessmentPublicationIssue = {
  readonly stage: 'release' | 'witness' | 'contract' | 'coverage' | 'submission' | 'expected' | 'run' | 'evaluator' | 'actual' | 'outcome';
  readonly reason: string;
  readonly itemId?: string;
  readonly sampleRef?: AssessmentRevisionRef;
  readonly criterionId?: string;
};

type SampleEvidence = {
  readonly sampleRef: AssessmentRevisionRef;
  readonly submissionRef: AssessmentRevisionRef;
  readonly receiptRef: AssessmentRevisionRef;
};

export type AssessmentPublicationQualification = AssessmentPublicationTarget &
  Pick<AssessmentItem, 'promptRef' | 'workRef'> & {
    readonly witnessRef: AssessmentRevisionRef;
    readonly criteria: readonly Pick<AssessmentCriterion, 'criterionId' | 'evaluator' | 'source' | 'maximum'>[];
    readonly samples: readonly SampleEvidence[];
  };

export type AssessmentPublicationDecision =
  | {
      readonly state: 'eligible';
      readonly releaseRef: AssessmentRevisionRef;
      readonly items: readonly AssessmentPublicationQualification[];
    }
  | {
      readonly state: 'needs-review';
      readonly releaseRef?: AssessmentRevisionRef;
      readonly issues: readonly AssessmentPublicationIssue[];
    };

function revisionKey(ref: AssessmentRevisionRef): string {
  if (!ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.rev) || ref.rev < 1) {
    throw new Error('证据须引用明确修订。');
  }
  return `${factId(ref.id)}:${ref.rev}`;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : '输入无法核对。';
}

function outcomeDifference(expected: AssessmentCriterionOutcome, actual: AssessmentCriterionOutcome): string | undefined {
  if (expected.state !== actual.state) return `预期状态 ${expected.state}，实际为 ${actual.state}。`;
  if ('earned' in expected && 'earned' in actual && expected.earned !== actual.earned) {
    return `预期得分 ${expected.earned}，实际为 ${actual.earned}。`;
  }
  if ('feedback' in expected && (!('feedback' in actual) || expected.feedback !== actual.feedback)) {
    return '实际评语与可信样例约定的结论不符。';
  }
  if ('reason' in expected && 'reason' in actual && expected.reason !== actual.reason) {
    return '实际结果原因与可信样例不符。';
  }
  if ('evidence' in expected && 'evidence' in actual &&
    (expected.evidence.length !== actual.evidence.length ||
      !expected.evidence.every(expectedAddress => actual.evidence.some(actualAddress =>
        actualAddress.slotId === expectedAddress.slotId && actualAddress.path === expectedAddress.path,
      )))) {
    return '实际作答证据位置与可信样例不符。';
  }
  return undefined;
}

function checkSample(
  release: AssessmentRelease,
  item: AssessmentItem,
  witnessRef: AssessmentRevisionRef,
  { sample, run }: VerifiedAssessmentPublicationEvidence['samples'][number],
): SampleEvidence | AssessmentPublicationIssue {
  const { sampleRef } = sample;
  let stage: AssessmentPublicationIssue['stage'] = 'submission';
  const issue = (message: string, criterionId?: string): AssessmentPublicationIssue => ({
    stage, itemId: item.itemId, sampleRef, reason: message, ...(criterionId === undefined ? {} : { criterionId }),
  });

  try {
    const submission = assessmentSubmission(sample.submission, release);
    stage = 'expected';
    if (sample.expected == null) return issue('缺少可信样例的预期结果。');
    const expected = assessmentResult(sample.expected, release, submission);
    const unresolved = expected.outcomes.find(({ state }) => state === 'pending' || state === 'blocked' || state === 'failed');
    if (unresolved) return issue(`预期结果仍处于 ${unresolved.state} 状态。`, unresolved.criterionId);

    stage = 'run';
    if (!run) return issue('缺少判定器运行及实际结果。');
    if (run.state !== 'completed') return issue(`判定器运行状态为 ${run.state}。${run.reason}`);
    if (revisionKey(run.witnessRef) !== revisionKey(witnessRef) ||
        revisionKey(run.sampleRef) !== revisionKey(sampleRef)) {
      return issue('运行回执的冻结见证或样例修订不匹配。');
    }
    revisionKey(run.receiptRef);

    stage = 'evaluator';
    const observed = new Map(run.evaluators.map(({ criterionId, evaluator }) => [criterionId, evaluator]));
    for (const { criterionId, evaluator } of item.criteria) {
      const actual = observed.get(criterionId);
      if (actual?.id !== evaluator.id || actual.version !== evaluator.version) {
        const identity = actual ? `${actual.id}@${actual.version}` : '缺失';
        return issue(`冻结判定器为 ${evaluator.id}@${evaluator.version}，实际为 ${identity}。`, criterionId);
      }
    }
    if (run.evaluators.length !== item.criteria.length) return issue('运行回执包含额外或重复的标准判定器。');

    stage = 'actual';
    if (run.actual == null) return issue('运行回执缺少实际结果。');
    const actual = assessmentResult(run.actual, release, submission);
    const outcomes = new Map(actual.outcomes.map(outcome => [outcome.criterionId, outcome]));
    stage = 'outcome';
    for (const expectedOutcome of expected.outcomes) {
      const observedOutcome = outcomes.get(expectedOutcome.criterionId);
      const difference = observedOutcome ? outcomeDifference(expectedOutcome, observedOutcome) : '缺少标准的实际结论。';
      if (difference) return issue(difference, expectedOutcome.criterionId);
    }
    return { sampleRef, submissionRef: submission.submissionRef, receiptRef: run.receiptRef };
  } catch (error) {
    return issue(reason(error));
  }
}

function checkItem(
  releaseRef: AssessmentRevisionRef,
  item: AssessmentItem,
  readVerifiedEvidence: ReadVerifiedAssessmentPublicationEvidence,
): AssessmentPublicationQualification | { readonly issues: readonly AssessmentPublicationIssue[] } {
  const { itemId, promptRef, workRef } = item;
  const target = { releaseRef, itemId };
  let stage: AssessmentPublicationIssue['stage'] = 'contract';
  const issue = (message: string, sampleRef?: AssessmentRevisionRef): AssessmentPublicationIssue => ({
    stage, itemId, reason: message, ...(sampleRef === undefined ? {} : { sampleRef }),
  });

  try {
    if (!promptRef && !workRef) return { issues: [issue('缺少冻结题面或作品修订。')] };
    stage = 'witness';
    const evidence = readVerifiedEvidence(target);
    if (!evidence) return { issues: [issue('缺少宿主确认的独立求解或可信金标见证。')] };
    const { witness } = evidence;
    revisionKey(witness.ref);
    if (witness.origin !== 'independent-solution' && witness.origin !== 'trusted-gold') {
      return { issues: [issue('见证来源须为独立求解或可信金标。')] };
    }

    stage = 'contract';
    const release = { releaseRef, items: [item] };
    const frozen = assessmentRelease({ releaseRef: witness.releaseRef, items: [witness.frozenItem] });
    if (!sameWorkbookJson(release, frozen)) return { issues: [issue('题版与独立见证绑定的冻结契约不符。')] };

    stage = 'coverage';
    const remaining = new Map(witness.requiredSampleRefs.map(ref => [revisionKey(ref), ref]));
    if (remaining.size === 0 || remaining.size !== witness.requiredSampleRefs.length) {
      return { issues: [issue('冻结覆盖清单须列出互不重复的样例修订。')] };
    }
    const issues: AssessmentPublicationIssue[] = [];
    const samples: SampleEvidence[] = [];
    for (const entry of evidence.samples) {
      const { sampleRef } = entry.sample;
      if (!remaining.delete(revisionKey(sampleRef))) {
        issues.push(issue('样例不在冻结覆盖清单内或重复提交。', sampleRef));
        continue;
      }
      const checked = checkSample(release, item, witness.ref, entry);
      if ('stage' in checked) issues.push(checked);
      else samples.push(checked);
    }
    for (const sampleRef of remaining.values()) issues.push(issue('缺少冻结标准要求的可信样例。', sampleRef));
    if (issues.length > 0) return { issues };

    return {
      ...target,
      ...(promptRef === undefined ? {} : { promptRef }),
      ...(workRef === undefined ? {} : { workRef }),
      witnessRef: witness.ref,
      criteria: item.criteria.map(({ criterionId, evaluator, source, maximum }) => ({ criterionId, evaluator, source, maximum })),
      samples,
    };
  } catch (error) {
    const message = stage === 'witness' ? '宿主见证不可读取或修订无效。' : reason(error);
    return { issues: [issue(message)] };
  }
}

export function checkAssessmentPublication(
  candidate: unknown,
  registered: readonly AssessmentEvaluatorRef[],
  readVerifiedEvidence: ReadVerifiedAssessmentPublicationEvidence,
): AssessmentPublicationDecision {
  let release: AssessmentRelease;
  try {
    release = assessmentPublicationInput(candidate, registered);
  } catch (error) {
    return { state: 'needs-review', issues: [{ stage: 'release', reason: reason(error) }] };
  }

  const { releaseRef } = release;
  const issues: AssessmentPublicationIssue[] = [];
  const items: AssessmentPublicationQualification[] = [];
  for (const item of release.items) {
    const checked = checkItem(releaseRef, item, readVerifiedEvidence);
    if ('issues' in checked) issues.push(...checked.issues);
    else items.push(checked);
  }
  return issues.length > 0 ? { state: 'needs-review', releaseRef, issues } : { state: 'eligible', releaseRef, items };
}
