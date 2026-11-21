import type {
  CalibrationRecord,
  CalibrationSummary,
  MemoryActionRequest,
  MemoryActionSpec,
  MemoryBasisEntry,
  MemoryCategoryKey,
  MemoryHypothesisItem,
  MemoryItemActions,
  MemoryOverviewItem,
  MemoryOverviewResponse,
  MemoryRevokeSourceAction,
} from './types';

const memoryOverviewPath = '/memory/overview';

export async function fetchMemoryOverview(path = memoryOverviewPath): Promise<MemoryOverviewResponse> {
  const response = await fetch(`/api${path}`, { cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? '暂未取得记忆总览。' : '读取记忆总览失败。');
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return normalizeOverview(await response.json());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function intOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

function boolOf(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const CATEGORY_KEYS: readonly MemoryCategoryKey[] = ['preference', 'claim', 'state', 'refusal'];

function isCategoryKey(value: unknown): value is MemoryCategoryKey {
  return typeof value === 'string' && (CATEGORY_KEYS as readonly string[]).includes(value);
}

function normalizeBasisEntry(value: unknown): MemoryBasisEntry | undefined {
  if (!isRecord(value)) return undefined;
  const kind = textOf(value.kind);
  const id = textOf(value.id);
  const rev = intOf(value.rev);
  const accessEpoch = textOf(value.accessEpoch);
  if (!id) return undefined;
  switch (kind) {
    case 'turn-quote':
      return {
        kind, id, rev, accessEpoch,
        excerpt: textOf(value.excerpt),
        start: intOf(value.start),
      };
    case 'scope-object':
      return {
        kind, id, rev, accessEpoch,
        ...(typeof value.type === 'string' ? { type: value.type } : {}),
      };
    case 'activity-citation': {
      const direction = value.direction === 'support' || value.direction === 'contradict' || value.direction === 'unresolved'
        ? value.direction
        : 'unresolved';
      return {
        kind, id, rev, accessEpoch,
        anchor: textOf(value.anchor),
        direction,
        excerpt: textOf(value.excerpt),
      };
    }
    case 'learner-declaration':
      return { kind, id, rev, accessEpoch };
    default:
      return undefined;
  }
}

function normalizeBasis(value: unknown): readonly MemoryBasisEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeBasisEntry).filter((entry): entry is MemoryBasisEntry => !!entry);
}

function isActionSpec(value: unknown): value is MemoryActionSpec {
  return (
    isRecord(value) &&
    value.method === 'POST' &&
    typeof value.path === 'string' && !!value.path &&
    isRecord(value.body)
  );
}

function normalizeRevokeSources(value: unknown): readonly MemoryRevokeSourceAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isActionSpec(entry) || typeof (entry as { sourceId?: unknown }).sourceId !== 'string') return undefined;
      return entry as MemoryRevokeSourceAction;
    })
    .filter((entry): entry is MemoryRevokeSourceAction => !!entry);
}

function normalizeActions(value: unknown): MemoryItemActions {
  if (!isRecord(value)) return {};
  const actions: MemoryItemActions = {};
  if (isActionSpec(value.correct)) actions.correct = value.correct;
  if (isActionSpec(value.forget)) actions.forget = value.forget;
  if (isActionSpec(value.undo)) actions.undo = value.undo;
  const revokeSources = normalizeRevokeSources(value.revokeSources);
  if (revokeSources.length) actions.revokeSources = revokeSources;
  return actions;
}

function normalizeOverviewItem(value: unknown, fallbackCategory: MemoryCategoryKey): MemoryOverviewItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = textOf(value.id);
  if (!id) return undefined;
  const category = isCategoryKey(value.category) ? value.category : fallbackCategory;
  const origin = value.origin === 'learner' ? 'learner' : 'turn';
  const authority = value.authority === 'directive' ? 'directive' : null;
  const validUntil = typeof value.validUntil === 'string' && value.validUntil ? value.validUntil : null;
  return {
    id,
    rev: intOf(value.rev),
    accessEpoch: textOf(value.accessEpoch),
    factType: textOf(value.factType),
    category,
    text: textOf(value.text, '未提供文字说明。'),
    origin,
    authority,
    sticky: boolOf(value.sticky),
    scope: value.scope ?? null,
    validUntil,
    expired: boolOf(value.expired),
    refusal: value.refusal ?? null,
    recordedTick: textOf(value.recordedTick),
    basis: normalizeBasis(value.basis),
    actions: normalizeActions(value.actions),
  };
}

