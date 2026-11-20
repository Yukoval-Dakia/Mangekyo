import type { AssessmentAnswerValue, AssessmentCriterion } from './assessment-values.ts';
import { fields, list, record, text } from './parse.ts';

export const selectionConstraintEvaluator = { id: 'selection-constraint', version: '1' } as const;

function selectionIds(value: unknown, label: string) {
  return list(value).map(id => text(id, label));
}

/** Each input declares how its view-local object IDs map to comparable values. */
function readRule(criterion: AssessmentCriterion) {
  if (criterion.evaluator.id !== selectionConstraintEvaluator.id
    || criterion.evaluator.version !== selectionConstraintEvaluator.version || criterion.maximum === null)
    throw new Error('选择约束需要已知判定器版本和冻结满分。');

  const params = record(criterion.parameters);
  fields(params, 'domains', 'test');
  const allDomains = list(params.domains).map(entries => {
    const domain = new Map<string, string>();
    const values = new Set<string>();
    for (const input of list(entries)) {
      const option = record(input);
      fields(option, 'id', 'value');
      const id = text(option.id, '选择项标识');
      const value = text(option.value, '选择项的比较值');
      if (domain.has(id) || values.has(value)) throw new Error('同一作答位的选择项不能重复。');
      domain.set(id, value);
      values.add(value);
    }
    if (!domain.size) throw new Error('声明的选择项不能为空。');
    return { domain, values };
  });
  if (allDomains.length !== criterion.inputs.length) throw new Error('每个作答字段都需要自己的选择项范围。');
  const test = record(params.test);
  fields(test, 'kind', 'equals');
  if (test.kind === 'count') {
    const count = test.equals;
    if (allDomains.length !== 1 || typeof count !== 'number' || !Number.isSafeInteger(count)
      || count < 0 || count > allDomains[0]!.domain.size) throw new Error('数量约束超出作答位范围。');
    return { allDomains, test: { kind: 'count' as const, count } };
  }
  if (test.kind !== 'intersection' || allDomains.length < 2) throw new Error('交集约束至少需要两个作答位。');
  const items = selectionIds(test.equals, '交集比较值');
  if (new Set(items).size !== items.length || items.some(id => !allDomains.every(({values}) => values.has(id))))
    throw new Error('期望交集须引用每个作答位均有的不同值。');
  return { allDomains, test: { kind: 'intersection' as const, items } };
}

export function validateSelectionConstraint(criterion: AssessmentCriterion) {
  readRule(criterion);
}

/** The activity caller supplies complete inputs in the frozen criterion's address order. */
export function matchesSelectionConstraint(criterion: AssessmentCriterion, answers: readonly AssessmentAnswerValue[]): boolean {
  const { allDomains, test } = readRule(criterion);
  if (answers.length !== allDomains.length) throw new Error('请提供该标准的全部作答字段。');
  const sets = answers.map((answer, index) => {
    if (answer.kind !== 'structured') throw new Error('选择项需要结构化作答。');
    const selection = record(answer.value);
    fields(selection, 'kind', 'ids');
    if (selection.kind !== 'selection') throw new Error('请提交选择项。');
    const ids = selectionIds(selection.ids, '提交的选择项标识');
    const values = new Set<string>();
    for (const id of ids) {
      const value = allDomains[index]!.domain.get(id);
      if (value === undefined || values.has(value)) throw new Error('提交含有重复项或题面之外的选择项。');
      values.add(value);
    }
    return values;
  });
  if (test.kind === 'count') return sets[0]!.size === test.count;
  const common = new Set([...sets[0]!].filter(value => sets.every(set => set.has(value))));
  return common.size === test.items.length && test.items.every(value => common.has(value));
}
