import { stableId, type DbTransaction, type Json, type ReadTransaction } from '@mangekyo/kernel';
import {
  builtInStudyMethodTemplateById, builtInStudyMethodTemplates, instantiateStudyMethodPlan, parseStudyMethodTemplate,
  StudyMethodInvariantError, type StudyMethodTemplate,
} from '@mangekyo/module-content/facts/study-method-template';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new StudyMethodHostValidationError('学法模板数据必须是对象。');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) throw new StudyMethodHostValidationError(`${label}无效。`);
  return value;
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => jsonDeepEqual(entry, right[index]));
  }
  const leftKeys = Object.keys(left).filter(key => (left as Record<string, unknown>)[key] !== undefined);
  const rightKeys = Object.keys(right).filter(key => (right as Record<string, unknown>)[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && jsonDeepEqual((left as never)[key], (right as never)[key]));
}

/**
 * Pure host glue for the learner study-method template library. Saves and undos persist as an
 * ordered append-only `effects` log per learner, replayed independently per `templateId` so
 * undoing one template never affects another, undone revisions can be cleanly re-saved, and
 * already-frozen classroom plans can never drift.
 */

export const studyMethodTemplateOwnerId = stableId('studio-study-method-templates');
export const studyMethodTemplateAppendLabel = 'study-method-template-save';
export const studyMethodTemplateUndoLabel = 'study-method-template-undo';

export class StudyMethodHostValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'StudyMethodHostValidationError'; }
}
export class StudyMethodHostConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'StudyMethodHostConflictError'; }
}
export class StudyMethodHostNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'StudyMethodHostNotFoundError'; }
}
export class StudyMethodDuplicateRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'StudyMethodDuplicateRequestError'; }
}

/** Map host-level template errors to stable HTTP statuses and machine codes. */
export function classifyStudyMethodHostError(error: unknown): { status: number; message: string; code?: string } | undefined {
  if (error instanceof StudyMethodInvariantError) return { status: 400, message: error.message, code: 'study_method_invariant' };
  if (error instanceof StudyMethodHostValidationError) return { status: 400, message: error.message, code: 'invalid_template' };
  if (error instanceof StudyMethodHostNotFoundError) return { status: 404, message: error.message, code: 'template_not_found' };
  if (error instanceof StudyMethodDuplicateRequestError) return { status: 409, message: error.message, code: 'duplicate_request_conflict' };
  if (error instanceof StudyMethodHostConflictError) return { status: 409, message: error.message, code: 'template_chain_conflict' };
  return undefined;
}

type WriteTx = ReadTransaction & {
  withLearnerWrite: (write: (tick: never) => Promise<unknown>) => Promise<unknown>;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).filter(key => row[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(row[key])).join(',') + '}';
};

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

type ParsedUndoToken = { readonly templateId: string; readonly version: number; readonly fromVersion?: number };
const UNDO_TOKEN_RE = /^undo:method-template:([^:]+):v(\d+)(?::(create|from-v(\d+)))?$/;

function parseUndoToken(token: string): ParsedUndoToken | undefined {
  const match = UNDO_TOKEN_RE.exec(token);
  if (!match) return undefined;
  const [, templateId, versionText, mode, fromText] = match;
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  if (mode === undefined || mode === 'create') return { templateId: templateId!, version };
  const fromVersion = Number(fromText);
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 1 || fromVersion >= version) return undefined;
  return { templateId: templateId!, version, fromVersion };
}