function normalizeHypothesis(value: unknown): MemoryHypothesisItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = textOf(value.id);
  if (!id) return undefined;
  const review =
    value.review === 'supported' || value.review === 'contradicted' || value.review === 'unresolved'
      ? value.review
      : 'unknown';
  const ttl = typeof value.ttl === 'string' && value.ttl ? value.ttl : null;
  return {
    id,
    rev: intOf(value.rev),
    accessEpoch: textOf(value.accessEpoch),
    factType: textOf(value.factType),
    kind: textOf(value.kind, 'learning'),
    status: textOf(value.status, 'unknown'),
    text: textOf(value.text, textOf(value.summary, '未提供文字说明。')),
    scope: value.scope ?? null,
    sticky: boolOf(value.sticky),
    ttl,
    review,
    basis: normalizeBasis(value.basis),
    actions: normalizeActions(value.actions),
  };
}

function normalizeCalibrationRecord(value: unknown, index: number): CalibrationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const conceptId = typeof value.conceptId === 'string' && value.conceptId ? value.conceptId : null;
  const occurredAt = textOf(value.occurredAt);
  const key = textOf(value.key, `reconciliation-${index}`);
  const status = textOf(value.status, 'unknown');
  return { key, status, conceptId, occurredAt };
}

function normalizeCalibration(value: unknown): CalibrationSummary {
  if (!isRecord(value)) {
    return { status: 'unknown', totalReconciliations: 0, confirmed: 0, missed: 0, recent: [] };
  }
  const recent = Array.isArray(value.recent)
    ? value.recent.map(normalizeCalibrationRecord).filter((entry): entry is CalibrationRecord => !!entry)
    : [];
  const totalReconciliations = intOf(value.totalReconciliations, recent.length);
  const confirmed = intOf(value.confirmed, recent.filter(item => item.status === 'confirmed').length);
  const missed = intOf(value.missed, Math.max(0, totalReconciliations - confirmed));
  const status = value.status === 'available' ? 'available' : 'unknown';
  return { status, totalReconciliations, confirmed, missed, recent };
}

function normalizeCategoryArray(value: unknown, key: MemoryCategoryKey): readonly MemoryOverviewItem[] {
  if (!Array.isArray(value)) return [];
  return value.map(entry => normalizeOverviewItem(entry, key)).filter((entry): entry is MemoryOverviewItem => !!entry);
}

export function normalizeOverview(value: unknown): MemoryOverviewResponse {
  if (!isRecord(value)) throw new Error('记忆总览格式无效。');
  const categories = isRecord(value.categories) ? value.categories : {};
  const stickyDirectives = Array.isArray(value.stickyDirectives)
    ? value.stickyDirectives.map(entry => normalizeOverviewItem(entry, 'claim')).filter((entry): entry is MemoryOverviewItem => !!entry)
    : [];
  const hypotheses = Array.isArray(value.hypotheses)
    ? value.hypotheses.map(normalizeHypothesis).filter((entry): entry is MemoryHypothesisItem => !!entry)
    : [];
  return {
    asOf: textOf(value.asOf, new Date().toISOString()),
    categories: {
      preference: normalizeCategoryArray(categories.preference, 'preference'),
      claim: normalizeCategoryArray(categories.claim, 'claim'),
      state: normalizeCategoryArray(categories.state, 'state'),
      refusal: normalizeCategoryArray(categories.refusal, 'refusal'),
    },
    stickyDirectives,
    hypotheses,
    calibration: normalizeCalibration(value.calibration),
  };
}

async function runActionSpec(spec: MemoryActionSpec): Promise<void> {
  const response = await fetch(spec.path, {
    method: spec.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec.body),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: string } | null;
    const message = failure?.error ?? (response.status === 404 ? '该记忆已不存在。' : '操作未完成。');
    const error = new Error(message);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
}

async function defaultRunAction(request: MemoryActionRequest): Promise<void> {
  const spec = { ...request.spec };
  if (request.kind === 'correct' && request.text) {
    spec.body = { ...spec.body, text: request.text };
  }
  await runActionSpec(spec);
}

export const memoryOverviewDefaults = {
  fetchOverview: fetchMemoryOverview,
  runAction: defaultRunAction,
};
