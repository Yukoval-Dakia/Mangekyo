import type { AnswerSlot, AssessmentAnswerValue, AssessmentCriterion, AssessmentEvaluatorRef } from './assessment-values.ts';
import { fields, list, record } from './parse.ts';

export type ExtendedEvaluationResult = {
  readonly matched: boolean;
  readonly proportion: number;
  readonly earned: number;
  readonly bestSchemeIndex?: number;
  readonly bestSchemeId?: string;
};

export const numericEquivalenceEvaluator = { id: 'numeric-equivalence', version: '1' } as const;
export const multiSchemeBestEvaluator = { id: 'multi-scheme-best', version: '1' } as const;
export const rangeConstraintEvaluator = { id: 'range-constraint', version: '1' } as const;
export const extendedQuestionEvaluators = [
  numericEquivalenceEvaluator, multiSchemeBestEvaluator, rangeConstraintEvaluator,
] as const;

type Rational = { readonly numerator: bigint; readonly denominator: bigint };
const decimalPattern = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const fractionPattern = /^([+-]?\d+)\s*\/\s*(\d+)$/;
const answerNumberPattern = /^([+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?|[+-]?\d+\s*\/\s*\d+)((?:\s+[^\s].*)?)$/;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

function normalizeRational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new Error('有理分数的分母不能为 0。');
  let n = numerator, d = denominator;
  if (d < 0n) [n, d] = [-n, -d];
  const divisor = gcd(n, d);
  return { numerator: n / divisor, denominator: d / divisor };
}

function decimalRational(raw: string): Rational | null {
  const match = decimalPattern.exec(raw.trim());
  if (!match) return null;
  const [, sign = '', integer = '0', fraction = '', exponent = ''] = match;
  const digits = integer + fraction;
  const shift = Number(exponent || 0) - fraction.length;
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 512 || digits.replace(/^0+/, '').length > 512) return null;
  const coefficient = BigInt((sign === '-' ? '-' : '') + digits);
  return shift >= 0
    ? normalizeRational(coefficient * 10n ** BigInt(shift), 1n)
    : normalizeRational(coefficient, 10n ** BigInt(-shift));
}

function rationalOf(value: number | string): Rational | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return decimalRational(String(value));
  }
  const trimmed = value.trim();
  const fraction = fractionPattern.exec(trimmed);
  if (fraction) {
    const numerator = fraction[1]!.replace(/^[+-]/, '').replace(/^0+/, '');
    if (numerator.length > 512 || fraction[2]!.replace(/^0+/, '').length > 512) return null;
    const denominator = BigInt(fraction[2]!);
    if (denominator === 0n) return null;
    return normalizeRational(BigInt(fraction[1]!), denominator);
  }
  return decimalRational(trimmed);
}

function finiteNumber(value: number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const rational = rationalOf(value);
  return rational === null ? null : Number(rational.numerator) / Number(rational.denominator);
}

function requireMaximum(criterion: AssessmentCriterion, label: string) {
  if (criterion.maximum === null) throw new Error(`${label}需要冻结满分。`);
  return criterion.maximum;
}

function requireEvaluator(criterion: AssessmentCriterion, ref: AssessmentEvaluatorRef) {
  if (criterion.evaluator.id !== ref.id || criterion.evaluator.version !== ref.version) {
    throw new Error('扩展题目评估需要已知判定器版本。');
  }
}

function normalizeUnit(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('答案单位无效。');
  const unit = value.trim().replace(/\s+/gu, ' ');
  if (unit.length > 120) throw new Error('答案单位过长。');
  return unit ? unit : null;
}

