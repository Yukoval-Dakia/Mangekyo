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
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && jsonDeepEqual((left as never)[key], (right as never)[key]));
}

/**
 * Pure host glue for the learner study-method template library. Revisions and undos persist
 * as append-only `effects` receipts under one session owner; no historical version is ever
 * rewritten, so already-frozen classroom plans can never drift.
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
  return '{' + Object.keys(row).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(row[key])).join(',') + '}';
};

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const canonicalUndoToken = (template: StudyMethodTemplate) =>
  template.replacesVersion === undefined
    ? `undo:method-template:${template.templateId}:v${template.version}:create`
    : `undo:method-template:${template.templateId}:v${template.version}:from-v${template.replacesVersion}`;

export type TemplateChain = { versions: Map<number, StudyMethodTemplate>; head: number };

async function scanAppendRows(tx: ReadTransaction, ownerId: string) {
  const { rows } = await tx.query<{ input: unknown }>(
    `SELECT input FROM effects
       WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND label=$3 AND state='done'
       ORDER BY step_key`, [tx.learner, ownerId, studyMethodTemplateAppendLabel]);
  const chains = new Map<string, TemplateChain>();
  for (const row of rows) {
    const template = parseStudyMethodTemplate(record(row.input).template);
    const chain = chains.get(template.templateId) ?? { versions: new Map<number, StudyMethodTemplate>(), head: 0 };
    chain.versions.set(template.version, template);
    chain.head = Math.max(chain.head, template.version);
    chains.set(template.templateId, chain);
  }
  return chains;
}

async function scanUndoTokens(tx: ReadTransaction, ownerId: string): Promise<readonly string[]> {
  const { rows } = await tx.query<{ input: unknown }>(
    `SELECT input FROM effects
       WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND label=$3 AND state='done'`,
    [tx.learner, ownerId, studyMethodTemplateUndoLabel]);
  return rows.map(row => text(record(row.input).undoToken, '撤销令牌'));
}

const undoneVersions = (tokens: readonly string[]) => new Set(
  tokens.map(token => /^undo:method-template:[^:]+:v(\d+):/.exec(token)?.[1])
    .filter((value): value is string => value !== undefined).map(Number),
);

/** Highest saved version not cancelled by a recorded undo, walking back the replaces-chain. */
export function activeTemplateVersion(chain: TemplateChain, undoTokens: readonly string[]): number | undefined {
  const cancelled = undoneVersions(undoTokens);
  let head: number | undefined = chain.head;
  while (head !== undefined) {
    if (!cancelled.has(head)) return head;
    head = chain.versions.get(head)?.replacesVersion;
  }
  return undefined;
}

/** Built-in floor plus the learner's latest effective revisions; undone revisions roll back honestly. */
export function mergeStudyMethodLibrary(
  chains: ReadonlyMap<string, TemplateChain>, undoTokens: readonly string[],
): readonly StudyMethodTemplate[] {
  const merged = new Map<string, StudyMethodTemplate>(builtInStudyMethodTemplates.map(template => [template.templateId, template]));
  for (const [templateId, chain] of chains) {
    const active = activeTemplateVersion(chain, undoTokens);
    if (active === undefined) {
      if (!(templateId in builtInStudyMethodTemplateById)) merged.delete(templateId);
      continue;
    }
    merged.set(templateId, chain.versions.get(active)!);
  }
  return Object.freeze([...merged.values()].sort((left, right) => left.templateId.localeCompare(right.templateId)));
}

export async function loadStudyMethodLibrary(tx: ReadTransaction, ownerId: string) {
  const [chains, undoTokens] = await Promise.all([scanAppendRows(tx, ownerId), scanUndoTokens(tx, ownerId)]);
  return { chains, undoTokens, templates: mergeStudyMethodLibrary(chains, undoTokens) };
}