/** Accept both frontend bare `...:v1` and explicit `...:v1:create` for initial versions; require `:from-vN` for revisions. */
function resolveSaveUndoToken(template: StudyMethodTemplate): string {
  if (template.replacesVersion !== undefined) {
    const expected = `undo:method-template:${template.templateId}:v${template.version}:from-v${template.replacesVersion}`;
    if (template.undoToken !== undefined && template.undoToken !== expected)
      throw new StudyMethodHostValidationError('撤销令牌与版本链不匹配。');
    return expected;
  }
  const bare = `undo:method-template:${template.templateId}:v${template.version}`;
  const explicit = `${bare}:create`;
  if (template.undoToken === undefined) return bare;
  if (template.undoToken !== bare && template.undoToken !== explicit)
    throw new StudyMethodHostValidationError('撤销令牌与版本链不匹配。');
  return template.undoToken;
}

export type ActiveRevisionEntry = {
  readonly template: StudyMethodTemplate;
  readonly undoToken: string;
  readonly stepKey: string;
};

export type TemplateHistory = {
  readonly activeStack: readonly ActiveRevisionEntry[];
  readonly eventCount: number;
  readonly seenUndoTokens: ReadonlySet<string>;
};

const builtInOf = (templateId: string): StudyMethodTemplate | undefined =>
  builtInStudyMethodTemplateById[templateId as keyof typeof builtInStudyMethodTemplateById];

function undoTokenMatchesEntry(entry: ActiveRevisionEntry, token: string): boolean {
  if (entry.undoToken === token) return true;
  if (entry.template.replacesVersion !== undefined) return false;
  const bare = `undo:method-template:${entry.template.templateId}:v${entry.template.version}`;
  return (entry.undoToken === bare || entry.undoToken === `${bare}:create`) && (token === bare || token === `${bare}:create`);
}

async function replayTemplateHistories(tx: ReadTransaction, ownerId: string) {
  const { rows } = await tx.query<{ step_key: string; label: string; input: unknown }>(
    `SELECT step_key, label, input FROM effects
       WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2
         AND label = ANY($3::text[]) AND state='done'
       ORDER BY ended_tick ASC, step_key ASC`,
    [tx.learner, ownerId, [studyMethodTemplateAppendLabel, studyMethodTemplateUndoLabel]]);

  const histories = new Map<string, { activeStack: ActiveRevisionEntry[]; eventCount: number; seenUndoTokens: Set<string> }>();
  const ensure = (templateId: string) => {
    let entry = histories.get(templateId);
    if (!entry) histories.set(templateId, entry = { activeStack: [], eventCount: 0, seenUndoTokens: new Set() });
    return entry;
  };

  for (const row of rows) {
    const payload = record(row.input);
    if (row.label === studyMethodTemplateAppendLabel) {
      const template = parseStudyMethodTemplate(payload.template);
      const token = resolveSaveUndoToken(template);
      const state = ensure(template.templateId);
      state.activeStack.push({ template, undoToken: token, stepKey: row.step_key });
      state.eventCount += 1;
      continue;
    }
    const token = text(payload.undoToken, '撤销令牌');
    const parsed = parseUndoToken(token);
    if (!parsed) continue;
    const state = ensure(parsed.templateId);
    state.seenUndoTokens.add(token);
    state.eventCount += 1;
    const targetStepKey = typeof payload.targetStepKey === 'string' ? payload.targetStepKey : undefined;
    const top = state.activeStack[state.activeStack.length - 1];
    if (top && ((targetStepKey !== undefined && top.stepKey === targetStepKey) ||
        (targetStepKey === undefined && undoTokenMatchesEntry(top, token)))) {
      state.activeStack.pop();
    }
  }
  return histories as ReadonlyMap<string, TemplateHistory>;
}

/** Currently active version for one template (top of its non-undone stack, or built-in floor). */
export function activeTemplateVersion(history: TemplateHistory | undefined, templateId: string): number | undefined {
  const top = history?.activeStack[history.activeStack.length - 1];
  return top ? top.template.version : builtInOf(templateId)?.version;
}

