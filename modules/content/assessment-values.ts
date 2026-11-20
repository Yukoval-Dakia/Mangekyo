import { factId, type FactId, type Json, type JsonObject, type Revision } from '@mangekyo/kernel';

// Fact references are scoped to the learner by the caller. A revision is always explicit.
export type AssessmentRevisionRef = { readonly id: FactId; readonly rev: Revision };
export type AssessmentEvaluatorRef = { readonly id: string; readonly version: string };
export type AssessmentAnswerValue =
  | { readonly kind: 'numeric'; readonly value: number; readonly unit: string | null }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'attachment'; readonly ref: AssessmentRevisionRef }
  | { readonly kind: 'trace'; readonly ref: AssessmentRevisionRef }
  | { readonly kind: 'structured'; readonly value: JsonObject | readonly Json[] };

type AnswerKind = AssessmentAnswerValue['kind'];
// JSON Pointer relative to the slot. The empty pointer addresses its root.
export type AssessmentInputAddress = { readonly slotId: string; readonly path: string };
export type AnswerSlot = {
  readonly slotId: string;
  readonly schemaVersion: string;
  readonly fields: readonly { readonly path: string; readonly kind: AnswerKind }[];
};
export type AssessmentCriterion = {
  readonly criterionId: string;
  // Each address is required for scored results. Alternatives can share one field shape.
  readonly inputs: readonly AssessmentInputAddress[];
  readonly evaluator: AssessmentEvaluatorRef;
  readonly parameters: Json;
  readonly source: {
    readonly kind: 'school-rubric' | 'product-rubric';
    readonly ref: AssessmentRevisionRef;
    readonly path?: string;
  };
  readonly maximum: number | null;
  readonly missingEvidence: 'insufficient-evidence' | 'allow-qualitative';
};
export type AssessmentItem = {
  readonly itemId: string;
  readonly promptRef?: AssessmentRevisionRef;
  readonly workRef?: AssessmentRevisionRef;
  readonly slots: readonly AnswerSlot[];
  readonly criteria: readonly AssessmentCriterion[];
};

export type AssessmentRelease = {
  readonly releaseRef: AssessmentRevisionRef;
  readonly items: readonly AssessmentItem[];
};
function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function record(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (!plainObject(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error(`${label}字段无效。`);
  }
  return value;
}

function list(value: unknown, label: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${label}必须是列表。`);
  return Array.from(value);
}

function storable(value: string): boolean {
  return value.isWellFormed() && !value.includes('\u0000');
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !storable(value) || !value.trim()) throw new Error(`${label}必须是非空文字。`);
  return value;
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value)) throw new Error(`${label}无效。`);
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  const match = choices.find(option => option === value);
  if (match === undefined) throw new Error(`${label}无效。`);
  return match;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是有限数值。`);
  return value;
}

function pointer(value: unknown): string {
  if (typeof value !== 'string' || !storable(value) || !/^(?:\/(?:[^~/]|~0|~1)*)*$/.test(value)) {
    throw new Error('作答或来源路径必须是 JSON Pointer。');
  }
  return value;
}

function revisionRef(value: unknown, label: string): AssessmentRevisionRef {
  const { id, rev } = record(value, label, ['id', 'rev']);
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) throw new Error(`${label}须有固定修订。`);
  return { id: factId(text(id, label)), rev: rev as Revision };
}

function json(value: readonly unknown[], ancestors?: Set<object>): readonly Json[];
function json(value: Record<string, unknown>, ancestors?: Set<object>): JsonObject;
function json(value: unknown, ancestors?: Set<object>): Json;
function json(value: unknown, ancestors = new Set<object>()): Json {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && storable(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!plainObject(value) && !Array.isArray(value)) throw new Error('须提供可保存的 JSON 值。');
  if (ancestors.has(value)) throw new Error('JSON 值不能循环引用。');
  ancestors.add(value);
  const parsed = Array.isArray(value)
    ? Array.from(value, entry => json(entry, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (!storable(key)) throw new Error('JSON 字段名无效。');
      return [key, json(entry, ancestors)];
    }));
  ancestors.delete(value);
  return parsed;
}

function unique<T>(values: T[], key: (value: T) => string, label: string): T[] {
  if (new Set(values.map(key)).size !== values.length) throw new Error(`${label}重复。`);
  return values;
}

function inputAddress(value: Record<string, unknown>): AssessmentInputAddress {
  return { slotId: token(value.slotId, '作答位标识'), path: pointer(value.path) };
}

function inputKey({ slotId, path }: AssessmentInputAddress): string {
  return JSON.stringify([slotId, path]);
}

function addresses(value: unknown, label: string): AssessmentInputAddress[] {
  return unique(list(value, label).map(entry => inputAddress(record(entry, label, ['slotId', 'path']))), inputKey, label);
}

const answerKinds = ['numeric', 'text', 'attachment', 'trace', 'structured'] as const;

