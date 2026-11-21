import {
  factId,
  parseFactRevisionBasis,
  type FactId,
  type FactRevisionBasis,
  type FactSnapshot,
  type ReadContext,
  type Revision,
} from '@mangekyo/kernel';
import sourceFact from '@mangekyo/module-capture/facts/source';
import { storagePurpose } from './library-values.ts';

export const workbookAttachmentScopes = ['inherit', 'once'] as const;
export type WorkbookAttachmentScope = (typeof workbookAttachmentScopes)[number];

export const workbookAttachmentMimeTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type WorkbookAttachmentMimeType = (typeof workbookAttachmentMimeTypes)[number];

export const workbookAttachmentFileLimit = 10 * 1024 * 1024;
export const workbookAttachmentPerQuestionLimit = 8;
export const workbookAttachmentTotalLimit = 64;
export const workbookAttachmentAssessmentPurpose = 'workbook-assessment';
export const workbookAttachmentResearchPurpose = 'background-research';

const questionIdPattern = /^[A-Za-z0-9_-]{1,40}$/;
const requestIdPattern = /^[A-Za-z0-9_-]{8,100}$/;
const extensionByMimeType: Record<WorkbookAttachmentMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export class WorkbookAttachmentInputError extends Error {}
export class WorkbookAttachmentMediaError extends Error {}
export class WorkbookAttachmentSizeError extends Error {}
export class WorkbookAttachmentStateError extends Error {}
export class WorkbookAttachmentDeniedError extends Error {}

export function workbookAttachmentErrorStatus(error: unknown): number | null {
  if (error instanceof WorkbookAttachmentInputError) return 400;
  if (error instanceof WorkbookAttachmentDeniedError) return 403;
  if (error instanceof WorkbookAttachmentStateError) return 409;
  if (error instanceof WorkbookAttachmentSizeError) return 413;
  if (error instanceof WorkbookAttachmentMediaError) return 415;
  return null;
}

export type WorkbookAttachmentRef = {
  readonly originalId: FactId;
  readonly rev: Revision;
};

export type WorkbookQuestionAttachments = Record<string, readonly WorkbookAttachmentRef[]>;

export type WorkbookAttachmentView = {
  readonly originalId: FactId;
  readonly rev: Revision;
  readonly url: string;
  readonly available: boolean;
};

export type WorkbookQuestionAttachmentViews = Record<string, readonly WorkbookAttachmentView[]>;

export type WorkbookAttachmentEvidence = {
  readonly originalId: FactId;
  readonly rev: Revision;
  readonly url: string;
  readonly mimeType: WorkbookAttachmentMimeType;
};

export type WorkbookAttachmentUploadReceipt = {
  readonly originalId: FactId;
  readonly rev: Revision;
  readonly url: string;
  readonly mimeType: WorkbookAttachmentMimeType;
  readonly scope: WorkbookAttachmentScope;
};

export type PreparedWorkbookAttachmentUpload = {
  readonly requestId: string;
  readonly itemId?: string;
  readonly scope: WorkbookAttachmentScope;
  readonly mimeType: WorkbookAttachmentMimeType;
  readonly name: string;
  readonly title: string;
  readonly size: number;
  readonly purpose: readonly string[];
};

export function workbookAttachmentUrl(originalId: FactId): string {
  return `/api/materials/${originalId}/original`;
}

export function isWorkbookAttachmentMimeType(value: unknown): value is WorkbookAttachmentMimeType {
  return typeof value === 'string' && (workbookAttachmentMimeTypes as readonly string[]).includes(value);
}

