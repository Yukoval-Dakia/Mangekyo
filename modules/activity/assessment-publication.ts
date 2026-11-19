import { factId } from '@mangekyo/kernel';
import {
  assessmentPublicationInput, assessmentRelease, assessmentResult, assessmentSubmission,
  type AssessmentCriterion, type AssessmentCriterionOutcome, type AssessmentEvaluatorRef,
  type AssessmentRelease, type AssessmentResult, type AssessmentRevisionRef, type AssessmentSubmission,
} from './assessment-values.ts';
import { sameWorkbookJson } from './workbook-values.ts';

type AssessmentItem = AssessmentRelease['items'][number];

export type AssessmentPublicationTarget = {
  readonly releaseRef: AssessmentRevisionRef;
  readonly itemId: string;
};

// The trusted registry freezes which sample revision must demonstrate each required coverage kind.
const REQUIRED_COVERAGE_KINDS = ['normal', 'negative', 'alternative', 'partial'] as const;
export type RequiredCoverageKind = (typeof REQUIRED_COVERAGE_KINDS)[number];
// A coverage obligation the publication gate must see demonstrated. `kind` names the
// demonstration; `criterionId` scopes it to one criterion. `applies: false` records an
// independent disposition that the kind was judged not applicable to that criterion.
export type RequiredCoverage = {
  readonly kind: RequiredCoverageKind;
  readonly criterionId: string;
  readonly applies?: boolean | undefined;
};

export type AssessmentPublicationWitness = {
  readonly ref: AssessmentRevisionRef;
  readonly origin: 'independent-solution' | 'trusted-gold';
  readonly releaseRef: AssessmentRevisionRef;
  readonly frozenItem: AssessmentItem;
  readonly requiredSampleRefs: readonly AssessmentRevisionRef[];
  // The trusted registry's frozen coverage contract, fixed before publication. Each
  // entry pins which trusted sample revision must demonstrate a coverage kind for a
  // criterion; `applies: false` records an independent not-applicable disposition.
  readonly requiredCoverage: readonly (RequiredCoverage & { readonly sampleRef: AssessmentRevisionRef })[];
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
  readonly stage: 'release' | 'witness' | 'contract' | 'coverage' | 'plan' | 'submission' | 'expected' | 'run' | 'evaluator' | 'actual' | 'outcome';
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

function revision(value: unknown): AssessmentRevisionRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { id, rev } = value as { id?: unknown; rev?: number };
  if (typeof id !== 'string' || typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) return undefined;
  return { id: factId(id), rev: rev as AssessmentRevisionRef['rev'] };
}

type Demonstration = { readonly kinds: Set<RequiredCoverageKind>; readonly values: unknown };

/** A successful run must demonstrate the result class required by the trusted sample plan. */
function coverageKinds(item: AssessmentItem, submission: AssessmentSubmission, expected: AssessmentResult) {
  const results = new Map<string, Demonstration>();
  for (const criterion of item.criteria) {
    const outcome = expected.outcomes.find(entry => entry.criterionId === criterion.criterionId);
    if (!outcome) continue;
    const values = criterion.inputs.map(input => submission.answers.find(answer =>
      answer.itemId === item.itemId && answer.slotId === input.slotId && answer.path === input.path,
    )?.value ?? null);
    const kinds = new Set<RequiredCoverageKind>();
    results.set(criterion.criterionId, { kinds, values });
    switch (outcome.state) {
      case 'scored':
        if (outcome.earned === criterion.maximum) {
          kinds.add('normal');
          if (alternativeRequired(criterion)) kinds.add('alternative');
        } else kinds.add(outcome.earned === 0 ? 'negative' : 'partial');
        break;
      case 'qualitative':
        kinds.add(criterion.maximum === null ? 'normal' : 'partial');
        break;
      case 'partial':
        kinds.add('partial');
        break;
      case 'unsubmitted':
      case 'insufficient-evidence':
        kinds.add('negative');
        break;
    }
  }
  return results;
}

