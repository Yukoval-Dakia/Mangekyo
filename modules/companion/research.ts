import { derivationId, factId, type ReadContext, type Revision } from '@mangekyo/kernel';

import { isWorksheetProfile, workerConsent, researchScoutBudget } from './worker-consent.ts';

export { researchScoutBudget } from './worker-consent.ts';

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

export function researchSettings(value: unknown) {
  const { enabled, coordinatorRef, scoutConsent, workerGrant } = object(value);
  if (typeof coordinatorRef !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(coordinatorRef))
    throw new Error('教研协调器标识无效。');
  // Earlier workers can only read scoutBudget. A consent with retention and price terms
  // uses its own field so those workers cannot dispatch without enforcing the terms.
  return { enabled: researchEnabled(enabled), coordinatorRef, scoutConsent: researchScoutBudget(scoutConsent ?? null), workerGrant: workerConsent(workerGrant ?? null, 'stored') };
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

export function worksheetBilling(value: unknown) {
  const {method, actualUsdMicros, references} = object(value);
  if (!isWorksheetProfile(method)) return {};
  if (!(actualUsdMicros === null || typeof actualUsdMicros === 'number' && Number.isSafeInteger(actualUsdMicros) && actualUsdMicros >= 0) ||
      !Array.isArray(references) || references.length !== (method === 'deep_analyst' ? 1 : 0))
    throw new Error('模型复习单缺少费用或来源见证。');
  return {actualUsdMicros, references:references.map(raw => {
    const {id,revision,accessEpoch,anchor} = object(raw);
    const ref = researchSource({attemptId:id,revision,accessEpoch,questionId:anchor});
    return {id:ref.attemptId,revision:ref.revision,accessEpoch:ref.accessEpoch,anchor:ref.questionId};
  })};
}

export function researchWorksheet(value: unknown) {
  const { orderId, todoId, source, draft, method, deliveredAt, digest } = object(value);
  if ((method !== 'deterministic-v1' && method !== 'local-agent' && !isWorksheetProfile(method)) ||
      typeof deliveredAt !== 'string' || !Number.isFinite(Date.parse(deliveredAt)))
    throw new Error('复习单交付记录无效。');
  const body = { ...worksheetBilling(value), draft: worksheetDraft(draft), method, deliveredAt };
  return todoId === undefined
    ? { ...body, orderId: factId(String(orderId)) }
    : { ...body, todoId: factId(String(todoId)), source: researchSource(source), digest: text(digest, 160) };
}
