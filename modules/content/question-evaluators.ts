import type { BankAnswerRowWire } from '@mangekyo/kernel';
import type { AnswerSlot, AssessmentAnswerValue, AssessmentCriterion, AssessmentEvaluatorRef } from './assessment-values.ts';
import {
  absRational, addRationals, compareRationals, fields, list, rationalOf, rationalToNumber, record, subtractRationals, type Rational,
} from './parse.ts';

export type ExtendedEvaluationResult = {
  readonly matched: boolean; readonly proportion: number; readonly earned: number; readonly bestSchemeIndex?: number;
  readonly bestSchemeId?: string;
};
export type BankAnswerRow = BankAnswerRowWire;

export const numericEquivalenceEvaluator = { id: 'numeric-equivalence', version: '1' } as const;
export const multiSchemeBestEvaluator = { id: 'multi-scheme-best', version: '1' } as const;
export const rangeConstraintEvaluator = { id: 'range-constraint', version: '1' } as const;
export const extendedQuestionEvaluators = [numericEquivalenceEvaluator, multiSchemeBestEvaluator, rangeConstraintEvaluator] as const;

const answerNumberPattern = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?\d+\s*\/\s*\d+)((?:\s+[^\s].*)?)$/;

function requireMaximum(criterion: AssessmentCriterion, label: string) {
  if (criterion.maximum === null) throw new Error(`${label}需要冻结满分。`);
  return criterion.maximum;
}

function requireEvaluator(criterion: AssessmentCriterion, ref: AssessmentEvaluatorRef) {
  if (criterion.evaluator.id !== ref.id || criterion.evaluator.version !== ref.version) throw new Error('扩展题目评估需要已知判定器版本。');
}

function normalizeUnit(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new Error('答案单位无效。');
  const unit = value.trim().replace(/\s+/gu, ' ');
  if (unit.length > 120) throw new Error('答案单位过长。');
  return unit ? unit : null;
}

/** Collapses whitespace in a learner-supplied unit; empty means no unit. */
function squashUnit(value: string | null | undefined): string | null | undefined {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') || null : value;
}

function unitRequirement(unit: string | null | undefined, acceptedUnits: readonly string[]) {
  if (acceptedUnits.length) {
    if (unit !== undefined && unit !== null && !acceptedUnits.includes(unit)) throw new Error('答案单位不在接受范围内。');
    return (actual: string | null | undefined) => actual !== undefined && actual !== null && acceptedUnits.includes(actual);
  }
  if (unit !== undefined && unit !== null) return (actual: string | null | undefined) => actual === unit;
  return () => true;
}

function textNumericAnswer(raw: string): { readonly number: string; readonly unit: string | null } | null {
  const match = answerNumberPattern.exec(raw.trim());
  if (!match || rationalOf(match[1]!) === null) return null;
  const tail = match[2]!.trim();
  return { number: match[1]!, unit: tail ? tail.replace(/\s+/gu, ' ') : null };
}

type NumericInput = { readonly number: number | string; readonly unit: string | null | undefined };
function numericInput(answer: AssessmentAnswerValue): NumericInput | null {
  if (answer.kind === 'numeric') return { number: answer.value, unit: squashUnit(answer.unit) };
  if (answer.kind === 'text') {
    const parsed = textNumericAnswer(answer.value);
    return parsed && { number: parsed.number, unit: parsed.unit };
  }
  if (answer.kind === 'structured' && !Array.isArray(answer.value)) {
    const view = answer.value as { readonly kind?: unknown; readonly value?: unknown; readonly unit?: unknown };
    if (view.kind !== 'range' || typeof view.value !== 'number' || !Number.isFinite(view.value)) return null;
    if (view.unit !== undefined && view.unit !== null && typeof view.unit !== 'string') return null;
    return { number: view.value, unit: squashUnit(view.unit as string | null | undefined) };
  }
  return null;
}