/** Built-in floor plus the learner's latest active revisions; undone revisions roll back cleanly per templateId. */
export function mergeStudyMethodLibrary(histories: ReadonlyMap<string, TemplateHistory>): readonly StudyMethodTemplate[] {
  const merged = new Map<string, StudyMethodTemplate>(builtInStudyMethodTemplates.map(template => [template.templateId, template]));
  for (const [templateId, history] of histories) {
    const top = history.activeStack[history.activeStack.length - 1];
    if (top) merged.set(templateId, top.template);
    else if (!builtInOf(templateId)) merged.delete(templateId);
  }
  return Object.freeze([...merged.values()].sort((left, right) => left.templateId.localeCompare(right.templateId)));
}

export async function loadStudyMethodLibrary(tx: ReadTransaction, ownerId: string) {
  const histories = await replayTemplateHistories(tx, ownerId);
  return { histories, templates: mergeStudyMethodLibrary(histories) };
}

/** Resolve one pinned active revision: a non-undone entry on this template's stack, or the exact built-in floor. */
export function resolveStudyMethodRevision(
  histories: ReadonlyMap<string, TemplateHistory>, templateId: string, version: number,
): StudyMethodTemplate | undefined {
  const stack = histories.get(templateId)?.activeStack ?? [];
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]!.template.version === version) return stack[i]!.template;
  }
  const builtIn = builtInOf(templateId);
  return builtIn?.version === version ? builtIn : undefined;
}

/** Resolve and freeze one template revision into a classroom plan instance; returns undefined when unavailable. */
export async function instantiateStudyMethodForClassroom(
  tx: ReadTransaction, ownerId: string, templateId: string, version: number,
  instanceId: string, instantiatedAtIso: string,
) {
  const histories = await replayTemplateHistories(tx, ownerId);
  const template = resolveStudyMethodRevision(histories, templateId, version);
  if (!template) return undefined;
  return instantiateStudyMethodPlan(template, { instanceId, instantiatedAtIso });
}

export type StudyMethodSaveReceipt = { readonly template: StudyMethodTemplate; readonly undoToken: string };

export function parseStudyMethodSaveRequest(raw: unknown): { template: StudyMethodTemplate; requestId?: string } {
  const row = record(raw);
  const allowed = new Set(['templateId', 'version', 'name', 'goal', 'disciplineTags', 'steps', 'observationRequirements',
    'author', 'replacesVersion', 'undoToken', 'requestId', 'template']);
  for (const field of Object.keys(row))
    if (!allowed.has(field)) throw new StudyMethodHostValidationError(`学法模板保存请求包含未知字段：${field}。`);
  const templateSource = Object.hasOwn(row, 'steps') ? row : row.template;
  let template: StudyMethodTemplate;
  try { template = parseStudyMethodTemplate(templateSource); }
  catch (error) {
    if (error instanceof StudyMethodInvariantError) throw error;
    throw new StudyMethodHostValidationError(error instanceof Error ? error.message : '学法模板格式无效。');
  }
  const requestIdSource = row.requestId ?? (templateSource !== row && templateSource && typeof templateSource === 'object'
    ? (templateSource as Record<string, unknown>).requestId : undefined);
  const requestId = requestIdSource === undefined || requestIdSource === '' ? undefined : text(requestIdSource, '请求标识');
  return { template, ...(requestId === undefined ? {} : { requestId }) };
}

export function parseStudyMethodUndoRequest(raw: unknown): { undoToken: string; requestId?: string } {
  const row = record(raw);
  for (const field of Object.keys(row))
    if (!['undoToken', 'requestId'].includes(field)) throw new StudyMethodHostValidationError(`撤销请求包含未知字段：${field}。`);
  const undoToken = text(row.undoToken, '撤销令牌');
  if (!undoToken.startsWith('undo:method-template:')) throw new StudyMethodHostValidationError('撤销令牌格式无效。');
  const requestId = row.requestId === undefined || row.requestId === '' ? undefined : text(row.requestId, '请求标识');
  return { undoToken, ...(requestId === undefined ? {} : { requestId }) };
}

