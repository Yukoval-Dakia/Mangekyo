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
type AnswerSlot = {
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
type AssessmentItem = {
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
export type AssessmentSubmission = {
  readonly releaseRef: AssessmentRevisionRef;
  readonly submissionRef: AssessmentRevisionRef;
  readonly answers: readonly (AssessmentInputAddress & {
    readonly itemId: string;
    readonly schemaVersion: string;
    readonly value: AssessmentAnswerValue;
  })[];
};

const unresolvedStates = ['unsubmitted', 'pending', 'insufficient-evidence', 'blocked', 'failed'] as const;
export type AssessmentCriterionOutcome = { readonly itemId: string; readonly criterionId: string } & (
  | { readonly state: 'scored'; readonly earned: number; readonly evidence: readonly AssessmentInputAddress[]; readonly feedback?: string }
  | { readonly state: 'qualitative'; readonly feedback: string; readonly evidence: readonly AssessmentInputAddress[] }
  | { readonly state: 'partial'; readonly reason: string; readonly evidence: readonly AssessmentInputAddress[] }
  | { readonly state: (typeof unresolvedStates)[number]; readonly reason: string }
);
export type AssessmentResult = {
  readonly releaseRef: AssessmentRevisionRef;
  readonly submissionRef: AssessmentRevisionRef;
  readonly outcomes: readonly AssessmentCriterionOutcome[];
};
export type LegacyAssessmentResult = {
  readonly state: 'legacy-manual' | 'legacy-self-check';
  readonly recordRef: AssessmentRevisionRef;
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

function matchRef(actual: AssessmentRevisionRef, expected: AssessmentRevisionRef, label: string): void {
  if (actual.id !== expected.id || actual.rev !== expected.rev) throw new Error(`${label}修订不匹配。`);
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

// Historical reads use the frozen contract even after an evaluator version is retired.
export function assessmentRelease(value: unknown): AssessmentRelease {
  const release = record(value, '发放契约', ['releaseRef', 'items']);
  const items = unique(list(release.items, '发放题目').map(entry => {
    const item = record(entry, '发放题目', ['itemId', 'promptRef', 'workRef', 'slots', 'criteria']);
    const slots = unique(list(item.slots, '作答位').map(slot), entry => entry.slotId, '作答位标识');
    return {
      itemId: token(item.itemId, '题目标识'),
      ...(item.promptRef === undefined ? {} : { promptRef: revisionRef(item.promptRef, '题面') }),
      ...(item.workRef === undefined ? {} : { workRef: revisionRef(item.workRef, '作品') }),
      slots,
      criteria: unique(list(item.criteria, '冻结评估标准').map(entry => criterion(entry, slots)), entry => entry.criterionId, '标准标识'),
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

function answerValue(value: unknown, kind: AnswerKind): AssessmentAnswerValue {
  switch (kind) {
    case 'numeric': {
      const row = record(value, '数值作答', ['kind', 'value', 'unit']);
      return { kind, value: finite(row.value, '作答数值'), unit: row.unit === null ? null : text(row.unit, '作答单位') };
    }
    case 'text':
      return { kind, value: text(record(value, '文字作答', ['kind', 'value']).value, '文字作答') };
    case 'attachment':
    case 'trace':
      return { kind, ref: revisionRef(record(value, '受控引用', ['kind', 'ref']).ref, '受控引用') };
    case 'structured': {
      const data = record(value, '结构化作答', ['kind', 'value']).value;
      if (Array.isArray(data)) return { kind, value: json(data) };
      if (!plainObject(data)) throw new Error('结构化作答须为 JSON 对象或列表。');
      return { kind, value: json(data) };
    }
  }
}

export function assessmentSubmission(value: unknown, release: AssessmentRelease): AssessmentSubmission {
  const row = record(value, '提交', ['releaseRef', 'submissionRef', 'answers']);
  const releaseRef = revisionRef(row.releaseRef, '提交的发放');
  matchRef(releaseRef, release.releaseRef, '提交的发放');
  const answers = unique(list(row.answers, '提交作答', true).map(entry => {
    const answer = record(entry, '作答', ['itemId', 'slotId', 'path', 'schemaVersion', 'value']);
    const itemId = token(answer.itemId, '题目标识');
    const address = inputAddress(answer);
    const slot = release.items.find(item => item.itemId === itemId)?.slots.find(slot => slot.slotId === address.slotId);
    const field = slot?.fields.find(field => field.path === address.path);
    if (!slot || !field) throw new Error(`题目 ${itemId} 的作答位或路径未声明。`);
    if (answer.schemaVersion !== slot.schemaVersion) throw new Error(`作答位 ${slot.slotId} 的 schema 版本不匹配。`);
    if (!plainObject(answer.value) || answer.value.kind !== field.kind) throw new Error(`作答位 ${slot.slotId} 的字段类型不匹配。`);
    return { itemId, ...address, schemaVersion: slot.schemaVersion, value: answerValue(answer.value, field.kind) };
  }), answer => JSON.stringify([answer.itemId, answer.slotId, answer.path]), '提交作答地址');
  return { releaseRef, submissionRef: revisionRef(row.submissionRef, '提交'), answers };
}

const outcomeStates = ['scored', 'qualitative', 'partial', ...unresolvedStates] as const;
const outcomeKeys = ['itemId', 'criterionId', 'state'];

function outcome(value: unknown, release: AssessmentRelease, submission: AssessmentSubmission): AssessmentCriterionOutcome {
  const row = record(value, '评估结果', [...outcomeKeys, 'earned', 'feedback', 'evidence', 'reason']);
  const itemId = token(row.itemId, '题目标识');
  const criterionId = token(row.criterionId, '标准标识');
  const key = { itemId, criterionId };
  const criterion = release.items.find(item => item.itemId === itemId)?.criteria.find(entry => entry.criterionId === criterionId);
  if (!criterion) throw new Error(`题目 ${itemId} 的标准 ${criterionId} 未声明。`);
  const state = choice(row.state, outcomeStates, '结果状态');
  const submitted = new Set(submission.answers.filter(answer => answer.itemId === itemId).map(inputKey));
  const available = new Set(criterion.inputs.map(inputKey).filter(key => submitted.has(key)));
  if (state !== 'scored' && state !== 'qualitative' && state !== 'partial') {
    record(row, '未完成的评估结果', [...outcomeKeys, 'reason']);
    if (state === 'unsubmitted' && available.size > 0) throw new Error('已有标准输入，不能标为未交。');
    return { ...key, state, reason: text(row.reason, '结果原因') };
  }

  const evidence = addresses(row.evidence, '作答证据');
  if (!evidence.every(entry => available.has(inputKey(entry)))) throw new Error('证据须指向该标准已提交的输入。');
  const inputsComplete = available.size === criterion.inputs.length;
  switch (state) {
    case 'scored': {
      record(row, '评分结果', [...outcomeKeys, 'earned', 'evidence', 'feedback']);
      if (!inputsComplete || criterion.maximum === null) throw new Error('正式计分须有完整标准输入及冻结满分。');
      const earned = finite(row.earned, '得分');
      if (earned < 0 || earned > criterion.maximum) throw new Error('得分超出冻结标准的分界。');
      return { ...key, state, earned, evidence, ...(row.feedback === undefined ? {} : { feedback: text(row.feedback, '评语') }) };
    }
    case 'qualitative':
      record(row, '证据质评', [...outcomeKeys, 'feedback', 'evidence']);
      if ((criterion.maximum !== null || !inputsComplete) && criterion.missingEvidence !== 'allow-qualitative') {
        throw new Error('冻结标准未允许此证据质评。');
      }
      return { ...key, state, feedback: text(row.feedback, '评语'), evidence };
    case 'partial':
      record(row, '部分结果', [...outcomeKeys, 'reason', 'evidence']);
      return { ...key, state, reason: text(row.reason, '结果原因'), evidence };
  }
}

export function assessmentResult(value: unknown, release: AssessmentRelease, submission: AssessmentSubmission): AssessmentResult {
  const result = record(value, '评估', ['releaseRef', 'submissionRef', 'outcomes']);
  const releaseRef = revisionRef(result.releaseRef, '评估的发放');
  const submissionRef = revisionRef(result.submissionRef, '评估的提交');
  matchRef(releaseRef, release.releaseRef, '评估的发放');
  matchRef(releaseRef, submission.releaseRef, '提交的发放');
  matchRef(submissionRef, submission.submissionRef, '评估的提交');
  const outcomes = unique(list(result.outcomes, '评估结果').map(entry => outcome(entry, release, submission)),
    entry => JSON.stringify([entry.itemId, entry.criterionId]), '题目与标准的结果');
  if (outcomes.length !== release.items.reduce((count, item) => count + item.criteria.length, 0)) {
    throw new Error('每项冻结标准都需要明确的结果状态。');
  }
  return { releaseRef, submissionRef, outcomes };
}

export function legacyAssessmentResult(value: unknown): LegacyAssessmentResult {
  const row = record(value, '旧评估记录', ['state', 'recordRef']);
  return {
    state: choice(row.state, ['legacy-manual', 'legacy-self-check'], '旧评估状态'),
    recordRef: revisionRef(row.recordRef, '旧评估记录'),
  };
}

// A complete contract score. The rule sources remain on the release, and no school grade is inferred.
export function readAssessmentScore(value: unknown, release: AssessmentRelease, submission: AssessmentSubmission):
  { readonly earned: number; readonly maximum: number } | null {
  const { outcomes } = assessmentResult(value, release, submission);
  const byCriterion = new Map(outcomes.map(entry => [JSON.stringify([entry.itemId, entry.criterionId]), entry]));
  let earned = 0;
  let maximum = 0;
  for (const item of release.items) {
    for (const criterion of item.criteria) {
      const result = byCriterion.get(JSON.stringify([item.itemId, criterion.criterionId]));
      if (criterion.maximum === null && result?.state === 'qualitative') continue;
      if (criterion.maximum === null || result?.state !== 'scored') return null;
      earned += result.earned;
      maximum += criterion.maximum;
    }
  }
  return maximum > 0 ? { earned, maximum } : null;
}
