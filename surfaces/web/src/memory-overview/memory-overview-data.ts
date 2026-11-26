import {
  isSafeInternalHref,
  safeInternalHref,
} from '../shared/safe-navigation';
import {
  isRecord,
  pickString,
  readArray,
  readBoolean,
  readNonEmptyString,
  readSafeInt,
  readStringList,
  readTrimmed,
} from '../shared/safe-values';
import type {
  CalibrationRecord,
  CalibrationSummary,
  MasteryIllusionAlert,
  MemoryActionRequest,
  MemoryActionSpec,
  MemoryBasisEntry,
  MemoryCategoryKey,
  MemoryHypothesisItem,
  MemoryItemActions,
  MemoryOverviewItem,
  MemoryOverviewResponse,
  MemoryRevokeSourceAction,
  MetacognitiveHabit,
  MetacognitiveHabitEvidence,
  WeaknessAndErrorSummaryView,
} from './types';

export { isSafeInternalHref };

const memoryOverviewPath = '/memory/overview';
const CATEGORY_KEYS: readonly MemoryCategoryKey[] = ['preference', 'claim', 'state', 'refusal'];

export async function fetchMemoryOverview(path = memoryOverviewPath): Promise<MemoryOverviewResponse> {
  const response = await fetch(`/api${path}`, { cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? '暂未取得记忆总览。' : '读取记忆总览失败。');
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return normalizeOverview(await response.json());
}

function isCategoryKey(value: unknown): value is MemoryCategoryKey {
  return typeof value === 'string' && (CATEGORY_KEYS as readonly string[]).includes(value);
}

function normalizeBasisEntry(value: unknown): MemoryBasisEntry | undefined {
  if (!isRecord(value)) return undefined;
  const kind = readNonEmptyString(value.kind);
  const id = readNonEmptyString(value.id);
  const rev = readSafeInt(value.rev) ?? 0;
  const accessEpoch = readNonEmptyString(value.accessEpoch);
  if (!id) return undefined;
  switch (kind) {
    case 'turn-quote':
      return {
        kind,
        id,
        rev,
        accessEpoch,
        excerpt: readNonEmptyString(value.excerpt),
        start: readSafeInt(value.start) ?? 0,
      };
    case 'scope-object':
      return {
        kind,
        id,
        rev,
        accessEpoch,
        ...(typeof value.type === 'string' ? { type: value.type } : {}),
      };
    case 'activity-citation': {
      const direction =
        value.direction === 'support' || value.direction === 'contradict' || value.direction === 'unresolved'
          ? value.direction
          : 'unresolved';
      return {
        kind,
        id,
        rev,
        accessEpoch,
        anchor: readNonEmptyString(value.anchor),
        direction,
        excerpt: readNonEmptyString(value.excerpt),
      };
    }
    case 'learner-declaration':
      return { kind, id, rev, accessEpoch };
    default:
      return undefined;
  }
}

function isActionSpec(value: unknown): value is MemoryActionSpec {
  return (
    isRecord(value) &&
    value.method === 'POST' &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    isRecord(value.body)
  );
}

function normalizeActions(value: unknown): MemoryItemActions {
  if (!isRecord(value)) return {};
  const actions: MemoryItemActions = {};
  if (isActionSpec(value.correct)) actions.correct = value.correct;
  if (isActionSpec(value.forget)) actions.forget = value.forget;
  if (isActionSpec(value.undo)) actions.undo = value.undo;
  const revokeSources = readArray(value.revokeSources, (entry) =>
    isActionSpec(entry) && typeof (entry as { sourceId?: unknown }).sourceId === 'string'
      ? (entry as MemoryRevokeSourceAction)
      : undefined,
  );
  if (revokeSources.length) actions.revokeSources = revokeSources;
  return actions;
}

function normalizeOverviewItem(
  value: unknown,
  fallbackCategory: MemoryCategoryKey,
): MemoryOverviewItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = readNonEmptyString(value.id);
  if (!id) return undefined;
  return {
    id,
    rev: readSafeInt(value.rev) ?? 0,
    accessEpoch: readNonEmptyString(value.accessEpoch),
    factType: readNonEmptyString(value.factType),
    category: isCategoryKey(value.category) ? value.category : fallbackCategory,
    text: readNonEmptyString(value.text, '未提供文字说明。'),
    origin: value.origin === 'learner' ? 'learner' : 'turn',
    authority: value.authority === 'directive' ? 'directive' : null,
    sticky: readBoolean(value.sticky),
    scope: value.scope ?? null,
    validUntil: typeof value.validUntil === 'string' && value.validUntil ? value.validUntil : null,
    expired: readBoolean(value.expired),
    refusal: value.refusal ?? null,
    recordedTick: readNonEmptyString(value.recordedTick),
    basis: readArray(value.basis, normalizeBasisEntry),
    actions: normalizeActions(value.actions),
  };
}