function unitRequirement(unit: string | null | undefined, acceptedUnits: readonly string[]) {
  if (acceptedUnits.length) {
    if (unit !== undefined && unit !== null && !acceptedUnits.includes(unit)) {
      throw new Error('答案单位不在接受范围内。');
    }
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
  if (answer.kind === 'numeric') return { number: answer.value, unit: answer.unit };
  if (answer.kind === 'text') {
    const parsed = textNumericAnswer(answer.value);
    return parsed && { number: parsed.number, unit: parsed.unit };
  }
  if (answer.kind === 'structured' && !Array.isArray(answer.value)) {
    const view = answer.value as { readonly kind?: unknown; readonly value?: unknown; readonly unit?: unknown };
    if (view.kind !== 'range' || typeof view.value !== 'number' || !Number.isFinite(view.value)) return null;
    const unit = view.unit;
    if (unit !== undefined && unit !== null && typeof unit !== 'string') return null;
    return { number: view.value, unit: typeof unit === 'string' ? unit.replace(/\s+/gu, ' ').trim() || null : null };
  }
  return null;
}

function readNumericRule(criterion: AssessmentCriterion) {
  requireEvaluator(criterion, numericEquivalenceEvaluator);
  requireMaximum(criterion, '数值等价评估');
  if (criterion.inputs.length !== 1) throw new Error('数值等价评估只支持单个作答字段。');
  const params = record(criterion.parameters);
  fields(params, 'expected', 'tolerance', 'unit', 'acceptedUnits');
  if (!Object.hasOwn(params, 'expected') || !Object.hasOwn(params, 'tolerance')) {
    throw new Error('数值等价评估需要期望值与容差。');
  }
  const expected = params.expected;
  if ((typeof expected !== 'number' && typeof expected !== 'string') || rationalOf(expected) === null) {
    throw new Error('期望数值无效。');
  }
  const { tolerance } = params;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('数值容差必须是非负有限数值。');
  }
  const unit = normalizeUnit(params.unit);
  const acceptedUnits = params.acceptedUnits === undefined ? [] : list(params.acceptedUnits).map(entry => {
    const normalized = normalizeUnit(entry);
    if (normalized === undefined || normalized === null) throw new Error('接受单位必须是非空文字。');
    return normalized;
  });
  if (new Set(acceptedUnits).size !== acceptedUnits.length) throw new Error('接受单位重复。');
  if (unit !== undefined && unit !== null && acceptedUnits.length && !acceptedUnits.includes(unit)) {
    throw new Error('默认单位须在接受范围内。');
  }
  return { expected, tolerance, accepts: unitRequirement(unit, acceptedUnits) };
}

function declaredSlotKinds(criterion: AssessmentCriterion, slots: readonly AnswerSlot[]) {
  return criterion.inputs.map(({ slotId, path }) => {
    const kind = slots.find(slot => slot.slotId === slotId)?.fields.find(field => field.path === path)?.kind;
    if (!kind) throw new Error(`标准 ${criterion.criterionId} 引用了未声明的作答位或路径。`);
    return kind;
  });
}

export function validateNumericEquivalence(criterion: AssessmentCriterion, slots?: readonly AnswerSlot[]): void {
  readNumericRule(criterion);
  if (slots !== undefined) {
    const [kind] = declaredSlotKinds(criterion, slots);
    if (kind !== 'numeric' && kind !== 'text' && kind !== 'structured') {
      throw new Error('数值等价评估须绑定数值、文本或结构化字段。');
    }
  }
}

export function evaluateNumericEquivalence(
  criterion: AssessmentCriterion, answers: readonly AssessmentAnswerValue[],
): ExtendedEvaluationResult {
  const rule = readNumericRule(criterion);
  const maximum = requireMaximum(criterion, '数值等价评估');
  if (answers.length !== 1) throw new Error('请提供该标准的全部作答字段。');
  const input = numericInput(answers[0]!);
  let matched = false, proportion = 0;
  if (input !== null && rule.accepts(input.unit)) {
    if (rule.tolerance === 0) {
      const left = rationalOf(input.number);
      const right = rationalOf(rule.expected);
      matched = left !== null && right !== null &&
        left.numerator === right.numerator && left.denominator === right.denominator;
    } else {
      const actual = finiteNumber(input.number);
      const expectedNumber = finiteNumber(rule.expected);
      matched = actual !== null && expectedNumber !== null &&
        Math.abs(actual - expectedNumber) <= rule.tolerance + 1e-12;
    }
    proportion = matched ? 1 : 0;
  }
  return { matched, proportion, earned: maximum * proportion };
}