function matchesBytes(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

export function detectWorkbookAttachmentMimeType(bytes: Uint8Array, declaredType?: unknown): WorkbookAttachmentMimeType {
  if (bytes.byteLength === 0) throw new WorkbookAttachmentInputError('请选择要上传的图片。');
  if (bytes.byteLength > workbookAttachmentFileLimit) throw new WorkbookAttachmentSizeError('单题图片不能超过 10 MB。');
  let detected: WorkbookAttachmentMimeType | null = null;
  if (matchesBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    detected = 'image/png';
  } else if (matchesBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    detected = 'image/jpeg';
  } else if (matchesBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matchesBytes(bytes, 8, [0x57, 0x45, 0x50, 0x50])) {
    detected = 'image/webp';
  }
  if (!detected) throw new WorkbookAttachmentMediaError('只支持 PNG、JPEG 或 WebP 图片。');
  if (typeof declaredType === 'string') {
    const normalized = declaredType.split(';')[0]!.trim().toLowerCase();
    if (normalized !== '' && normalized !== 'application/octet-stream' && normalized !== detected) {
      throw new WorkbookAttachmentMediaError('图片声明类型与文件内容不符，仅支持 PNG、JPEG 或 WebP。');
    }
  }
  return detected;
}

export function parseWorkbookAttachmentScope(value: unknown): WorkbookAttachmentScope {
  if (value === undefined || value === '') return 'inherit';
  if (value === 'inherit' || value === 'once') return value;
  throw new WorkbookAttachmentInputError('附件用途范围只支持 inherit 或 once。');
}

export function workbookAttachmentPurposes(scope: WorkbookAttachmentScope): readonly string[] {
  return scope === 'once'
    ? [storagePurpose, workbookAttachmentAssessmentPurpose]
    : [storagePurpose, workbookAttachmentAssessmentPurpose, workbookAttachmentResearchPurpose];
}

function safeAttachmentName(filename: unknown, mimeType: WorkbookAttachmentMimeType): string {
  const raw = typeof filename === 'string' ? filename : '';
  const leaf = (raw.replace(/\\/g, '/').split('/').at(-1) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const clean = leaf.slice(0, 180).toWellFormed();
  return clean || `question-photo.${extensionByMimeType[mimeType]}`;
}

export function prepareWorkbookAttachmentUpload(input: {
  readonly bytes: Uint8Array;
  readonly filename?: unknown;
  readonly declaredType?: unknown;
  readonly itemId?: unknown;
  readonly requestId?: unknown;
  readonly scope?: unknown;
  readonly generatedRequestId: string;
}): PreparedWorkbookAttachmentUpload {
  const mimeType = detectWorkbookAttachmentMimeType(input.bytes, input.declaredType);
  const scope = parseWorkbookAttachmentScope(input.scope);
  let itemId: string | undefined;
  if (input.itemId !== undefined && input.itemId !== '') {
    if (typeof input.itemId !== 'string' || !questionIdPattern.test(input.itemId)) {
      throw new WorkbookAttachmentInputError('题目标识无效。');
    }
    itemId = input.itemId;
  }
  let requestId: string;
  if (input.requestId !== undefined && input.requestId !== '') {
    if (typeof input.requestId !== 'string' || !requestIdPattern.test(input.requestId)) {
      throw new WorkbookAttachmentInputError('请求标识无效。');
    }
    requestId = input.requestId;
  } else {
    requestId = input.generatedRequestId;
  }
  return {
    requestId,
    ...(itemId === undefined ? {} : { itemId }),
    scope,
    mimeType,
    name: safeAttachmentName(input.filename, mimeType),
    title: itemId ? `单题作答照片 ${itemId}` : '单题作答照片',
    size: input.bytes.byteLength,
    purpose: workbookAttachmentPurposes(scope),
  };
}

export function buildWorkbookAttachmentSourceEnvelope(input: {
  readonly originalId: FactId;
  readonly paperId: FactId;
  readonly itemId?: string;
  readonly scope: WorkbookAttachmentScope;
  readonly name: string;
  readonly title: string;
  readonly mimeType: WorkbookAttachmentMimeType;
  readonly size: number;
  readonly sha256: string;
  readonly recordedAt: string;
}) {
  return {
    kind: 'photo' as const,
    retentionPolicy: 'retained' as const,
    occurredAt: null,
    recordedAt: input.recordedAt,
    originals: [{
      blobRef: input.originalId,
      name: input.name,
      mediaType: input.mimeType,
      size: input.size,
      sha256: input.sha256,
    }],
    unit: { kind: 'capture' as const, title: input.title, blocks: [] },
    workbookAttachment: {
      paperId: input.paperId,
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      scope: input.scope,
    },
  };
}

export function parseWorkbookQuestionAttachments(value: unknown): WorkbookQuestionAttachments | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkbookAttachmentInputError('单题附件格式无效。');
  }
  const parsed: WorkbookQuestionAttachments = {};
  let total = 0;
  for (const [questionId, rawEntries] of Object.entries(value as Record<string, unknown>)) {
    if (!questionIdPattern.test(questionId) || !Array.isArray(rawEntries)) {
      throw new WorkbookAttachmentInputError('单题附件题位或列表格式无效。');
    }
    if (rawEntries.length === 0) continue;
    if (rawEntries.length > workbookAttachmentPerQuestionLimit) {
      throw new WorkbookAttachmentInputError(`单题最多附带 ${workbookAttachmentPerQuestionLimit} 张图片。`);
    }
    const seen = new Set<string>();
    const entries: WorkbookAttachmentRef[] = [];
    for (const rawEntry of rawEntries) {
      if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        throw new WorkbookAttachmentInputError('单题附件条目必须是 {originalId, rev}。');
      }
      const { originalId: rawId, rev: rawRev, ...extra } = rawEntry as Record<string, unknown>;
      if (Object.keys(extra).length > 0 || typeof rawId !== 'string' || typeof rawRev !== 'number' ||
          !Number.isSafeInteger(rawRev) || rawRev < 1 || rawRev > 2_147_483_647) {
        throw new WorkbookAttachmentInputError('单题附件原件标识或版本无效。');
      }
      let originalId: FactId;
      try {
        originalId = factId(rawId);
      } catch {
        throw new WorkbookAttachmentInputError('单题附件原件标识无效。');
      }
      if (seen.has(originalId)) {
        throw new WorkbookAttachmentInputError('同一题不能重复绑定同一张原件。');
      }
      seen.add(originalId);
      entries.push({ originalId, rev: rawRev as Revision });
      total += 1;
      if (total > workbookAttachmentTotalLimit) {
        throw new WorkbookAttachmentInputError(`单次交卷最多附带 ${workbookAttachmentTotalLimit} 张图片。`);
      }
    }
    parsed[questionId] = entries;
  }
  return total > 0 ? parsed : undefined;
}

