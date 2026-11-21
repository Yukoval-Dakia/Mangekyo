import { factId, type FactId } from '@mangekyo/kernel';
/** One cumulative USD budget, denominated in integer millionths of a dollar. */
export function researchScoutBudget(value: unknown) {
  if (value === null) return null;
  const { limitMicros, expiresAtMs, route, maxRetentionDays, maxPerCallMicros } = value as Record<string, unknown>;
  if (typeof limitMicros !== 'number' || !Number.isSafeInteger(limitMicros) || limitMicros <= 0 ||
      typeof expiresAtMs !== 'number' || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 ||
      typeof maxPerCallMicros !== 'number' || !Number.isSafeInteger(maxPerCallMicros) || maxPerCallMicros <= 0 ||
      typeof maxRetentionDays !== 'number' || !Number.isSafeInteger(maxRetentionDays) || maxRetentionDays < 0 ||
      typeof route !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/.test(route))
    throw new Error('前哨额度、到期时间、服务标识或留存天数无效。');
  return { limitMicros, expiresAtMs, route, maxRetentionDays, maxPerCallMicros };
}



export const worksheetProfiles = ['heavy_tutor_prep', 'deep_analyst', 'question_author'] as const;
export type WorksheetProfile = typeof worksheetProfiles[number];
export function isWorksheetProfile(value: unknown): value is WorksheetProfile {
  return worksheetProfiles.some(profile => value === profile);
}

export type WorkerConsent = NonNullable<ReturnType<typeof researchScoutBudget>> & {
  profile: WorksheetProfile | 'personalized_extractor'; providerId: string; accountRevision: string; model: string;
  comparisonAttemptId?: FactId; comparisonRevision?: number; comparisonAccessEpoch?: string;
};

export function workerConsent(value: unknown, mode: 'write' | 'stored' = 'write'): WorkerConsent | null {
  if (value === null) return null;
  const budget = researchScoutBudget(value);
  if (!budget) throw new Error('教研预算无效。');
  const { profile, providerId, accountRevision, model, comparisonAttemptId, comparisonRevision, comparisonAccessEpoch } = value as Record<string, unknown>;
  if ((!isWorksheetProfile(profile) && profile !== 'personalized_extractor') ||
      typeof providerId !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(providerId) ||
      typeof accountRevision !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(accountRevision) ||
      typeof model !== 'string' || !/^[a-z0-9._:/@+~-]{1,200}$/i.test(model))
    throw new Error('教研授权需要明确的工作类型、模型与接收账户。');
  const terms: WorkerConsent = { ...budget, profile, providerId, accountRevision, model };
  if (profile !== 'deep_analyst') {
    if ([comparisonAttemptId, comparisonRevision, comparisonAccessEpoch].some(field => field !== undefined))
      throw new Error('只有对照诊断使用第二份作答。');
    return terms;
  }
  const id = factId(String(comparisonAttemptId));
  if (mode === 'stored' && comparisonRevision === undefined && comparisonAccessEpoch === undefined)
    return { ...terms, comparisonAttemptId: id };
  if (typeof comparisonRevision !== 'number' || !Number.isSafeInteger(comparisonRevision) || comparisonRevision < 1 ||
      typeof comparisonAccessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(comparisonAccessEpoch))
    throw new Error('请重新选择有明确版本和权限代次的对照作答。');
  return { ...terms, comparisonAttemptId: id, comparisonRevision, comparisonAccessEpoch };
}