function slot(value: unknown): AnswerSlot {
  const { slotId, schemaVersion, fields } = record(value, '作答位', ['slotId', 'schemaVersion', 'fields']);
  return {
    slotId: token(slotId, '作答位标识'),
    schemaVersion: token(schemaVersion, '作答位 schema 版本'),
    fields: unique(list(fields, '作答字段').map(entry => {
      const { path, kind } = record(entry, '作答字段', ['path', 'kind']);
      return { path: pointer(path), kind: choice(kind, answerKinds, '作答字段类型') };
    }), field => field.path, '作答字段路径'),
  };
}

function criterion(value: unknown, slots: readonly AnswerSlot[]): AssessmentCriterion {
  const row = record(value, '评估标准', ['criterionId', 'inputs', 'evaluator', 'parameters', 'source', 'maximum', 'missingEvidence']);
  const criterionId = token(row.criterionId, '标准标识');
  const inputs = addresses(row.inputs, '标准输入');
  for (const { slotId, path } of inputs) {
    if (!slots.find(slot => slot.slotId === slotId)?.fields.some(field => field.path === path)) {
      throw new Error(`标准 ${criterionId} 引用了未声明的作答位或路径。`);
    }
  }
  const evaluator = record(row.evaluator, '判定器', ['id', 'version']);
  const source = record(row.source, '规则来源', ['kind', 'ref', 'path']);
  const maximum = row.maximum === null ? null : finite(row.maximum, '标准满分');
  if (maximum !== null && maximum <= 0) throw new Error('标准满分必须为正数，无分值标准须明确为 null。');
  return {
    criterionId, inputs,
    evaluator: { id: token(evaluator.id, '判定器标识'), version: token(evaluator.version, '判定器版本') },
    parameters: json(row.parameters),
    source: {
      kind: choice(source.kind, ['school-rubric', 'product-rubric'], '规则来源类型'),
      ref: revisionRef(source.ref, '规则来源'),
      ...(source.path === undefined ? {} : { path: pointer(source.path) }),
    },
    maximum,
    missingEvidence: choice(row.missingEvidence, ['insufficient-evidence', 'allow-qualitative'], '缺证据政策'),
  };
}

/** Validate answer fields and the criteria referencing them as a single contract. */
export function assessmentQuestionContract(responseSchema: unknown, assessmentContract: unknown) {
  const slots = unique(list(responseSchema, '作答位').map(slot), entry => entry.slotId, '作答位标识');
  const criteria = unique(list(assessmentContract, '冻结评估标准').map(entry => criterion(entry, slots)),
    entry => entry.criterionId, '标准标识');
  finite(criteria.reduce((total, entry) => total + (entry.maximum ?? 0), 0), '契约总分');
  return { slots, criteria };
}

/** Bind a product-authored rubric to the actual question revision at publication. */
export function bindQuestionAssessment(responseSchema: unknown, assessmentContract: unknown, questionRef: AssessmentRevisionRef) {
  const criteria = list(assessmentContract, '题目评估标准').map((entry, index) => {
    if (!plainObject(entry) || Object.hasOwn(entry, 'source')) throw new Error('评分依据由系统绑定到固定题版。');
    return { ...entry, source: { kind: 'product-rubric', ref: questionRef, path: `/assessment_contract/${index}` } };
  });
  return assessmentQuestionContract(responseSchema, criteria);
}

// Historical reads use the frozen contract even after an evaluator version is retired.
export function assessmentRelease(value: unknown): AssessmentRelease {
  const release = record(value, '发放契约', ['releaseRef', 'items']);
  const items = unique(list(release.items, '发放题目').map(entry => {
    const item = record(entry, '发放题目', ['itemId', 'promptRef', 'workRef', 'slots', 'criteria']);
    return {
      itemId: token(item.itemId, '题目标识'),
      ...(item.promptRef === undefined ? {} : { promptRef: revisionRef(item.promptRef, '题面') }),
      ...(item.workRef === undefined ? {} : { workRef: revisionRef(item.workRef, '作品') }),
      ...assessmentQuestionContract(item.slots, item.criteria),
    };
  }), item => item.itemId, '题目标识');
  const maximum = items.flatMap(item => item.criteria).reduce((total, entry) => total + (entry.maximum ?? 0), 0);
  finite(maximum, '契约总分');
  return { releaseRef: revisionRef(release.releaseRef, '发放'), items };
}

// The caller supplies the trusted evaluator catalog. Success supplies input for independent publication verification.
export function assessmentPublicationInput(value: unknown, registered: readonly AssessmentEvaluatorRef[]): AssessmentRelease {
  const release = assessmentRelease(value);
  for (const item of release.items) {
    for (const { criterionId, evaluator } of item.criteria) {
      if (!registered.some(entry => entry.id === evaluator.id && entry.version === evaluator.version)) {
        throw new Error(`题目 ${item.itemId} 的标准 ${criterionId} 使用了未注册的判定器 ${evaluator.id}@${evaluator.version}。`);
      }
    }
  }
  return release;
}

export { selectionConstraintEvaluator, validateSelectionConstraint, matchesSelectionConstraint } from './selection-constraint.ts';