export function parseWorkbookAttemptBasis(value: unknown): readonly FactRevisionBasis[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > workbookAttachmentTotalLimit) {
    throw new WorkbookAttachmentInputError('作答附件依据格式无效。');
  }
  const seen = new Set<string>();
  const entries: FactRevisionBasis[] = [];
  for (const rawEntry of value) {
    const parsed = parseFactRevisionBasis(rawEntry);
    if (seen.has(parsed.id)) throw new WorkbookAttachmentInputError('作答附件依据包含重复原件。');
    seen.add(parsed.id);
    entries.push(parsed);
  }
  return entries.length > 0 ? entries : undefined;
}

export function checkWorkbookQuestionAttachments(
  questionIds: ReadonlySet<string>,
  attachments: WorkbookQuestionAttachments | undefined,
): void {
  if (!attachments) return;
  for (const questionId of Object.keys(attachments)) {
    if (!questionIds.has(questionId)) {
      throw new WorkbookAttachmentInputError('单题附件题位与这份试卷不匹配。');
    }
  }
}

export function checkWorkbookAttachmentsBasis(
  attachments: WorkbookQuestionAttachments | undefined,
  basis: readonly FactRevisionBasis[] | undefined,
): void {
  if (!attachments) return;
  const byId = new Map((basis ?? []).map(entry => [entry.id, entry]));
  for (const entries of Object.values(attachments)) {
    for (const entry of entries) {
      const witnessed = byId.get(entry.originalId);
      if (!witnessed || witnessed.rev !== entry.rev) {
        throw new WorkbookAttachmentInputError('归档作答缺少单题附件对应的依据。');
      }
    }
  }
}

export function uniqueWorkbookAttachmentIds(attachments: WorkbookQuestionAttachments | undefined): FactId[] {
  if (!attachments) return [];
  const ids = new Set<FactId>();
  for (const entries of Object.values(attachments)) {
    for (const entry of entries) ids.add(entry.originalId);
  }
  return [...ids].sort();
}