/** Resolve one pinned revision: a non-undone appended version, or the exact built-in floor. Never substitutes. */
export function resolveStudyMethodRevision(
  chains: ReadonlyMap<string, TemplateChain>, undoTokens: readonly string[],
  templateId: string, version: number,
): StudyMethodTemplate | undefined {
  const chain = chains.get(templateId);
  const candidate = chain?.versions.get(version);
  if (candidate && !undoneVersions(undoTokens).has(version)) return candidate;
  const builtIn = builtInStudyMethodTemplateById[templateId as keyof typeof builtInStudyMethodTemplateById];
  return builtIn?.version === version ? builtIn : undefined;
}

/** Resolve and freeze one template revision into a classroom plan instance; throws when unavailable. */
export async function instantiateStudyMethodForClassroom(
  tx: ReadTransaction, ownerId: string, templateId: string, version: number,
  instanceId: string, instantiatedAtIso: string,
) {
  const [chains, undoTokens] = await Promise.all([scanAppendRows(tx, ownerId), scanUndoTokens(tx, ownerId)]);
  const template = resolveStudyMethodRevision(chains, undoTokens, templateId, version);
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
  // The frontend sync contract posts the bare template without a request id; the caller derives a
  // content-addressed step key below so honest retries stay idempotent while conflicting revisions 409.
  const requestId = requestIdSource === undefined || requestIdSource === '' ? undefined : text(requestIdSource, '请求标识');
  return { template, ...(requestId === undefined ? {} : { requestId }) };
}