function finiteParam(value: unknown, label: string): Rational {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是有限数值。`);
  return rationalOf(value)!;
}

function readNumericRule(criterion: AssessmentCriterion) {
  requireEvaluator(criterion, numericEquivalenceEvaluator);
  requireMaximum(criterion, '数值等价评估');
  if (criterion.inputs.length !== 1) throw new Error('数值等价评估只支持单个作答字段。');
  const params = record(criterion.parameters);
  fields(params, 'expected', 'tolerance', 'unit', 'acceptedUnits');
  if (!Object.hasOwn(params, 'expected') || !Object.hasOwn(params, 'tolerance')) throw new Error('数值等价评估需要期望值与容差。');
  if (typeof params.expected !== 'number' && typeof params.expected !== 'string') throw new Error('期望数值无效。');
  const expected = rationalOf(params.expected as number | string);
  if (expected === null) throw new Error('期望数值无效。');
  const tolerance = finiteParam(params.tolerance, '数值容差');
  if (tolerance.numerator < 0n) throw new Error('数值容差必须是非负有限数值。');
  const unit = normalizeUnit(params.unit);
  const acceptedUnits = params.acceptedUnits === undefined ? [] : list(params.acceptedUnits).map(entry => {
    const normalized = normalizeUnit(entry);
    if (normalized === undefined || normalized === null) throw new Error('接受单位必须是非空文字。');
    return normalized;
  });
  if (new Set(acceptedUnits).size !== acceptedUnits.length) throw new Error('接受单位重复。');
  if (unit !== undefined && unit !== null && acceptedUnits.length && !acceptedUnits.includes(unit)) throw new Error('默认单位须在接受范围内。');
  return { expected, tolerance, accepts: unitRequirement(unit, acceptedUnits) };
}

export function declaredSlotKinds(criterion: AssessmentCriterion, slots: readonly AnswerSlot[]) {
  return criterion.inputs.map(({ slotId, path }) => {
    const kind = slots.find(slot => slot.slotId === slotId)?.fields.find(field => field.path === path)?.kind;
    if (!kind) throw new Error(`标准 ${criterion.criterionId} 引用了未声明的作答位或路径。`);
    return kind;
  });
}

function validateAnswerFieldKind(criterion: AssessmentCriterion, slots: readonly AnswerSlot[] | undefined) {
  if (slots === undefined) return;
  const [kind] = declaredSlotKinds(criterion, slots);
  if (kind !== 'numeric' && kind !== 'text' && kind !== 'structured') throw new Error('数值评估须绑定数值、文本或结构化字段。');
}

export function validateNumericEquivalence(criterion: AssessmentCriterion, slots?: readonly AnswerSlot[]): void {
  readNumericRule(criterion);
  validateAnswerFieldKind(criterion, slots);
}

export function evaluateNumericEquivalence(
  criterion: AssessmentCriterion, answers: readonly AssessmentAnswerValue[],
): ExtendedEvaluationResult {
  const rule = readNumericRule(criterion);
  const maximum = requireMaximum(criterion, '数值等价评估');
  if (answers.length !== 1) throw new Error('请提供该标准的全部作答字段。');
  const input = numericInput(answers[0]!);
  // Exact rational comparison: huge magnitudes cannot overflow to Infinity/NaN, and there is no float slack.
  const actual = input !== null && rule.accepts(input.unit) ? rationalOf(input.number) : null;
  const matched = actual !== null && compareRationals(absRational(subtractRationals(actual, rule.expected)), rule.tolerance) <= 0;
  return { matched, proportion: matched ? 1 : 0, earned: matched ? maximum : 0 };
}

type SchemePlan = {
  readonly schemeId?: string; readonly weight: number; readonly match: 'all' | 'proportional';
  readonly answers: readonly AssessmentAnswerValue[];
};

function comparableAnswer(value: unknown): AssessmentAnswerValue | null {
  try {
    const row = record(value);
    if (row.kind === 'numeric') {
      fields(row, 'kind', 'value', 'unit');
      const unit = normalizeUnit(row.unit);
      if (typeof row.value !== 'number' || !Number.isFinite(row.value) || unit === undefined) return null;
      return { kind: 'numeric', value: row.value, unit };
    }
    if (row.kind === 'text') {
      fields(row, 'kind', 'value');
      return typeof row.value === 'string' && row.value.trim() ? { kind: 'text', value: row.value } : null;
    }
    if (row.kind === 'structured') {
      fields(row, 'kind', 'value');
      const structured = record(row.value);
      fields(structured, 'kind', 'ids');
      const ids = list(structured.ids);
      if ((structured.kind !== 'selection' && structured.kind !== 'breaks') ||
          ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return null;
      return { kind: 'structured', value: { kind: structured.kind, ids: ids as string[] } };
    }
  } catch {
    return null;
  }
  return null;
}

function readMultiSchemeRule(criterion: AssessmentCriterion) {
  requireEvaluator(criterion, multiSchemeBestEvaluator);
  requireMaximum(criterion, '多方案择优评估');
  const params = record(criterion.parameters);
  fields(params, 'schemes');
  const rows = list(params.schemes);
  if (rows.length < 1 || rows.length > 16) throw new Error('多方案择优评估需要 1–16 套作答方案。');
  const schemeIds = new Set<string>();
  const schemes: SchemePlan[] = rows.map(input => {
    const row = record(input);
    fields(row, 'schemeId', 'weight', 'match', 'answers');
    const schemeId = row.schemeId;
    if (schemeId !== undefined) {
      if (typeof schemeId !== 'string' || !schemeId.trim() || schemeIds.has(schemeId)) throw new Error('方案标识重复或无效。');
      schemeIds.add(schemeId);
    }
    const weight = row.weight === undefined ? 1 : row.weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1) throw new Error('方案权重须在 (0, 1] 内。');
    const match = row.match === undefined ? 'all' : row.match;
    if (match !== 'all' && match !== 'proportional') throw new Error('方案匹配方式无效。');
    const answers = list(row.answers).map(value => {
      const answer = comparableAnswer(value);
      if (!answer) throw new Error('方案作答无效，或含附件、轨迹引用。');
      return answer;
    });
    if (answers.length !== criterion.inputs.length) throw new Error('每套方案须覆盖所有标准输入。');
    return { ...(schemeId === undefined ? {} : { schemeId }), weight, match, answers };
  });
  return { schemes };
}

function selectionEqual(expectedIds: readonly string[], given: unknown): boolean {
  if (!Array.isArray(given) || given.length !== expectedIds.length) return false;
  const required = new Set(expectedIds), seen = new Set<string>();
  for (const id of given) {
    if (typeof id !== 'string' || !required.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return seen.size === required.size;
}

function answersEqual(expected: AssessmentAnswerValue, actual: AssessmentAnswerValue): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === 'numeric' && actual.kind === 'numeric') {
    const left = rationalOf(expected.value), right = rationalOf(actual.value);
    return (expected.unit === null || squashUnit(actual.unit) === expected.unit) &&
      left !== null && right !== null && compareRationals(left, right) === 0;
  }
  if (expected.kind === 'text' && actual.kind === 'text') {
    return expected.value.trim().replace(/\s+/gu, ' ') === actual.value.trim().replace(/\s+/gu, ' ');
  }
  if (expected.kind === 'structured' && actual.kind === 'structured' &&
      !Array.isArray(expected.value) && !Array.isArray(actual.value)) {
    const left = expected.value as { kind?: unknown; ids?: unknown }, right = actual.value as { kind?: unknown; ids?: unknown };
    if ((left.kind !== 'selection' && left.kind !== 'breaks') || left.kind !== right.kind || !Array.isArray(left.ids)) return false;
    return selectionEqual(left.ids, right.ids);
  }
  return false;
}

export function validateMultiSchemeBest(criterion: AssessmentCriterion, slots?: readonly AnswerSlot[]): void {
  const { schemes } = readMultiSchemeRule(criterion);
  if (slots !== undefined) {
    const kinds = declaredSlotKinds(criterion, slots);
    if (kinds.some(kind => kind === 'attachment' || kind === 'trace')) throw new Error('多方案择优评估不支持附件或轨迹字段。');
    if (schemes.some(scheme => scheme.answers.some((answer, index) => answer.kind !== kinds[index]))) throw new Error('方案作答类型须与声明的作答字段一致。');
  }
}

export function evaluateMultiSchemeBest(
  criterion: AssessmentCriterion, answers: readonly AssessmentAnswerValue[],
): ExtendedEvaluationResult {
  const { schemes } = readMultiSchemeRule(criterion);
  const maximum = requireMaximum(criterion, '多方案择优评估');
  if (answers.length !== criterion.inputs.length) throw new Error('请提供该标准的全部作答字段。');
  let bestProportion = 0, bestIndex = -1;
  for (const [index, scheme] of schemes.entries()) {
    const hits = scheme.answers.filter((expected, inputIndex) => answersEqual(expected, answers[inputIndex]!)).length;
    if (scheme.match === 'all' && hits !== scheme.answers.length) continue;
    const proportion = scheme.weight * (scheme.match === 'all' ? 1 : hits / scheme.answers.length);
    if (proportion > bestProportion + 1e-12) {
      bestProportion = proportion;
      bestIndex = index;
    }
  }
  const bestScheme = bestIndex >= 0 ? schemes[bestIndex]! : undefined;
  return {
    matched: bestProportion > 0, proportion: bestProportion, earned: maximum * bestProportion,
    ...(bestIndex >= 0 ? { bestSchemeIndex: bestIndex } : {}),
    ...(bestScheme?.schemeId !== undefined ? { bestSchemeId: bestScheme.schemeId } : {}),
  };
}

function readRangeRule(criterion: AssessmentCriterion) {
  requireEvaluator(criterion, rangeConstraintEvaluator);
  requireMaximum(criterion, '范围约束评估');
  if (criterion.inputs.length !== 1) throw new Error('范围约束评估只支持单个作答字段。');
  const params = record(criterion.parameters);
  fields(params, 'min', 'max', 'inclusiveMin', 'inclusiveMax', 'target', 'tolerance', 'unit', 'partialMargin');
  const hasInterval = params.min !== undefined || params.max !== undefined;
  const hasTarget = params.target !== undefined || params.tolerance !== undefined;
  if (hasInterval === hasTarget) throw new Error('范围约束评估需要区间模式或目标容差模式之一。');
  if ((params.inclusiveMin !== undefined && typeof params.inclusiveMin !== 'boolean') ||
      (params.inclusiveMax !== undefined && typeof params.inclusiveMax !== 'boolean')) {
    throw new Error('区间端点开关须为布尔值。');
  }
  let min: Rational, max: Rational, inclusiveMin: boolean, inclusiveMax: boolean;
  if (hasInterval) {
    if (params.min === undefined || params.max === undefined) throw new Error('区间模式需要上下界。');
    min = finiteParam(params.min, '区间下界');
    max = finiteParam(params.max, '区间上界');
    if (compareRationals(min, max) > 0) throw new Error('区间下界不能大于上界。');
    inclusiveMin = params.inclusiveMin !== false;
    inclusiveMax = params.inclusiveMax !== false;
    if (compareRationals(min, max) === 0 && (!inclusiveMin || !inclusiveMax)) throw new Error('区间不能为空。');
  } else {
    if (params.target === undefined || params.tolerance === undefined) throw new Error('目标容差模式需要目标数值与容差。');
    if (params.inclusiveMin !== undefined || params.inclusiveMax !== undefined) throw new Error('目标容差模式不能混用区间端点字段。');
    const target = finiteParam(params.target, '目标数值');
    const tolerance = finiteParam(params.tolerance, '目标容差');
    if (tolerance.numerator < 0n) throw new Error('目标容差必须是非负有限数值。');
    min = subtractRationals(target, tolerance);
    max = addRationals(target, tolerance);
    inclusiveMin = inclusiveMax = true;
  }
  const partialMargin = params.partialMargin === undefined ? 0 : rationalToNumber(finiteParam(params.partialMargin, '部分给分宽度'));
  if (!(partialMargin >= 0)) throw new Error('部分给分宽度必须非负。');
  const unit = normalizeUnit(params.unit);
  return { min, max, inclusiveMin, inclusiveMax, partialMargin, accepts: unitRequirement(unit, []) };
}

export function validateRangeConstraint(criterion: AssessmentCriterion, slots?: readonly AnswerSlot[]): void {
  readRangeRule(criterion);
  validateAnswerFieldKind(criterion, slots);
}

export function evaluateRangeConstraint(
  criterion: AssessmentCriterion, answers: readonly AssessmentAnswerValue[],
): ExtendedEvaluationResult {
  const rule = readRangeRule(criterion);
  const maximum = requireMaximum(criterion, '范围约束评估');
  if (answers.length !== 1) throw new Error('请提供该标准的全部作答字段。');
  const input = numericInput(answers[0]!);
  let proportion = 0;
  if (input !== null && rule.accepts(input.unit)) {
    const value = rationalOf(input.number);
    if (value !== null) {
      const compareMin = compareRationals(value, rule.min), compareMax = compareRationals(value, rule.max);
      if (compareMin < 0 || compareMax > 0) {
        if (rule.partialMargin > 0) {
          const distance = rationalToNumber(absRational(subtractRationals(value, compareMin < 0 ? rule.min : rule.max)));
          proportion = Math.max(0, 1 - Math.max(0, distance) / rule.partialMargin);
        }
      } else if ((compareMin !== 0 || rule.inclusiveMin) && (compareMax !== 0 || rule.inclusiveMax)) {
        // An endpoint of an exclusive bound lies strictly outside the open interval, so it never earns credit.
        proportion = 1;
      }
    }
  }
  return { matched: proportion > 0, proportion, earned: maximum * proportion };
}

export function isExtendedQuestionEvaluator(evaluator: AssessmentEvaluatorRef): boolean {
  return extendedQuestionEvaluators.some(entry => entry.id === evaluator.id && entry.version === evaluator.version);
}

export function validateExtendedQuestionCriterion(criterion: AssessmentCriterion, slots?: readonly AnswerSlot[]): void {
  if (criterion.evaluator.id === numericEquivalenceEvaluator.id) return validateNumericEquivalence(criterion, slots);
  if (criterion.evaluator.id === multiSchemeBestEvaluator.id) return validateMultiSchemeBest(criterion, slots);
  if (criterion.evaluator.id === rangeConstraintEvaluator.id) return validateRangeConstraint(criterion, slots);
  throw new Error('未知的扩展题目判定器。');
}

export function evaluateExtendedQuestionCriterion(
  criterion: AssessmentCriterion, answers: readonly AssessmentAnswerValue[],
): number {
  if (criterion.evaluator.id === numericEquivalenceEvaluator.id) return evaluateNumericEquivalence(criterion, answers).proportion;
  if (criterion.evaluator.id === multiSchemeBestEvaluator.id) return evaluateMultiSchemeBest(criterion, answers).proportion;
  if (criterion.evaluator.id === rangeConstraintEvaluator.id) return evaluateRangeConstraint(criterion, answers).proportion;
  throw new Error('未知的扩展题目判定器。');
}