const findEffect = async (tx: ReadTransaction, ownerId: string, stepKey: string, label: string) => {
  const { rows: [saved] } = await tx.query<{ input_digest: string; result: unknown }>(
    `SELECT input_digest, result FROM effects
       WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND step_key=$3 AND label=$4`,
    [tx.learner, ownerId, stepKey, label]);
  return saved;
};

const recordEffect = async (tx: DbTransaction, ownerId: string, stepKey: string, label: string, input: unknown, result: unknown) =>
  (tx as unknown as WriteTx).withLearnerWrite(async tick => {
    await tx.query(
      `INSERT INTO effects (learner_id, owner_kind, owner_id, step_key, label, input_digest, input,
         provider_effect_id, state, result, started_tick, ended_tick,
         budget_route, reserved_usd_micros, actual_usd_micros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'done',$9,$10,$10,NULL,NULL,NULL)
       ON CONFLICT (learner_id, owner_kind, owner_id, step_key, label) DO NOTHING`,
      [tx.learner, 'session', ownerId, stepKey, label,
        await sha256Hex(canonicalJson(input)), canonicalJson(input), null, canonicalJson(result), String(tick)]);
    return undefined as never;
  });

/**
 * Append one template revision inside the caller's learner lock.
 * - Explicit `requestId` provides strict idempotent replay / 409 conflict checks.
 * - Bare frontend saves replay idempotently if the exact same `(templateId, version)` content is
 *   currently active, and cleanly support re-saving after an undo without poisoning version numbers.
 */
export async function saveStudyMethodTemplate(
  tx: DbTransaction, ownerId: string, raw: unknown,
): Promise<StudyMethodSaveReceipt> {
  const { template, requestId } = parseStudyMethodSaveRequest(raw);
  const token = resolveSaveUndoToken(template);
  const normalized: StudyMethodTemplate = parseStudyMethodTemplate({ ...template, undoToken: token });
  const input: Json = { template: normalized as unknown as Json };
  const inputDigest = await sha256Hex(canonicalJson(input));

  if (requestId !== undefined) {
    const saved = await findEffect(tx, ownerId, `req:${requestId}`, studyMethodTemplateAppendLabel);
    if (saved) {
      if (saved.input_digest !== inputDigest)
        throw new StudyMethodDuplicateRequestError('同一请求标识已用于不同的学法模板内容。');
      const result = record(saved.result);
      return { template: parseStudyMethodTemplate(result.template), undoToken: text(result.undoToken, '撤销令牌') };
    }
  }

  const histories = await replayTemplateHistories(tx, ownerId);
  const history = histories.get(template.templateId);
  const activeEntry = history?.activeStack[history.activeStack.length - 1];
  const activeVersion = activeTemplateVersion(history, template.templateId);

  // Bare-frontend retry of the currently active revision replays idempotently; conflicting content 409s.
  if (activeEntry && activeEntry.template.version === template.version) {
    if (jsonDeepEqual({ ...activeEntry.template, undoToken: undefined }, { ...normalized, undoToken: undefined })) {
      return { template: activeEntry.template, undoToken: activeEntry.undoToken };
    }
    throw new StudyMethodHostConflictError(`学法模板 ${template.templateId} 的版本 v${template.version} 已存在且内容不同。`);
  }

  if (template.replacesVersion === undefined) {
    if (activeVersion !== undefined)
      throw new StudyMethodHostConflictError(`学法模板 ${template.templateId} 已存在，修订必须声明 replacesVersion。`);
    if (template.version !== 1)
      throw new StudyMethodHostConflictError('新建学法模板必须从版本 v1 开始。');
  } else {
    if (activeVersion === undefined || template.replacesVersion !== activeVersion)
      throw new StudyMethodHostConflictError(`replacesVersion v${template.replacesVersion} 与当前活跃版本不一致。`);
    if (template.version !== activeVersion + 1)
      throw new StudyMethodHostConflictError('学法模板版本必须沿当前活跃版本单调递增 1。');
  }

  const stepKey = requestId !== undefined
    ? `req:${requestId}`
    : `save:${template.templateId}:v${template.version}:seq${(history?.eventCount ?? 0) + 1}`;
  const receipt: StudyMethodSaveReceipt = Object.freeze({ template: normalized, undoToken: token });
  await recordEffect(tx, ownerId, stepKey, studyMethodTemplateAppendLabel, input, receipt);
  return receipt;
}