export function matchesWorkbookAttachmentBasis(fact: FactSnapshot, basis: FactRevisionBasis): boolean {
  if (fact.ref.id !== basis.id) return false;
  if (fact.ref.rev === basis.rev) return fact.accessEpoch === basis.epoch;
  if (fact.ref.rev > basis.rev && fact.equivalentSince !== undefined && basis.rev >= fact.equivalentSince.rev) {
    return (BigInt(fact.accessEpoch) - BigInt(fact.ref.rev - basis.rev)).toString() === basis.epoch;
  }
  return false;
}

export function parseWorkbookAttachmentSource(
  fact: FactSnapshot,
  paperId: string,
  questionId?: string,
): { readonly mimeType: WorkbookAttachmentMimeType; readonly scope: WorkbookAttachmentScope } | null {
  if (fact.type !== sourceFact.type) return null;
  let envelope;
  try {
    envelope = sourceFact.schema.parse(fact.value);
  } catch {
    return null;
  }
  const original = envelope.originals[0];
  const binding = envelope.workbookAttachment;
  if (envelope.kind !== 'photo' || envelope.originals.length !== 1 || !original ||
      original.blobRef !== fact.ref.id || !isWorkbookAttachmentMimeType(original.mediaType) ||
      !binding || binding.paperId !== paperId) {
    return null;
  }
  if (questionId !== undefined && binding.itemId !== undefined && binding.itemId !== questionId) {
    return null;
  }
  return { mimeType: original.mediaType, scope: binding.scope };
}

