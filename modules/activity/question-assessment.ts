import type { FactId, Revision } from '@mangekyo/kernel';
import {
  matchesSelectionConstraint, selectionConstraintEvaluator, validateSelectionConstraint,
} from '@mangekyo/module-content/facts/assessment';
import {
  assessmentSubmission, type AssessmentAnswerValue, type AssessmentCriterion, type AssessmentCriterionOutcome,
  type AssessmentRelease, type AssessmentRevisionRef, type AssessmentSubmission,
} from './assessment-values.ts';
import { sameWorkbookJson, type WorkbookAnswer } from './workbook-values.ts';

type Item = AssessmentRelease['items'][number];
const frozenValueEvaluator = { id: 'frozen-value-match', version: '1' };
const emptySelection = { kind: 'structured', value: { kind: 'selection', ids: [] } } as const;

const selection = (criterion: AssessmentCriterion) => sameWorkbookJson(criterion.evaluator, selectionConstraintEvaluator);
export const isLocalQuestionCriterion = (criterion: AssessmentCriterion) =>
  selection(criterion) || sameWorkbookJson(criterion.evaluator, frozenValueEvaluator);

function alternatives(item: Item, criterion: AssessmentCriterion, releaseRef: AssessmentRevisionRef) {
  const parameters = criterion.parameters as { alternatives?: unknown; value?: unknown } | null;
  let sets = parameters?.alternatives;
  if (parameters && Object.keys(parameters).length === 1 && Object.hasOwn(parameters, 'value') && criterion.inputs.length === 1) {
    const address = criterion.inputs[0]!;
    const kind = item.slots.find(slot => slot.slotId === address.slotId)?.fields.find(field => field.path === address.path)?.kind;
    sets = [[{ kind, value: parameters.value, ...(kind === 'numeric' ? { unit: null } : {}) }]];
  }
  if (!isLocalQuestionCriterion(criterion) || criterion.maximum === null || !parameters ||
      Object.keys(parameters).length !== 1 || !Array.isArray(sets) || sets.length < 1 || sets.length > 16)
    throw new Error('固定值规则需要满分和 1–16 套作答方案。');
  const parsedSets = sets.map(set => {
    if (!Array.isArray(set) || set.length !== criterion.inputs.length) throw new Error('每套方案须覆盖所有标准输入。');
    const parsed = assessmentSubmission({
      releaseRef, submissionRef: releaseRef,
      answers: criterion.inputs.map((input, index) => ({
        ...input, itemId: item.itemId, schemaVersion: item.slots.find(slot => slot.slotId === input.slotId)?.schemaVersion,
        value: set[index],
      })),
    }, { releaseRef, items: [item] });
    if (parsed.answers.some(({ value }) => value.kind === 'trace' || value.kind === 'attachment'))
      throw new Error('固定值规则不评估附件或轨迹引用。');
    return parsed.answers.map(({ value }) => value);
  });
  if (parsedSets.some((set, index) => parsedSets.slice(0, index).some(other => sameWorkbookJson(set, other))))
    throw new Error('作答方案不能重复。');
  return parsedSets;
}

function answerAddress(item: Item, slot: NonNullable<Item['slots'][number]>, value: AssessmentAnswerValue) {
  return { itemId: item.itemId, slotId: slot.slotId, schemaVersion: slot.schemaVersion, path: '', value };
}

export function validateBankItem(item: Item, releaseRef: AssessmentRevisionRef) {
  for (const criterion of item.criteria) {
    if (!isLocalQuestionCriterion(criterion)) throw new Error('题库评估方法当前不可用。');
    if (selection(criterion)) {
      if (criterion.inputs.some(input => !item.slots.find(slot => slot.slotId === input.slotId)?.fields.some(
        field => field.path === input.path && field.kind === 'structured'))) throw new Error('选择约束须绑定结构化字段。');
      validateSelectionConstraint(criterion);
    } else {
      alternatives(item, criterion, releaseRef);
    }
  }
}