export type StudyMethodUndoReceipt = {
  readonly status: 'undone';
  readonly templateId: string;
  readonly restoredVersion: number | null;
  readonly template: StudyMethodTemplate | null;
};

function parseUndoReceipt(value: unknown): StudyMethodUndoReceipt {
  const row = record(value);
  const restored = row.restoredVersion;
  return {
    status: 'undone',
    templateId: text(row.templateId, '模板标识'),
    restoredVersion: typeof restored === 'number' ? restored : null,
    template: row.template === null || row.template === undefined ? null : parseStudyMethodTemplate(row.template),
  };
}

/** Append-only undo: pops the currently active revision for this templateId only; frozen classroom plans never change. */
export async function undoStudyMethodTemplate(
  tx: DbTransaction, ownerId: string, raw: unknown,
): Promise<StudyMethodUndoReceipt> {
  const { undoToken, requestId } = parseStudyMethodUndoRequest(raw);
  const parsed = parseUndoToken(undoToken);
  if (!parsed) throw new StudyMethodHostNotFoundError('找不到对应的学法模板版本。');

  const reqDigest = await sha256Hex(canonicalJson({ undoToken }));
  if (requestId !== undefined) {
    const saved = await findEffect(tx, ownerId, `req:${requestId}`, studyMethodTemplateUndoLabel);
    if (saved) {
      if (saved.input_digest !== reqDigest)
        throw new StudyMethodDuplicateRequestError('同一请求标识已用于不同的撤销内容。');
      return parseUndoReceipt(saved.result);
    }
  }

  const histories = await replayTemplateHistories(tx, ownerId);
  const history = histories.get(parsed.templateId);
  const top = history?.activeStack[history.activeStack.length - 1];
  if (!top) {
    if (history?.seenUndoTokens.has(undoToken))
      throw new StudyMethodHostConflictError('此撤销令牌已被使用，请携带原请求标识重放。');
    if (builtInOf(parsed.templateId))
      throw new StudyMethodHostConflictError('内置学法模板不可撤销。');
    throw new StudyMethodHostNotFoundError('找不到对应的学法模板版本。');
  }
  if (!undoTokenMatchesEntry(top, undoToken)) {
    const earlierMatch = history!.activeStack.some(entry => undoTokenMatchesEntry(entry, undoToken));
    if (earlierMatch || history!.seenUndoTokens.has(undoToken))
      throw new StudyMethodHostConflictError('此版本已不再是当前活跃版本，无法撤销。');
    throw new StudyMethodHostNotFoundError('撤销令牌与已保存版本链不一致。');
  }

  const previous = history!.activeStack.length >= 2
    ? history!.activeStack[history!.activeStack.length - 2]!.template
    : builtInOf(parsed.templateId) ?? null;
  const restoredVersion = previous ? previous.version : null;
  const receipt: StudyMethodUndoReceipt = Object.freeze({
    status: 'undone', templateId: parsed.templateId, restoredVersion,
    template: previous ? parseStudyMethodTemplate(previous) : null,
  });
  const stepKey = requestId !== undefined ? `req:${requestId}` : `undo:${top.stepKey}`;
  const input: Json = requestId !== undefined ? { undoToken } : { undoToken, targetStepKey: top.stepKey };
  await recordEffect(tx, ownerId, stepKey, studyMethodTemplateUndoLabel, input, receipt);
  return receipt;
}