type SchemePlan = {
  readonly schemeId?: string;
  readonly weight: number;
  readonly match: 'all' | 'proportional';
  readonly answers: readonly AssessmentAnswerValue[];
};

function comparableAnswer(value: unknown): AssessmentAnswerValue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = record(value);
  try {
    if (row.kind === 'numeric') {
      fields(row, 'kind', 'value', 'unit');
      const unit = normalizeUnit(row.unit);
      if (typeof row.value !== 'number' || !Number.isFinite(row.value) || unit === undefined) return null;
      return { kind: 'numeric', value: row.value, unit };
    }
    if (row.kind === 'text') {
      fields(row, 'kind', 'value');
      if (typeof row.value !== 'string' || !row.value.trim()) return null;
      return { kind: 'text', value: row.value };
    }
    if (row.kind === 'structured') {
      fields(row, 'kind', 'value');
      const structured = record(row.value);
      fields(structured, 'kind', 'ids');
      if (structured.kind !== 'selection' && structured.kind !== 'breaks') return null;
      const raw = list(structured.ids);
      if (raw.some(id => typeof id !== 'string' || !id)) return null;
      const ids = raw as string[];
      if (new Set(ids).size !== ids.length) return null;
      return { kind: 'structured', value: { kind: structured.kind, ids } };
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
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new Error('方案权重须在 (0, 1] 内。');
    }
    const match = row.match === undefined ? 'all' : row.match;
    if (match !== 'all' && match !== 'proportional') throw new Error('方案匹配方式无效。');
    const rawAnswers = list(row.answers);
    if (rawAnswers.length !== criterion.inputs.length) throw new Error('每套方案须覆盖所有标准输入。');
    const answers = rawAnswers.map(value => {
      const answer = comparableAnswer(value);
      if (!answer) throw new Error('方案作答无效，或含附件、轨迹引用。');
      return answer;
    });
    return { ...(schemeId === undefined ? {} : { schemeId }), weight, match, answers };
  });
  return { schemes };
}

function answersEqual(expected: AssessmentAnswerValue, actual: AssessmentAnswerValue): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === 'numeric' && actual.kind === 'numeric') {
    const unitMatch = expected.unit === null || actual.unit === expected.unit;
    const left = rationalOf(expected.value);
    const right = rationalOf(actual.value);
    return unitMatch && left !== null && right !== null &&
      left.numerator === right.numerator && left.denominator === right.denominator;
  }
  if (expected.kind === 'text' && actual.kind === 'text') {
    return expected.value.trim().replace(/\s+/gu, ' ') === actual.value.trim().replace(/\s+/gu, ' ');
  }
  if (expected.kind === 'structured' && actual.kind === 'structured' &&
      !Array.isArray(expected.value) && !Array.isArray(actual.value) &&
      (expected.value as { kind?: unknown }).kind === (actual.value as { kind?: unknown }).kind &&
      ((expected.value as { kind?: unknown }).kind === 'selection' || (expected.value as { kind?: unknown }).kind === 'breaks')) {
    const required = new Set((expected.value as unknown as { ids: readonly string[] }).ids);
    const given = (actual.value as unknown as { ids?: unknown }).ids;
    if (!Array.isArray(given) || given.length !== required.size) return false;
    const seen = new Set<string>();
    for (const id of given) {
      if (typeof id !== 'string' || !required.has(id) || seen.has(id)) return false;
      seen.add(id);
    }
    return seen.size === required.size;
  }
  return false;
}

export function validateMultiSchemeBest(criterion: AssessmentCriterion, slots?: readonly AnswerSlot[]): void {
  const { schemes } = readMultiSchemeRule(criterion);
  if (slots !== undefined) {
    const kinds = declaredSlotKinds(criterion, slots);
    if (kinds.some(kind => kind === 'attachment' || kind === 'trace')) {
      throw new Error('多方案择优评估不支持附件或轨迹字段。');
    }
    if (schemes.some(scheme => scheme.answers.some((answer, index) => answer.kind !== kinds[index]))) {
      throw new Error('方案作答类型须与声明的作答字段一致。');
    }
  }
}