function criterionAnswers(item: Item, criterion: AssessmentCriterion, submission: AssessmentSubmission) {
  return criterion.inputs.map(({ slotId, path }) => submission.answers.find(answer =>
    answer.itemId === item.itemId && answer.slotId === slotId && answer.path === path)?.value);
}

export function evaluateBankCriterion(item: Item, criterion: AssessmentCriterion, submission: AssessmentSubmission): AssessmentCriterionOutcome {
  const key = { itemId: item.itemId, criterionId: criterion.criterionId };
  const answers = criterionAnswers(item, criterion, submission);
  const evidence = criterion.inputs.filter((_, index) => answers[index] !== undefined);
  if (!evidence.length) return { ...key, state: 'unsubmitted', reason: '未交此标准的作答。' };
  if (evidence.length !== answers.length) return { ...key, state: 'partial', evidence, reason: '此标准仍缺部分作答。' };
  const complete = answers as AssessmentAnswerValue[];
  const proportion = selection(criterion)
    ? Number(matchesSelectionConstraint(criterion, complete))
    : Math.max(...alternatives(item, criterion, submission.releaseRef).map(plan =>
      plan.filter((value, index) => sameWorkbookJson(value, complete[index])).length)) / evidence.length;
  return { ...key, state: 'scored', earned: criterion.maximum! * proportion, evidence };
}

function bankAnswers(item: Item, raw: string) {
  const [first] = item.slots;
  const [field] = first!.fields;
  if (item.slots.length === 1 && first!.fields.length === 1 && field?.kind === 'text' && field.path === '')
    return [{ itemId: item.itemId, slotId: first!.slotId, schemaVersion: first!.schemaVersion, path: '', value: { kind: 'text', value: raw } }];
  let inputs: unknown;
  try { inputs = JSON.parse(raw); } catch { throw new Error('结构化作答须为 JSON 列表。'); }
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('结构化作答须为非空 JSON 列表。');
  return inputs.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['slotId', 'path', 'value'].includes(key)))
      throw new Error('作答字段只接受 slotId、path 和 value。');
    return { ...input, itemId: item.itemId, schemaVersion: item.slots.find(slot => slot.slotId === input.slotId)?.schemaVersion };
  });
}

export function frozenWorkbookSubmission(
  release: AssessmentRelease,
  submissionRef: AssessmentRevisionRef,
  answers: Record<string, WorkbookAnswer>,
  questionAttachments?: Record<string, readonly { originalId: FactId; rev: Revision }[]>,
) {
  const submission = assessmentSubmission({
    releaseRef: release.releaseRef,
    submissionRef,
    answers: release.items.flatMap(item => {
      const answer = answers[item.itemId];
      const attachments = questionAttachments?.[item.itemId];
      if (item.criteria.every(isLocalQuestionCriterion)) {
        if (typeof answer !== 'string') return [];
        if (answer.length > 16_000) throw new Error('自动评估作答过长。');
        return bankAnswers(item, answer);
      }
      const slot = item.slots[0]!;
      const fieldKind = slot.fields[0]?.kind;
      if (fieldKind === 'attachment') {
        const primary = attachments?.[0];
        if (!primary) return [];
        return [answerAddress(item, slot, { kind: 'attachment' as const, ref: { id: primary.originalId, rev: primary.rev } })];
      }
      if (typeof answer !== 'string') return [];
      if (answer.length > 16_000) throw new Error('自动评估作答过长。');
      return [answerAddress(item, slot, { kind: 'text' as const, value: answer })];
    }),
  }, release);
  for (const item of release.items) {
    for (const criterion of item.criteria.filter(selection)) {
      const inputs = criterionAnswers(item, criterion, submission);
      if (inputs.some(value => value !== undefined))
        matchesSelectionConstraint(criterion, inputs.map(value => value ?? emptySelection));
    }
  }
  return submission;
}