function normalizeHypothesis(value: unknown): MemoryHypothesisItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = readNonEmptyString(value.id);
  if (!id) return undefined;
  const review =
    value.review === 'supported' || value.review === 'contradicted' || value.review === 'unresolved'
      ? value.review
      : 'unknown';
  return {
    id,
    rev: readSafeInt(value.rev) ?? 0,
    accessEpoch: readNonEmptyString(value.accessEpoch),
    factType: readNonEmptyString(value.factType),
    kind: readNonEmptyString(value.kind, 'learning'),
    status: readNonEmptyString(value.status, 'unknown'),
    text: readNonEmptyString(value.text, readNonEmptyString(value.summary, '未提供文字说明。')),
    scope: value.scope ?? null,
    sticky: readBoolean(value.sticky),
    ttl: typeof value.ttl === 'string' && value.ttl ? value.ttl : null,
    review,
    basis: readArray(value.basis, normalizeBasisEntry),
    actions: normalizeActions(value.actions),
  };
}

function normalizeCalibration(value: unknown): CalibrationSummary {
  if (!isRecord(value)) {
    return { status: 'unknown', totalReconciliations: 0, confirmed: 0, missed: 0, recent: [] };
  }
  const recent = readArray<CalibrationRecord>(value.recent, (entry, index) => {
    if (!isRecord(entry)) return undefined;
    return {
      key: readNonEmptyString(entry.key, `reconciliation-${index}`),
      status: readNonEmptyString(entry.status, 'unknown'),
      conceptId: typeof entry.conceptId === 'string' && entry.conceptId ? entry.conceptId : null,
      occurredAt: readNonEmptyString(entry.occurredAt),
    };
  });
  const totalReconciliations = readSafeInt(value.totalReconciliations) ?? recent.length;
  const confirmed =
    readSafeInt(value.confirmed) ?? recent.filter((item) => item.status === 'confirmed').length;
  const missed = readSafeInt(value.missed) ?? Math.max(0, totalReconciliations - confirmed);
  return {
    status: value.status === 'available' ? 'available' : 'unknown',
    totalReconciliations,
    confirmed,
    missed,
    recent,
  };
}

function isWeaknessSummary(value: unknown): value is WeaknessAndErrorSummaryView {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.sampleCount)) return false;
  if (!Array.isArray(value.topErrorStages) || !Array.isArray(value.priorityConcepts)) return false;
  if (value.status === 'insufficient_evidence') return Number.isSafeInteger(value.neededCount);
  return value.status === 'ready';
}

function optionalUniqueList(value: unknown): readonly string[] | undefined {
  const list = readStringList(value, true);
  return list.length > 0 ? list : undefined;
}

