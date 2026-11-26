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

function isWeaknessSummary(value: unknown): value is WeaknessAndErrorSummaryView {
  if (!isRecord(value)) return false;
  if (value.status === 'insufficient_evidence') {
    return Number.isSafeInteger(value.sampleCount) && Number.isSafeInteger(value.neededCount)
      && Array.isArray(value.topErrorStages) && Array.isArray(value.priorityConcepts);
  }
  if (value.status === 'ready') {
    return Number.isSafeInteger(value.sampleCount)
      && Array.isArray(value.topErrorStages) && Array.isArray(value.priorityConcepts);
  }
  return false;
}

function positiveIntOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isSafeInternalHref(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  if (/^\/api(?:\/|\?|#|$)/i.test(href)) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(href)) return false;
  return true;
}

function safeInternalHref(value: unknown): string | undefined {
  const clean = optionalText(value);
  return clean && isSafeInternalHref(clean) ? clean : undefined;
}

function normalizeStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const entry of value) {
    const clean = optionalText(entry);
    if (clean && !items.includes(clean)) items.push(clean);
  }
  return items.length > 0 ? items : undefined;
}

function normalizeMasteryIllusionAlert(value: unknown, index: number): MasteryIllusionAlert | undefined {
  if (!isRecord(value)) return undefined;
  const errorStageLabel =
    optionalText(value.errorStageLabel) ?? optionalText(value.error_stage_label);
  const targetPrompt =
    optionalText(value.targetPrompt) ??
    optionalText(value.target_prompt) ??
    optionalText(value.promptExcerpt) ??
    optionalText(value.prompt_excerpt);
  const discriminatorHint =
    optionalText(value.discriminatorHint) ??
    optionalText(value.discriminator_hint) ??
    optionalText(value.counterexampleTarget) ??
    optionalText(value.counterexample_target) ??
    optionalText(value.hint);
  const conceptTitle =
    optionalText(value.conceptTitle) ??
    optionalText(value.concept_title) ??
    optionalText(value.title) ??
    errorStageLabel ??
    targetPrompt ??
    discriminatorHint;
  const evidenceIds = normalizeStringList(value.evidenceIds ?? value.evidence_ids);
  const count =
    positiveIntOrUndefined(
      value.highConfidenceWrongCount ??
        value.high_confidence_wrong_count ??
        value.wrongCount ??
        value.count,
    ) ??
    (evidenceIds && evidenceIds.length > 0
      ? evidenceIds.length
      : value.confidenceLevel === 'high'
        ? 1
        : undefined);
  if (!conceptTitle || count === undefined) return undefined;
  const conceptId = optionalText(value.conceptId) ?? optionalText(value.concept_id);
  const id = optionalText(value.id) ?? conceptId ?? `illusion-${index}`;
  const subject = optionalText(value.subject);
  const latestWrongSummary =
    optionalText(value.latestWrongSummary) ??
    optionalText(value.latest_wrong_summary) ??
    optionalText(value.summary);
  const recommendedAction =
    optionalText(value.recommendedAction) ?? optionalText(value.recommended_action);
  const paperId = optionalText(value.paperId) ?? optionalText(value.paper_id);
  const evidenceHref =
    safeInternalHref(value.evidenceHref) ??
    safeInternalHref(value.evidence_href) ??
    (paperId ? `/papers/${encodeURIComponent(paperId)}` : undefined);
  const practiceHref =
    safeInternalHref(value.practiceHref) ?? safeInternalHref(value.practice_href);
  return {
    id,
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

function normalizeMasteryIllusionAlerts(value: unknown): readonly MasteryIllusionAlert[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(normalizeMasteryIllusionAlert)
    .filter((entry): entry is MasteryIllusionAlert => !!entry);
}

function normalizeHabitEvidence(value: unknown): MetacognitiveHabitEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const excerpt = optionalText(value.excerpt) ?? optionalText(value.quote) ?? optionalText(value.text);
  if (!excerpt) return undefined;
  const id = optionalText(value.id);
  const label = optionalText(value.label) ?? optionalText(value.anchor) ?? optionalText(value.source);
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
  const title =
    optionalText(value.title) ??
    optionalText(value.label) ??
    optionalText(value.name);
  const preStartHint =
    optionalText(value.preStartHint) ?? optionalText(value.pre_start_hint);
  const confidenceNote =
    optionalText(value.confidenceNote) ?? optionalText(value.confidence_note);
  const errorStageLabel =
    optionalText(value.errorStageLabel) ?? optionalText(value.error_stage_label);
  const summary =
    optionalText(value.summary) ??
    optionalText(value.text) ??
    preStartHint ??
    confidenceNote ??
    title;
  if (!title && !summary) return undefined;
  const id = optionalText(value.id) ?? `habit-${index}`;
  const subjects = normalizeStringList(value.subjects);
  const sessionCount = positiveIntOrUndefined(value.sessionCount ?? value.session_count);
  const evidenceIds = normalizeStringList(value.evidenceIds ?? value.evidence_ids);
  const rawEvidences = Array.isArray(value.evidences)
    ? value.evidences
    : Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs
      : Array.isArray(value.evidence_refs)
        ? value.evidence_refs
        : undefined;
  const evidences = rawEvidences
    ? rawEvidences.map(normalizeHabitEvidence).filter((entry): entry is MetacognitiveHabitEvidence => !!entry)
    : undefined;
  const evidenceCount =
    positiveIntOrUndefined(value.evidenceCount ?? value.evidence_count) ??
    (evidences && evidences.length > 0
      ? evidences.length
      : evidenceIds && evidenceIds.length > 0
        ? evidenceIds.length
        : undefined);
  const status = optionalText(value.status);
  return {
    id,
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
    ...(evidences && evidences.length > 0 ? { evidences } : {}),
  };
}

function habitsFromHypotheses(hypotheses: readonly MemoryHypothesisItem[]): readonly MetacognitiveHabit[] | undefined {
  const matched = hypotheses.filter(
    (item) =>
      item.kind === 'metacognitive_habit' &&
      item.status !== 'rejected' &&
      item.status !== 'retracted' &&
      item.status !== 'forgotten',
  );
  if (matched.length === 0) return undefined;
  return matched.map((item) => {
    const evidences: MetacognitiveHabitEvidence[] = [];
    for (const basis of item.basis) {
      if (basis.kind === 'activity-citation' && basis.excerpt.trim()) {
        evidences.push({
          id: `${basis.id}:${basis.rev}`,
          ...(basis.anchor.trim() ? { label: basis.anchor.trim() } : {}),
          excerpt: basis.excerpt.trim(),
        });
      } else if (basis.kind === 'turn-quote' && basis.excerpt.trim()) {
        evidences.push({
          id: `${basis.id}:${basis.rev}`,
          label: '对话原话',
          excerpt: basis.excerpt.trim(),
        });
      }
    }
    const subjects = isRecord(item.scope) ? normalizeStringList(item.scope.subjects) : undefined;
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

function normalizeMetacognitiveHabits(
  value: unknown,
  hypotheses: readonly MemoryHypothesisItem[],
): readonly MetacognitiveHabit[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map(normalizeMetacognitiveHabit)
      .filter((entry): entry is MetacognitiveHabit => !!entry);
  }
  return habitsFromHypotheses(hypotheses);
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
  const masteryIllusionAlerts = normalizeMasteryIllusionAlerts(
    value.masteryIllusionAlerts ?? value.mastery_illusion_alerts,
  );
  const metacognitiveHabits = normalizeMetacognitiveHabits(
    value.metacognitiveHabits ?? value.metacognitive_habits,
    hypotheses,
  );
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