function alternativeRequired(criterion: AssessmentCriterion): boolean {
  const parameters = criterion.parameters as { alternatives?: unknown; equivalentAnswers?: unknown } | null;
  return [parameters?.alternatives, parameters?.equivalentAnswers].some(value => Array.isArray(value) && value.length > 1);
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
): (SampleEvidence & { readonly kinds: ReadonlyMap<string, Demonstration> }) | AssessmentPublicationIssue {
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
    return { sampleRef, submissionRef: submission.submissionRef, receiptRef: run.receiptRef, kinds: coverageKinds(item, submission, expected) };
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
    const listed = new Map(witness.requiredSampleRefs.map(ref => [revisionKey(ref), ref]));
    if (listed.size === 0 || listed.size !== witness.requiredSampleRefs.length) {
      return { issues: [issue('冻结覆盖清单须列出互不重复的样例修订。')] };
    }
    const criteria = new Set(item.criteria.map(criterion => criterion.criterionId));
    const coverage = new Map<string, RequiredCoverage & { readonly sampleRef: AssessmentRevisionRef }>();
    const requirementIssues: AssessmentPublicationIssue[] = [];
    for (const requirement of witness.requiredCoverage ?? []) {
      const bad = (message: string) => requirementIssues.push(issue(message, requirement?.sampleRef));
      if (!requirement || !(REQUIRED_COVERAGE_KINDS as readonly string[]).includes(requirement.kind)) {
        bad(`覆盖项 ${JSON.stringify(requirement?.kind)} 不是已登记的覆盖类型。`);
        continue;
      }
      if (typeof requirement.criterionId !== 'string' || !criteria.has(requirement.criterionId)) {
        bad(`覆盖项引用了未冻结的标准 ${JSON.stringify(requirement.criterionId)}。`);
        continue;
      }
      const sampleRef = revision(requirement.sampleRef);
      if (!sampleRef) {
        bad('覆盖项须指定明确的样例修订。');
        continue;
      }
      if (!listed.has(revisionKey(sampleRef))) {
        bad('覆盖项指定的样例不在冻结覆盖清单内。');
        continue;
      }
      const key = `${requirement.kind}:${requirement.criterionId}`;
      if (coverage.has(key)) {
        requirementIssues.push(issue(`覆盖项 ${requirement.kind} 在标准 ${requirement.criterionId} 上重复登记。`, sampleRef));
        continue;
      }
      coverage.set(key, { kind: requirement.kind, criterionId: requirement.criterionId, applies: requirement.applies, sampleRef });
    }
    if (requirementIssues.length > 0) return { issues: requirementIssues };
    // normal, negative and partial always need an applicable entry per criterion.
    // alternative only applies to criteria that froze multiple legitimate solutions.
    // `applies: false` is an independent disposition that lifts the obligation.
    for (const criterion of item.criteria) {
      for (const kind of REQUIRED_COVERAGE_KINDS) {
        if (kind === 'alternative' && !alternativeRequired(criterion)) continue;
        const requirement = coverage.get(`${kind}:${criterion.criterionId}`);
        if (requirement?.applies === false && (kind === 'normal' || kind === 'alternative')) {
          return { issues: [issue(`标准 ${criterion.criterionId} 的 ${kind} 覆盖项需要实际样例。`)] };
        }
        if (!requirement) return { issues: [issue(`冻结覆盖清单缺少标准 ${criterion.criterionId} 的 ${kind} 覆盖项。`)] };
      }
    }
    const issues: AssessmentPublicationIssue[] = [];
    const samples: SampleEvidence[] = [];
    const demonstrated = new Map<string, ReadonlyMap<string, Demonstration>>();
    for (const entry of evidence.samples) {
      const { sampleRef } = entry.sample;
      if (!listed.delete(revisionKey(sampleRef))) {
        issues.push(issue('样例不在冻结覆盖清单内或重复提交。', sampleRef));
        continue;
      }
      const checked = checkSample(release, item, witness.ref, entry);
      if ('stage' in checked) issues.push(checked);
      else {
        const { kinds, ...evidence } = checked;
        samples.push(evidence);
        demonstrated.set(revisionKey(sampleRef), kinds);
      }
    }
    for (const sampleRef of listed.values()) issues.push(issue('缺少冻结标准要求的可信样例。', sampleRef));
    if (issues.length > 0) return { issues };

    stage = 'plan';
    for (const { kind, criterionId, sampleRef, applies } of coverage.values()) {
      if (applies === false) continue;
      const actual = demonstrated.get(revisionKey(sampleRef))?.get(criterionId);
      const normal = kind === 'alternative' ? coverage.get(`normal:${criterionId}`) : undefined;
      const primary = normal && demonstrated.get(revisionKey(normal.sampleRef))?.get(criterionId);
      if (!actual?.kinds.has(kind) || (primary && sameWorkbookJson(primary.values, actual.values))) {
        return { issues: [issue(`样例未在标准 ${criterionId} 上演示已登记的 ${kind} 覆盖。`, sampleRef)] };
      }
    }

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