export async function authorizeWorkbookSubmissionAttachments(
  ctx: { readonly learner: string; readonly read: Pick<ReadContext, 'fact'> },
  paperId: FactId,
  attachments: WorkbookQuestionAttachments | undefined,
  requiredPurposes: readonly string[],
): Promise<readonly FactRevisionBasis[] | undefined> {
  if (!attachments) return undefined;
  const basisById = new Map<FactId, FactRevisionBasis>();
  for (const [questionId, entries] of Object.entries(attachments)) {
    for (const entry of entries) {
      const snapshot = await ctx.read.fact(entry.originalId, { mode: 'following' });
      if (snapshot.ref.learner !== ctx.learner) {
        throw new WorkbookAttachmentDeniedError('单题附件不属于当前学习者。');
      }
      if (snapshot.ref.rev !== entry.rev) {
        throw new WorkbookAttachmentStateError('单题图片原件版本或权限已变更，请重新上传后再交卷。');
      }
      const parsed = parseWorkbookAttachmentSource(snapshot, paperId, questionId);
      if (!parsed) {
        throw new WorkbookAttachmentStateError('所选原件不是本题有效的图片附件。');
      }
      for (const required of requiredPurposes) {
        if (!snapshot.purpose.includes(required) && !snapshot.purpose.includes('all')) {
          throw new WorkbookAttachmentDeniedError('单题图片原件缺少本次作答所需的用途授权。');
        }
      }
      const existing = basisById.get(entry.originalId);
      if (existing && (existing.rev !== snapshot.ref.rev || existing.epoch !== snapshot.accessEpoch)) {
        throw new WorkbookAttachmentStateError('同一原件在本次提交中的版本不一致。');
      }
      basisById.set(entry.originalId, {
        id: snapshot.ref.id,
        rev: snapshot.ref.rev,
        epoch: snapshot.accessEpoch,
      });
    }
  }
  return [...basisById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

type AttachmentAttemptLike = {
  readonly paperId: string;
  readonly questionAttachments?: WorkbookQuestionAttachments;
  readonly basis?: readonly FactRevisionBasis[];
};

export async function readWorkbookQuestionAttachments(
  open: (id: FactId) => Promise<FactSnapshot | null>,
  attempt: AttachmentAttemptLike,
  questionId: string,
): Promise<readonly (WorkbookAttachmentEvidence & { readonly basis: FactRevisionBasis })[]> {
  const refs = attempt.questionAttachments?.[questionId];
  if (!refs?.length) return [];
  const basisById = new Map((attempt.basis ?? []).map(entry => [entry.id, entry]));
  const results: (WorkbookAttachmentEvidence & { readonly basis: FactRevisionBasis })[] = [];
  for (const entry of refs) {
    const basis = basisById.get(entry.originalId);
    if (!basis || basis.rev !== entry.rev) continue;
    const snapshot = await open(entry.originalId);
    if (!snapshot || !matchesWorkbookAttachmentBasis(snapshot, basis)) continue;
    const parsed = parseWorkbookAttachmentSource(snapshot, attempt.paperId, questionId);
    if (!parsed) continue;
    results.push({
      originalId: entry.originalId,
      rev: entry.rev,
      url: workbookAttachmentUrl(entry.originalId),
      mimeType: parsed.mimeType,
      basis,
    });
  }
  return results;
}

export async function projectWorkbookAttemptAttachments(
  read: Pick<ReadContext, 'fact'>,
  attempt: AttachmentAttemptLike,
  unavailable: (error: unknown) => boolean,
): Promise<WorkbookQuestionAttachmentViews | undefined> {
  if (!attempt.questionAttachments) return undefined;
  const cache = new Map<FactId, Promise<FactSnapshot | null>>();
  const open = (id: FactId) => {
    const existing = cache.get(id);
    if (existing) return existing;
    const pending = read.fact(id, { mode: 'following' }).catch(error => {
      if (unavailable(error)) return null;
      throw error;
    });
    cache.set(id, pending);
    return pending;
  };
  const projected: WorkbookQuestionAttachmentViews = {};
  let count = 0;
  for (const questionId of Object.keys(attempt.questionAttachments)) {
    const items = await readWorkbookQuestionAttachments(open, attempt, questionId);
    if (!items.length) continue;
    projected[questionId] = items.map(({ originalId, rev, url }) => ({
      originalId,
      rev,
      url,
      available: true,
    }));
    count += items.length;
  }
  return count > 0 ? projected : undefined;
}

function formTextField(form: FormData, field: string): string | undefined {
  const values = form.getAll(field);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new WorkbookAttachmentInputError(`表单字段无效或重复：${field}`);
  }
  return values[0];
}

export async function parseWorkbookAttachmentMultipart(
  rawBody: Uint8Array,
  contentType: string | undefined,
  headerWatermark?: string,
): Promise<{
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly declaredType: string;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly scope?: string;
  readonly deletionWatermark?: string;
}> {
  if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'multipart/form-data') {
    throw new WorkbookAttachmentMediaError('需要 multipart/form-data 请求。');
  }
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(rawBody), { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new WorkbookAttachmentInputError('文件表单无法读取。');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string' || form.getAll('file').length !== 1) {
    throw new WorkbookAttachmentInputError('请选择一张图片。');
  }
  const itemId = formTextField(form, 'itemId');
  const requestId = formTextField(form, 'requestId');
  const scope = formTextField(form, 'scope');
  const deletionWatermark = formTextField(form, 'deletionWatermark') ?? headerWatermark;
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name,
    declaredType: file.type,
    ...(itemId === undefined ? {} : { itemId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(scope === undefined ? {} : { scope }),
    ...(deletionWatermark === undefined ? {} : { deletionWatermark }),
  };
}

export function workbookAttachmentRecordedAt(fact: FactSnapshot): string | null {
  try {
    return sourceFact.schema.parse(fact.value).recordedAt;
  } catch {
    return null;
  }
}

export async function verifyWorkbookAttachmentManifestInputs(
  read: Pick<ReadContext, 'fact'>,
  inputs: readonly { readonly kind: string; readonly id?: string; readonly rev?: number; readonly accessEpoch?: string; readonly mode?: string }[],
  unavailable: (error: unknown) => boolean,
): Promise<boolean> {
  for (const input of inputs) {
    if (input.kind !== 'fact' || input.mode !== 'following' || typeof input.id !== 'string' ||
        typeof input.rev !== 'number' || typeof input.accessEpoch !== 'string') return false;
    try {
      const basis = parseFactRevisionBasis({ id: input.id, rev: input.rev, epoch: input.accessEpoch });
      const live = await read.fact(basis.id, { mode: 'following' });
      if (!matchesWorkbookAttachmentBasis(live, basis)) return false;
    } catch (error) {
      if (unavailable(error)) return false;
      throw error;
    }
  }
  return true;
}