function normalizeMasteryIllusionAlert(value: unknown, index: number): MasteryIllusionAlert | undefined {
  if (!isRecord(value)) return undefined;
  const errorStageLabel = pickString(value, 'errorStageLabel', 'error_stage_label');
  const targetPrompt = pickString(value, 'targetPrompt', 'target_prompt', 'promptExcerpt', 'prompt_excerpt');
  const discriminatorHint = pickString(
    value,
    'discriminatorHint',
    'discriminator_hint',
    'counterexampleTarget',
    'counterexample_target',
    'hint',
  );
  const conceptTitle =
    pickString(value, 'conceptTitle', 'concept_title', 'title') ??
    errorStageLabel ??
    targetPrompt ??
    discriminatorHint;
  const evidenceIds = optionalUniqueList(value.evidenceIds ?? value.evidence_ids);
  const count =
    readSafeInt(
      value.highConfidenceWrongCount ??
        value.high_confidence_wrong_count ??
        value.wrongCount ??
        value.count,
      1,
    ) ??
    (evidenceIds?.length ? evidenceIds.length : value.confidenceLevel === 'high' ? 1 : undefined);
  if (!conceptTitle || count === undefined) return undefined;

  const conceptId = pickString(value, 'conceptId', 'concept_id');
  const paperId = pickString(value, 'paperId', 'paper_id');
  const evidenceHref =
    safeInternalHref(value.evidenceHref) ??
    safeInternalHref(value.evidence_href) ??
    (paperId ? `/papers/${encodeURIComponent(paperId)}` : undefined);
  const practiceHref = safeInternalHref(value.practiceHref) ?? safeInternalHref(value.practice_href);
  const subject = readTrimmed(value.subject);
  const latestWrongSummary = pickString(value, 'latestWrongSummary', 'latest_wrong_summary', 'summary');
  const recommendedAction = pickString(value, 'recommendedAction', 'recommended_action');

  return {
    id: readTrimmed(value.id) ?? conceptId ?? `illusion-${index}`,
    conceptTitle,
    highConfidenceWrongCount: count,
    ...(conceptId ? { conceptId } : {}),
    ...(subject ? { subject } : {}),
    ...(errorStageLabel ? { errorStageLabel } : {}),
    ...(latestWrongSummary ? { latestWrongSummary } : {}),
    ...(discriminatorHint ? { discriminatorHint } : {}),
    ...(targetPrompt && targetPrompt !== conceptTitle ? { targetPrompt } : {}),
    ...(recommendedAction ? { recommendedAction } : {}),
    ...(evidenceIds ? { evidenceIds } : {}),
    ...(evidenceHref ? { evidenceHref } : {}),
    ...(practiceHref ? { practiceHref } : {}),
  };
}

function normalizeHabitEvidence(value: unknown): MetacognitiveHabitEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const excerpt = pickString(value, 'excerpt', 'quote', 'text');
  if (!excerpt) return undefined;
  const id = readTrimmed(value.id);
  const label = pickString(value, 'label', 'anchor', 'source');
  const href = safeInternalHref(value.href);
  return {
    excerpt,
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
    ...(href ? { href } : {}),
  };
}

function normalizeMetacognitiveHabit(value: unknown, index: number): MetacognitiveHabit | undefined {
  if (!isRecord(value)) return undefined;
  const title = pickString(value, 'title', 'label', 'name');
  const preStartHint = pickString(value, 'preStartHint', 'pre_start_hint');
  const confidenceNote = pickString(value, 'confidenceNote', 'confidence_note');
  const errorStageLabel = pickString(value, 'errorStageLabel', 'error_stage_label');
  const summary = pickString(value, 'summary', 'text') ?? preStartHint ?? confidenceNote ?? title;
  if (!title && !summary) return undefined;

  const subjects = optionalUniqueList(value.subjects);
  const sessionCount = readSafeInt(value.sessionCount ?? value.session_count, 1);
  const evidenceIds = optionalUniqueList(value.evidenceIds ?? value.evidence_ids);
  const rawEvidences = Array.isArray(value.evidences)
    ? value.evidences
    : Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs
      : Array.isArray(value.evidence_refs)
        ? value.evidence_refs
        : undefined;
  const evidences = rawEvidences ? readArray(rawEvidences, normalizeHabitEvidence) : undefined;
  const evidenceCount =
    readSafeInt(value.evidenceCount ?? value.evidence_count, 1) ??
    (evidences?.length ? evidences.length : evidenceIds?.length ? evidenceIds.length : undefined);
  const status = readTrimmed(value.status);

  return {
    id: readTrimmed(value.id) ?? `habit-${index}`,
    title: title ?? summary!,
    summary: summary ?? title!,
    ...(errorStageLabel ? { errorStageLabel } : {}),
    ...(preStartHint ? { preStartHint } : {}),
    ...(confidenceNote ? { confidenceNote } : {}),
    ...(subjects ? { subjects } : {}),
    ...(sessionCount !== undefined ? { sessionCount } : {}),
    ...(evidenceCount !== undefined ? { evidenceCount } : {}),
    ...(evidenceIds ? { evidenceIds } : {}),
    ...(status ? { status } : {}),
    ...(evidences?.length ? { evidences } : {}),
  };
}