export function parseStudyMethodUndoRequest(raw: unknown): { undoToken: string; requestId: string } {
  const row = record(raw);
  for (const field of Object.keys(row))
    if (!['undoToken', 'requestId'].includes(field)) throw new StudyMethodHostValidationError(`撤销请求包含未知字段：${field}。`);
  const undoToken = text(row.undoToken, '撤销令牌');
  if (!undoToken.startsWith('undo:method-template:')) throw new StudyMethodHostValidationError('撤销令牌格式无效。');
  const requestId = row.requestId === undefined || row.requestId === '' ? undoToken : text(row.requestId, '请求标识');
  return { undoToken, requestId };
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
 * Append one template revision with full chain validation inside the caller's learner lock.
 * Versions are strictly monotonic over the append-only chain head; `replacesVersion` must
 * point at the currently active (non-undone) revision. Identical content already persisted
 * returns the canonical receipt without writing again.
 */
export async function saveStudyMethodTemplate(
  tx: DbTransaction, ownerId: string, raw: unknown,
): Promise<StudyMethodSaveReceipt> {
  const { template, requestId } = parseStudyMethodSaveRequest(raw);
  const token = canonicalUndoToken(template);
  if (template.undoToken !== undefined && template.undoToken !== token)
    throw new StudyMethodHostValidationError('撤销令牌与版本链不匹配。');
  const normalized: StudyMethodTemplate = parseStudyMethodTemplate({ ...template, undoToken: token });
  const input: Json = { template: normalized as unknown as Json };
  const inputDigest = await sha256Hex(canonicalJson(input));
  // Content-addressed fallback: bare-frontend retries of the identical payload replay the canonical
  // receipt, while different content falls through to the version-chain conflict checks below.
  const stepKey = requestId ?? `auto:method-template:${inputDigest.slice(0, 40)}`;
  const saved = await findEffect(tx, ownerId, stepKey, studyMethodTemplateAppendLabel);
  if (saved) {
    if (saved.input_digest !== inputDigest)
      throw new StudyMethodDuplicateRequestError('同一请求标识已用于不同的学法模板内容。');
    const result = record(saved.result);
    return { template: parseStudyMethodTemplate(result.template), undoToken: text(result.undoToken, '撤销令牌') };
  }
  const library = await loadStudyMethodLibrary(tx, ownerId);
  const chain = library.chains.get(template.templateId);
  const builtIn = builtInStudyMethodTemplateById[template.templateId as keyof typeof builtInStudyMethodTemplateById];
  if (chain?.versions.has(template.version)) {
    const recorded = chain.versions.get(template.version)!;
    if (!jsonDeepEqual(recorded, normalized))
      throw new StudyMethodHostConflictError(`学法模板 ${template.templateId} 的版本 v${template.version} 已存在且内容不同。`);
    return { template: recorded, undoToken: canonicalUndoToken(recorded) };
  }
  const headVersion = chain ? chain.head : builtIn?.version;
  const activeVersion = chain ? activeTemplateVersion(chain, library.undoTokens) : builtIn?.version;
  if (template.replacesVersion === undefined) {
    if (headVersion !== undefined)
      throw new StudyMethodHostConflictError(`学法模板 ${template.templateId} 已存在，修订必须声明 replacesVersion。`);
  } else {
    if (activeVersion === undefined || template.replacesVersion !== activeVersion)
      throw new StudyMethodHostConflictError(`replacesVersion v${template.replacesVersion} 与当前活跃版本不一致。`);
    if (template.version !== (headVersion ?? 0) + 1)
      throw new StudyMethodHostConflictError('学法模板版本必须沿版本链单调递增 1。');
  }
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

/** Append-only undo: cancels the currently active revision; frozen classroom plans never change. */
export async function undoStudyMethodTemplate(
  tx: DbTransaction, ownerId: string, raw: unknown,
): Promise<StudyMethodUndoReceipt> {
  const { undoToken, requestId } = parseStudyMethodUndoRequest(raw);
  const input: Json = { undoToken };
  const inputDigest = await sha256Hex(canonicalJson(input));
  const saved = await findEffect(tx, ownerId, requestId, studyMethodTemplateUndoLabel);
  if (saved) {
    if (saved.input_digest !== inputDigest)
      throw new StudyMethodDuplicateRequestError('同一请求标识已用于不同的撤销内容。');
    return parseUndoReceipt(saved.result);
  }
  const library = await loadStudyMethodLibrary(tx, ownerId);
  if (library.undoTokens.includes(undoToken))
    throw new StudyMethodHostConflictError('此撤销令牌已被使用，请携带原请求标识重放。');
  const match = /^undo:method-template:([^:]+):v(\d+):(create|from-v(\d+))$/.exec(undoToken);
  if (!match) throw new StudyMethodHostNotFoundError('找不到对应的学法模板版本。');
  const [, templateId, versionText, mode, fromText] = match;
  const chain = library.chains.get(templateId!);
  const version = Number(versionText);
  const target = chain?.versions.get(version);
  if (!target) {
    if (templateId! in builtInStudyMethodTemplateById)
      throw new StudyMethodHostConflictError('内置学法模板不可撤销。');
    throw new StudyMethodHostNotFoundError('找不到对应的学法模板版本。');
  }
  const consistent = mode === 'create' ? target.replacesVersion === undefined : target.replacesVersion === Number(fromText);
  if (!consistent) throw new StudyMethodHostNotFoundError('撤销令牌与已保存版本链不一致。');
  if (activeTemplateVersion(chain!, library.undoTokens) !== version)
    throw new StudyMethodHostConflictError('此版本已不再是当前活跃版本，无法撤销。');
  const restoredVersion = target.replacesVersion ?? null;
  const restoredTemplate = restoredVersion === null
    ? builtInStudyMethodTemplateById[templateId! as keyof typeof builtInStudyMethodTemplateById] ?? null
    : chain!.versions.get(restoredVersion) ??
      (builtInStudyMethodTemplateById[templateId! as keyof typeof builtInStudyMethodTemplateById]?.version === restoredVersion
        ? builtInStudyMethodTemplateById[templateId! as keyof typeof builtInStudyMethodTemplateById]! : null);
  const receipt: StudyMethodUndoReceipt = Object.freeze({
    status: 'undone', templateId: templateId!, restoredVersion,
    template: restoredTemplate ? parseStudyMethodTemplate(restoredTemplate) : null,
  });
  await recordEffect(tx, ownerId, requestId, studyMethodTemplateUndoLabel, input, receipt);
  return receipt;
}