export function evaluateMultiSchemeBest(
  criterion: AssessmentCriterion, answers: readonly AssessmentAnswerValue[],
): ExtendedEvaluationResult {
  const { schemes } = readMultiSchemeRule(criterion);
  const maximum = requireMaximum(criterion, '多方案择优评估');
  if (answers.length !== criterion.inputs.length) throw new Error('请提供该标准的全部作答字段。');
  let bestProportion = 0;
  let bestIndex = -1;
  for (const [index, scheme] of schemes.entries()) {
    const hits = scheme.answers.filter((expected, inputIndex) => answersEqual(expected, answers[inputIndex]!)).length;
    if (scheme.match === 'all' && hits !== scheme.answers.length) continue;
    const base = scheme.match === 'all' ? 1 : hits / scheme.answers.length;
    const proportion = scheme.weight * base;
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
  const finite = (value: unknown, label: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是有限数值。`);
    return value;
  };
  const hasInterval = params.min !== undefined || params.max !== undefined;
  const hasTarget = params.target !== undefined || params.tolerance !== undefined;
  if (hasInterval === hasTarget) throw new Error('范围约束评估需要区间模式或目标容差模式之一。');
  let min: number, max: number, inclusiveMin: boolean, inclusiveMax: boolean;
  if (hasInterval) {
    if (params.min === undefined || params.max === undefined) throw new Error('区间模式需要上下界。');
    min = finite(params.min, '区间下界');
    max = finite(params.max, '区间上界');
    if (min > max) throw new Error('区间下界不能大于上界。');
    if ((params.inclusiveMin !== undefined && typeof params.inclusiveMin !== 'boolean') ||
        (params.inclusiveMax !== undefined && typeof params.inclusiveMax !== 'boolean')) {
      throw new Error('区间端点开关须为布尔值。');
    }
    inclusiveMin = params.inclusiveMin !== false;
    inclusiveMax = params.inclusiveMax !== false;
  } else {
    if (params.target === undefined || params.tolerance === undefined) throw new Error('目标容差模式需要目标数值与容差。');
    if (params.inclusiveMin !== undefined || params.inclusiveMax !== undefined) throw new Error('目标容差模式不能混用区间端点字段。');
    const target = finite(params.target, '目标数值');
    const tolerance = finite(params.tolerance, '目标容差');
    if (tolerance < 0) throw new Error('目标容差必须是非负有限数值。');
    min = target - tolerance;
    max = target + tolerance;
    inclusiveMin = true;
    inclusiveMax = true;
  }
  const partialMargin = params.partialMargin === undefined ? 0 : finite(params.partialMargin, '部分给分宽度');
  if (partialMargin < 0) throw new Error('部分给分宽度必须非负。');
  const unit = normalizeUnit(params.unit);
  return { min, max, inclusiveMin, inclusiveMax, partialMargin, accepts: unitRequirement(unit, []) };
}

export function validateRangeConstraint(criterion: AssessmentCriterion, slots?: readonly AnswerSlot[]): void {
  readRangeRule(criterion);
  if (slots !== undefined) {
    const [kind] = declaredSlotKinds(criterion, slots);
    if (kind !== 'numeric' && kind !== 'text' && kind !== 'structured') {
      throw new Error('范围约束评估须绑定数值、文本或结构化字段。');
    }
  }
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
    const value = finiteNumber(input.number);
    if (value !== null) {
      const belowMin = rule.inclusiveMin ? value < rule.min : value <= rule.min;
      const aboveMax = rule.inclusiveMax ? value > rule.max : value >= rule.max;
      if (!belowMin && !aboveMax) proportion = 1;
      else if (rule.partialMargin > 0) {
        const distance = belowMin ? rule.min - value : value - rule.max;
        proportion = Math.max(0, 1 - Math.max(0, distance) / rule.partialMargin);
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
