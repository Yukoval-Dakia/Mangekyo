import { derivationId, factId, type ReadContext, type Revision } from '@mangekyo/kernel';

export const researchPurpose = 'background-research';
export const researchSettingsType = 'companion.researchSettings';
export const researchOrderType = 'companion.researchOrder';
export const researchWorksheetType = 'companion.researchWorksheet';
export const retentionReviewPermissionType = 'companion.retentionReviewPermission';
export const allowRetentionReview = 'companion.allowRetentionReview';
export const configureResearch = 'companion.configureResearch';
export const publishWorksheet = 'companion.publishWorksheet';

export class ResearchBasisChanged extends Error {}

function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('教研记录格式无效。');
  return value as Record<string, unknown>;
}

export function researchEnabled(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('教研开关格式无效。');
  return value;
}

export function researchRevision(value: unknown, minimum = 1): Revision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('教研记录版本无效。');
  return value as Revision;
}

export function retentionReviewPermission(value: unknown) {
  const { key, resultId, allowed } = object(value);
  return { key: factId(String(key)), resultId: derivationId(String(resultId)), allowed: researchEnabled(allowed) };
}

/** One cumulative USD budget, denominated in integer millionths of a dollar. */
export function researchScoutBudget(value: unknown) {
  if (value === null) return null;
  const { limitMicros, expiresAtMs, route } = object(value);
  if (typeof limitMicros !== 'number' || !Number.isSafeInteger(limitMicros) || limitMicros <= 0 ||
      typeof expiresAtMs !== 'number' || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 ||
      typeof route !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/.test(route))
    throw new Error('前哨额度、到期时间或服务标识无效。');
  return { limitMicros, expiresAtMs, route };
}

export function researchSettings(value: unknown) {
  const { enabled, coordinatorRef, scoutBudget } = object(value);
  if (typeof coordinatorRef !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(coordinatorRef))
    throw new Error('教研协调器标识无效。');
  return { enabled: researchEnabled(enabled), coordinatorRef, scoutBudget: researchScoutBudget(scoutBudget ?? null) };
}

function researchSource(value: unknown) {
  const { attemptId, revision, accessEpoch, questionId } = object(value);
  if (typeof accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(accessEpoch) ||
      typeof questionId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(questionId))
    throw new Error('教研来源标识无效。');
  return { attemptId: factId(String(attemptId)), revision: researchRevision(revision), accessEpoch, questionId };
}

export function researchOrder(value: unknown) {
  const { settingsId, settingsRevision, source } = object(value);
  return {
    settingsId: factId(String(settingsId)),
    settingsRevision: researchRevision(settingsRevision),
    source: researchSource(source),
  };
}
export type ResearchOrder = ReturnType<typeof researchOrder>;

export async function readResearchSource(read: ReadContext, source: ResearchOrder['source']) {
  const attempt = await read.fact(source.attemptId, { mode: 'following' });
  if (!attempt.purpose.includes(researchPurpose) ||
      attempt.ref.rev !== source.revision || attempt.accessEpoch !== source.accessEpoch)
    throw new ResearchBasisChanged('原作或使用权限已变更。');
  return attempt;
}

export async function readResearchBasis(read: ReadContext, order: ResearchOrder) {
  const settings = await read.fact(order.settingsId, { mode: 'following' });
  if (settings.ref.rev !== order.settingsRevision || !researchSettings(settings.value).enabled)
    throw new ResearchBasisChanged('后台教研设置已变更。');
  return readResearchSource(read, order.source);
}

function text(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit ||
      !value.isWellFormed() || value.includes('\0')) throw new Error('复习单正文无效。');
  return value;
}

export function worksheetDraft(value: unknown) {
  const { title, steps } = object(value);
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 6)
    throw new Error('复习单需要一到六个步骤。');
  return { title: text(title, 120), steps: steps.map(step => text(step, 1000)) };
}

export function researchWorksheet(value: unknown) {
  const { orderId, todoId, source, draft, method, deliveredAt, digest } = object(value);
  if ((method !== 'deterministic-v1' && method !== 'local-agent') ||
      typeof deliveredAt !== 'string' || !Number.isFinite(Date.parse(deliveredAt)))
    throw new Error('复习单交付记录无效。');
  const body = { draft: worksheetDraft(draft), method, deliveredAt };
  return todoId === undefined
    ? { ...body, orderId: factId(String(orderId)) }
    : { ...body, todoId: factId(String(todoId)), source: researchSource(source), digest: text(digest, 160) };
}
