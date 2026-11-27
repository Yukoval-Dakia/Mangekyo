import type { Json } from '@mangekyo/kernel';
import {
  parseCodeTestSuiteRule, projectCodeSandboxOutcome,
  type CodeSandboxRunReport,
} from '@mangekyo/module-content/facts/code-sandbox-contract';
import type { AssessmentCriterion, AssessmentCriterionOutcome, AssessmentRelease, AssessmentSubmission } from './assessment-values.ts';
import { criterionAnswers, isCodeTestSuiteCriterion } from './question-assessment.ts';

/**
 * Pure glue between frozen `code-test-suite@1` criteria and the injected isolated sandbox runner.
 * Expectations and hidden flags are stripped before execution; hidden-case diagnostics stay generic,
 * qualitative dimensions never count toward mastery, and a missing executor fails closed as ungradable.
 */

export type CodeSandboxRunnerInput = {
  readonly language: string;
  readonly sourceCode: string;
  readonly limits: { readonly timeoutMs: number; readonly memoryMb: number; readonly maxOutputBytes: number };
  readonly cases: readonly { readonly caseId: string; readonly input: string }[];
  readonly entrypoint?: string;
  readonly mode?: 'process' | 'container';
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
};
export type CodeSandboxRunner = (input: CodeSandboxRunnerInput) => Promise<unknown>;

type Item = AssessmentRelease['items'][number];

const ungradable = (key: { itemId: string; criterionId: string }, reason: string): AssessmentCriterionOutcome =>
  ({ ...key, state: 'ungradable', reason });

/** Evaluate one frozen code-test-suite criterion against the learner's submitted source. */
export async function evaluateCodeSandboxCriterion(
  item: Item, criterion: AssessmentCriterion, submission: AssessmentSubmission, run?: CodeSandboxRunner,
): Promise<AssessmentCriterionOutcome> {
  const key = { itemId: item.itemId, criterionId: criterion.criterionId };
  const answers = criterionAnswers(item, criterion, submission);
  const evidence = criterion.inputs.filter((_, index) => answers[index] !== undefined);
  if (!evidence.length) return { ...key, state: 'unsubmitted', reason: '未交此标准的作答。' };
  if (evidence.length !== answers.length) return { ...key, state: 'partial', evidence, reason: '此标准仍缺部分作答。' };
  if (!run) return ungradable(key, '未配置隔离代码沙箱执行器，此项无法客观评分。');
  const rule = parseCodeTestSuiteRule(criterion);
  const answer = answers[0]!;
  const sourceCode = answer.kind === 'text' ? answer.value
    : answer.kind === 'structured' ? JSON.stringify(answer.value) : undefined;
  if (sourceCode === undefined) return ungradable(key, '作答形态无法作为代码执行。');
  const cases = rule.cases.map(testCase => Object.freeze({ caseId: testCase.caseId, input: testCase.input }));
  let projection: ReturnType<typeof projectCodeSandboxOutcome>;
  try {
    const report = await run({
      language: rule.language, sourceCode, limits: rule.limits, cases,
      ...(rule.entrypoint === undefined ? {} : { entrypoint: rule.entrypoint }),
    });
    projection = projectCodeSandboxOutcome(criterion, report as CodeSandboxRunReport);
  } catch {
    return ungradable(key, '代码沙箱执行未能产生可信报告，此项无法客观评分。');
  }
  const sandboxResult = projection as unknown as Json;
  if (projection.state === 'ungradable') return ungradable(key, '沙箱执行未返回任何用例结果，此项无法客观评分。');
  if (projection.state === 'partial')
    return { ...key, state: 'partial', evidence, sandboxResult, reason: '沙箱报告缺失部分用例结果，仅能部分评分。' };
  const passed = projection.passedCount, total = projection.totalCount;
  return { ...key, state: 'scored', earned: projection.earned, evidence, sandboxResult,
    feedback: `代码测试通过 ${passed}/${total} 个用例${projection.missingCaseIds.length ? '，另有缺失用例不计入' : ''}。` };
}

/** Bank-policy dispatch: sandbox criteria evaluate asynchronously, everything else stays synchronous. */
export function isSandboxBankCriterion(criterion: AssessmentCriterion): boolean {
  return isCodeTestSuiteCriterion(criterion);
}