const EXCLUDED_HABIT_STATUSES = new Set(['rejected', 'retracted', 'forgotten']);

function habitsFromHypotheses(
  hypotheses: readonly MemoryHypothesisItem[],
): readonly MetacognitiveHabit[] | undefined {
  const matched = hypotheses.filter(
    (item) => item.kind === 'metacognitive_habit' && !EXCLUDED_HABIT_STATUSES.has(item.status),
  );
  if (matched.length === 0) return undefined;
  return matched.map((item) => {
    const evidences: MetacognitiveHabitEvidence[] = [];
    for (const basis of item.basis) {
      if ((basis.kind === 'activity-citation' || basis.kind === 'turn-quote') && basis.excerpt.trim()) {
        const label = basis.kind === 'turn-quote' ? '对话原话' : readTrimmed(basis.anchor);
        evidences.push({
          id: `${basis.id}:${basis.rev}`,
          ...(label ? { label } : {}),
          excerpt: basis.excerpt.trim(),
        });
      }
    }
    const subjects = isRecord(item.scope) ? optionalUniqueList(item.scope.subjects) : undefined;
    return {
      id: item.id,
      title: item.text,
      summary: item.text,
      ...(subjects ? { subjects } : {}),
      ...(evidences.length > 0 ? { evidenceCount: evidences.length, evidences } : {}),
      ...(item.status && item.status !== 'unknown' ? { status: item.status } : {}),
    };
  });
}

export function normalizeOverview(value: unknown): MemoryOverviewResponse {
  if (!isRecord(value)) throw new Error('记忆总览格式无效。');
  const categories = isRecord(value.categories) ? value.categories : {};
  const stickyDirectives = readArray(value.stickyDirectives, (entry) => normalizeOverviewItem(entry, 'claim'));
  const hypotheses = readArray(value.hypotheses, normalizeHypothesis);
  const rawIllusions = value.masteryIllusionAlerts ?? value.mastery_illusion_alerts;
  const masteryIllusionAlerts = Array.isArray(rawIllusions)
    ? readArray(rawIllusions, normalizeMasteryIllusionAlert)
    : undefined;
  const rawHabits = value.metacognitiveHabits ?? value.metacognitive_habits;
  const metacognitiveHabits = Array.isArray(rawHabits)
    ? readArray(rawHabits, normalizeMetacognitiveHabit)
    : habitsFromHypotheses(hypotheses);

  return {
    asOf: readNonEmptyString(value.asOf, new Date().toISOString()),
    categories: {
      preference: readArray(categories.preference, (entry) => normalizeOverviewItem(entry, 'preference')),
      claim: readArray(categories.claim, (entry) => normalizeOverviewItem(entry, 'claim')),
      state: readArray(categories.state, (entry) => normalizeOverviewItem(entry, 'state')),
      refusal: readArray(categories.refusal, (entry) => normalizeOverviewItem(entry, 'refusal')),
    },
    stickyDirectives,
    hypotheses,
    calibration: normalizeCalibration(value.calibration),
    ...(isWeaknessSummary(value.weaknessSummary) ? { weaknessSummary: value.weaknessSummary } : {}),
    ...(masteryIllusionAlerts !== undefined ? { masteryIllusionAlerts } : {}),
    ...(metacognitiveHabits !== undefined ? { metacognitiveHabits } : {}),
  };
}

async function runActionSpec(spec: MemoryActionSpec): Promise<void> {
  const response = await fetch(spec.path, {
    method: spec.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec.body),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
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
