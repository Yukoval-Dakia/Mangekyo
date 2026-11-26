import {
  projectMetacognitivePatterns,
  type MasteryIllusionAlert,
  type MetacognitiveObservation,
} from '@mangekyo/module-learner/facts/metacognitive-patterns';
import {
  projectRecordFlow,
  type FlowGraphSnapshot,
  type RecordFlowView,
} from '@mangekyo/module-learner/facts/record-flow';

export type LivingMineMetricKey =
  | 'unknown_exam_gaps'
  | 'high_conf_misses'
  | 'supply_shortages'
  | 'warm_backfill_queue'
  | 'asset_entropy_candidates'
  | 'stale_unused_inventory';
export type WarmBackfillTier = 'hot' | 'warm' | 'cold';
export type WarmBackfillStatus = 'ready' | 'behind';
export type WarmBackfillPriority = 'active_error_related' | 'high_frequency_archetype' | 'recent_history';

export type LivingMineRadarHandle = {
  readonly id: string;
  readonly metric: LivingMineMetricKey;
  readonly kind: string;
  readonly title: string;
  readonly reasonLabel: string;
  readonly refId?: string;
  readonly tier?: WarmBackfillTier;
  readonly priority?: WarmBackfillPriority;
};

export type LivingMineMetricBucket = {
  readonly key: LivingMineMetricKey;
  readonly label: string;
  readonly count: number;
  readonly topHandles: readonly LivingMineRadarHandle[];
};

export type WarmBackfillCandidate = {
  readonly id: string;
  readonly kind: 'question' | 'attempt' | 'note' | 'textbook_page' | 'concept';
  readonly title: string;
  readonly currentDeriverVersion: number | string;
  readonly targetDeriverVersion: number | string;
  readonly tier: WarmBackfillTier;
  readonly status: WarmBackfillStatus;
  readonly priority: WarmBackfillPriority;
  readonly priorityRank: number;
  readonly sticky: boolean;
  readonly reasonLabel: string;
  readonly touchedAt?: string | null;
};

export type WarmBackfillRadarBucket = LivingMineMetricBucket & {
  readonly key: 'warm_backfill_queue';
  readonly hotCount: number;
  readonly warmCount: number;
  readonly coldBehindCount: number;
  readonly candidates: readonly WarmBackfillCandidate[];
};

export type LivingMineCompressionCandidate = {
  readonly candidateKey: string;
  readonly targetKind: 'chapter' | 'concept';
  readonly targetId: string;
  readonly targetTitle: string;
  readonly noteCount: number;
  readonly recommendedArtifact: 'emergency_card' | 'decision_tree';
  readonly sticky?: boolean;
  readonly noteIds?: readonly string[];
  readonly noteSummaries?: readonly string[];
  readonly hasUserAuthoredPage?: boolean;
};

export type AssetEntropyRadarBucket = LivingMineMetricBucket & {
  readonly key: 'asset_entropy_candidates';
  readonly duplicateConceptCount: number;
  readonly danglingReferenceCount: number;
  readonly compressionCandidateCount: number;
  readonly coarseConceptCount: number;
  readonly compressionCandidates: readonly LivingMineCompressionCandidate[];
};

export type LivingMineKbEntropyInput = {
  readonly duplicateConcepts?: readonly {
    readonly pairKey: string;
    readonly leftName: string;
    readonly rightName: string;
    readonly score?: number;
    readonly recommendedKeepId?: string;
    readonly recommendedMergeId?: string;
  }[];
  readonly danglingReferences?: readonly {
    readonly id: string;
    readonly holderId: string;
    readonly holderTitle?: string;
    readonly targetId: string;
    readonly reason: string;
    readonly sticky?: boolean;
  }[];
  readonly compressionCandidates?: readonly LivingMineCompressionCandidate[];
  readonly staleUnusedDrafts?: readonly {
    readonly assetKind: string;
    readonly assetId: string;
    readonly title: string;
    readonly ageDays: number;
    readonly sticky?: boolean;
  }[];
  readonly coarseConcepts?: readonly {
    readonly conceptId: string;
    readonly title: string;
    readonly linkedQuestionCount: number;
    readonly sticky?: boolean;
  }[];
};

export type DerivationWatermarkTarget = {
  readonly id: string;
  readonly kind?: WarmBackfillCandidate['kind'];
  readonly title: string;
  readonly currentDeriverVersion: number | string;
  readonly targetDeriverVersion: number | string;
  readonly activeChapter?: boolean;
  readonly inExamScope?: boolean;
  readonly recentlyOpened?: boolean;
  readonly lastAttemptWithin7Days?: boolean;
  readonly lastAttemptAt?: string | null;
  readonly lastAttemptAtMs?: number | null;
  readonly activeErrorRelated?: boolean;
  readonly highFrequencyArchetype?: boolean;
  readonly touchedWithinWarmWindow?: boolean;
  readonly touchedAt?: string | null;
  readonly sticky?: boolean;
  readonly isCrisis?: boolean;
};

export type LivingMineSupplyConceptInput = {
  readonly id: string;
  readonly title: string;
  readonly totalQuestionCount: number;
  readonly unexposedVariantCount: number;
  readonly activeChapter?: boolean;
  readonly isCrisis?: boolean;
};

export type LivingMineStaleItemInput = {
  readonly id?: string;
  readonly assetId?: string;
  readonly kind?: string;
  readonly assetKind?: string;
  readonly title: string;
  readonly ageDays?: number;
  readonly lastOpenedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly sticky?: boolean;
  readonly isCrisis?: boolean;
};

export type LivingMineHighConfMissInput = {
  readonly id?: string;
  readonly attemptId: string;
  readonly title?: string;
  readonly conceptTitle?: string;
  readonly reasonLabel?: string;
  readonly isCrisis?: boolean;
};

export type LivingMineExamConceptInput = {
  readonly id: string;
  readonly title: string;
  readonly masteryLevel?: 'unknown' | 'fragile' | 'developing' | 'solid';
  readonly evidenceCount?: number;
  readonly attemptCount?: number;
  readonly activeChapter?: boolean;
  readonly inExamScope?: boolean;
  readonly isCrisis?: boolean;
};

export type LivingMineRadarInput = {
  readonly snap: FlowGraphSnapshot;
  readonly observations?: readonly MetacognitiveObservation[];
  readonly asOfAt?: string;
  readonly generatedAt?: string;
  readonly nowMs?: number;
  readonly carePaused?: boolean;
  readonly examConcepts?: readonly LivingMineExamConceptInput[];
  readonly highConfidenceMisses?: readonly LivingMineHighConfMissInput[];
  readonly supplyConcepts?: readonly LivingMineSupplyConceptInput[];
  readonly derivationTargets?: readonly DerivationWatermarkTarget[];
  readonly staleInventoryItems?: readonly LivingMineStaleItemInput[];
  readonly kbEntropyRadar?: LivingMineKbEntropyInput;
  readonly staleThresholdDays?: number;
  readonly warmWindowDays?: number;
};

export type LivingMineRadar = {
  readonly generatedAt: string;
  readonly carePaused: boolean;
  readonly metrics: {
    readonly unknown_exam_gaps: LivingMineMetricBucket;
    readonly high_conf_misses: LivingMineMetricBucket;
    readonly supply_shortages: LivingMineMetricBucket;
    readonly warm_backfill_queue: WarmBackfillRadarBucket;
    readonly asset_entropy_candidates: AssetEntropyRadarBucket;
    readonly stale_unused_inventory: LivingMineMetricBucket;
  };
  readonly totalActionableCount: number;
  readonly topHandles: readonly LivingMineRadarHandle[];
};

export type WarmBackfillBatchOptions = {
  readonly budgetShare?: number;
  readonly totalSlotBudget?: number;
  readonly maxItems?: number;
  readonly foregroundActive: boolean;
  readonly includeHot?: boolean;
};

export type WarmBackfillBatchResult = {
  readonly selected: readonly WarmBackfillCandidate[];
  readonly deferred: readonly WarmBackfillCandidate[];
  readonly coldBehind: readonly WarmBackfillCandidate[];
  readonly budgetShare: number;
  readonly budgetCap: number;
  readonly blockedReason?: 'foreground_active';
  readonly statusLabel: string;
};

const METRIC_LABELS: Readonly<Record<LivingMineMetricKey, string>> = {
  unknown_exam_gaps: '考纲未知空白',
  high_conf_misses: '高信心错答',
  supply_shortages: '变式供给短缺',
  warm_backfill_queue: '温数据回填队列',
  asset_entropy_candidates: '知识资产熵候选',
  stale_unused_inventory: '过期未用库存',
};
const PRIORITY_RANK: Readonly<Record<WarmBackfillPriority, number>> = {
  active_error_related: 0,
  high_frequency_archetype: 1,
  recent_history: 2,
};
const METRIC_ORDER: readonly LivingMineMetricKey[] = [
  'high_conf_misses', 'unknown_exam_gaps', 'supply_shortages', 'warm_backfill_queue',
  'asset_entropy_candidates', 'stale_unused_inventory',
];

function top<T>(items: readonly T[]): readonly T[] { return items.slice(0, 3); }
function clamp01(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function validAge(value: number | undefined): number { return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0; }
function dateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function when(value: string | null | undefined): number { return dateMs(value) ?? 0; }
function recent(value: string | null | undefined, nowMs: number, windowMs: number): boolean {
  const at = dateMs(value);
  return at !== null && at <= nowMs && nowMs - at <= windowMs;
}
function handle(metric: LivingMineMetricKey, id: string, kind: string, title: string, reasonLabel: string, extra: {
  readonly refId?: string;
  readonly tier?: WarmBackfillTier;
  readonly priority?: WarmBackfillPriority;
} = {}): LivingMineRadarHandle {
  return { id, metric, kind, title, reasonLabel,
    ...(extra.refId !== undefined ? {refId: extra.refId} : {}),
    ...(extra.tier !== undefined ? {tier: extra.tier} : {}),
    ...(extra.priority !== undefined ? {priority: extra.priority} : {}) };
}
function bucket(key: LivingMineMetricKey, handles: readonly LivingMineRadarHandle[]): LivingMineMetricBucket {
  return {key, label: METRIC_LABELS[key], count: handles.length, topHandles: top(handles)};
}
function asKind(kind: string | undefined): WarmBackfillCandidate['kind'] {
  return kind === 'question' || kind === 'attempt' || kind === 'note' || kind === 'textbook_page' || kind === 'concept' ? kind : 'concept';
}
function priorityFor(target: DerivationWatermarkTarget): WarmBackfillPriority {
  if (target.activeErrorRelated) return 'active_error_related';
  if (target.highFrequencyArchetype) return 'high_frequency_archetype';
  return 'recent_history';
}
function sortCandidates(a: WarmBackfillCandidate, b: WarmBackfillCandidate): number {
  const tierRank = (value: WarmBackfillTier) => value === 'hot' ? 0 : value === 'warm' ? 1 : 2;
  return tierRank(a.tier) - tierRank(b.tier) || a.priorityRank - b.priorityRank ||
    when(b.touchedAt) - when(a.touchedAt) || a.id.localeCompare(b.id);
}
function sortBatchCandidates(a: WarmBackfillCandidate, b: WarmBackfillCandidate): number {
  return sortCandidates(a, b);
}
function nowFor(input: LivingMineRadarInput): number {
  if (input.nowMs !== undefined && Number.isFinite(input.nowMs)) return input.nowMs;
  return dateMs(input.asOfAt ?? input.generatedAt) ?? 0;
}

function projectedConcepts(input: LivingMineRadarInput): Map<string, { readonly view: RecordFlowView; readonly isCrisis: boolean }> {
  const out = new Map<string, { readonly view: RecordFlowView; readonly isCrisis: boolean }>();
  for (const fact of input.snap.factsById.values()) {
    const view = projectRecordFlow(fact.id, input.snap);
    if (view?.identity.kind === 'concept') out.set(fact.id, {view, isCrisis: false});
  }
  return out;
}

function unknownGapHandles(input: LivingMineRadarInput): readonly LivingMineRadarHandle[] {
  const projected = projectedConcepts(input);
  const concepts = new Map<string, { id: string; title: string; evidenceCount: number; attemptCount: number; unknown: boolean; active: boolean }>();
  for (const item of input.examConcepts ?? []) {
    if (item.isCrisis) continue;
    const flow = projected.get(item.id)?.view;
    const evidenceCount = item.evidenceCount ?? flow?.mastery.evidenceCount ?? 0;
    const attemptCount = item.attemptCount ?? flow?.attempts.length ?? 0;
    const unknown = item.masteryLevel === 'unknown' || flow?.mastery.level === 'unknown' || evidenceCount < 2 || attemptCount === 0;
    if (unknown) concepts.set(item.id, {id: item.id, title: item.title || flow?.identity.title || item.id, evidenceCount, attemptCount, unknown: true, active: Boolean(item.activeChapter || item.inExamScope)});
  }
  if (input.examConcepts === undefined) {
    for (const [id, entry] of projected) {
      const flow = entry.view;
      if (flow.mastery.level === 'unknown' || flow.mastery.evidenceCount < 2 || flow.attempts.length === 0) {
        if (!concepts.has(id)) concepts.set(id, {id, title: flow.identity.title, evidenceCount: flow.mastery.evidenceCount, attemptCount: flow.attempts.length, unknown: flow.mastery.level === 'unknown', active: false});
      }
    }
  }
  return [...concepts.values()].sort((a, b) => Number(b.attemptCount === 0) - Number(a.attemptCount === 0) || Number(b.unknown) - Number(a.unknown) || Number(b.active) - Number(a.active) || a.evidenceCount - b.evidenceCount || a.id.localeCompare(b.id)).map(item =>
    handle('unknown_exam_gaps', item.id, 'concept', item.title, item.attemptCount === 0 ? '考纲概念尚无作答记录' : '考纲概念的独立证据不足', {refId: item.id}));
}

function missHandles(input: LivingMineRadarInput): readonly LivingMineRadarHandle[] {
  const view = projectMetacognitivePatterns({snap: input.snap, ...(input.observations ? {observations: input.observations} : {}), ...(input.asOfAt ? {asOfAt: input.asOfAt} : {})});
  const entries = new Map<string, LivingMineRadarHandle>();
  const seen = new Set<string>();
  for (const alert of view.masteryIllusionAlerts) {
    entries.set(alert.attemptId, handle('high_conf_misses', alert.id, 'attempt', alert.conceptTitle ?? alert.itemId, '高信心错答，需要最小反例辨别题', {refId: alert.attemptId}));
    seen.add(alert.id); seen.add(alert.attemptId);
  }
  for (const miss of input.highConfidenceMisses ?? []) {
    if (miss.isCrisis) continue;
    const id = miss.id ?? miss.attemptId;
    if (seen.has(id) || seen.has(miss.attemptId)) continue;
    entries.set(miss.attemptId, handle('high_conf_misses', id, 'attempt', miss.title ?? miss.conceptTitle ?? miss.attemptId, miss.reasonLabel ?? '高信心错答，需要最小反例辨别题', {refId: miss.attemptId}));
    seen.add(id); seen.add(miss.attemptId);
  }
  return [...entries.values()];
}

function supplyHandles(input: LivingMineRadarInput): readonly LivingMineRadarHandle[] {
  return [...(input.supplyConcepts ?? [])].filter(item => !item.isCrisis && (item.totalQuestionCount === 0 || item.unexposedVariantCount <= 0))
    .sort((a, b) => Number(b.totalQuestionCount === 0) - Number(a.totalQuestionCount === 0) || Number(Boolean(b.activeChapter)) - Number(Boolean(a.activeChapter)) || a.id.localeCompare(b.id))
    .map(item => handle('supply_shortages', item.id, 'concept', item.title, item.totalQuestionCount === 0 ? '该概念暂无可练题目' : '该概念的未曝光变式已耗尽', {refId: item.id}));
}

function backfillCandidates(input: LivingMineRadarInput, nowMs: number): WarmBackfillCandidate[] {
  const warmWindowMs = Math.max(0, input.warmWindowDays ?? 30) * 86_400_000;
  return [...(input.derivationTargets ?? [])].filter(item => !item.isCrisis && String(item.currentDeriverVersion) !== String(item.targetDeriverVersion)).map(item => {
    const touchedAt = item.touchedAt ?? item.lastAttemptAt ?? null;
    const lastAttempt = item.lastAttemptAtMs ?? dateMs(item.lastAttemptAt);
    const lastAttemptWithin7Days = lastAttempt !== null && lastAttempt <= nowMs && nowMs - lastAttempt <= 7 * 86_400_000;
    const tier: WarmBackfillTier = item.activeChapter || item.inExamScope || item.recentlyOpened || item.lastAttemptWithin7Days || lastAttemptWithin7Days ? 'hot' : item.activeErrorRelated || item.highFrequencyArchetype || item.touchedWithinWarmWindow || recent(touchedAt, nowMs, warmWindowMs) ? 'warm' : 'cold';
    const priority = priorityFor(item);
    const status: WarmBackfillStatus = tier === 'cold' ? 'behind' : 'ready';
    const candidate: WarmBackfillCandidate = {id: item.id, kind: asKind(item.kind), title: item.title, currentDeriverVersion: item.currentDeriverVersion, targetDeriverVersion: item.targetDeriverVersion, tier, status, priority, priorityRank: PRIORITY_RANK[priority], sticky: item.sticky === true, reasonLabel: tier === 'hot' ? '活跃学习对象需立即刷新' : tier === 'warm' ? '温数据按维护配额回填' : '冷数据仅在需要时惰性刷新', ...(touchedAt !== null ? {touchedAt} : {})};
    return candidate;
  }).sort(sortCandidates);
}

function entropyBucket(input: LivingMineRadarInput): AssetEntropyRadarBucket {
  const source = input.kbEntropyRadar;
  const duplicates = source?.duplicateConcepts ?? [];
  const dangling = source?.danglingReferences ?? [];
  const compressionCandidates = source?.compressionCandidates ?? [];
  const coarse = source?.coarseConcepts ?? [];
  const handles = [
    ...duplicates.map(item => handle('asset_entropy_candidates', item.pairKey, 'duplicate_concept', `${item.leftName} / ${item.rightName}`, '发现疑似重复概念')),
    ...dangling.map(item => handle('asset_entropy_candidates', item.id, 'dangling_reference', item.holderTitle ?? item.holderId, '发现悬空知识引用')),
    ...compressionCandidates.map(item => handle('asset_entropy_candidates', item.candidateKey, item.targetKind, item.targetTitle, '碎片笔记可压缩为急救卡或决策树')),
    ...coarse.map(item => handle('asset_entropy_candidates', item.conceptId, 'coarse_concept', item.title, '概念粒度过粗，需要拆分确认')),
  ];
  return {key: 'asset_entropy_candidates', label: METRIC_LABELS.asset_entropy_candidates, count: handles.length, topHandles: top(handles), duplicateConceptCount: duplicates.length, danglingReferenceCount: dangling.length, compressionCandidateCount: compressionCandidates.length, coarseConceptCount: coarse.length, compressionCandidates};
}

function staleHandles(input: LivingMineRadarInput, nowMs: number): readonly LivingMineRadarHandle[] {
  const threshold = Math.max(0, input.staleThresholdDays ?? 14);
  const items = new Map<string, {id: string; kind: string; title: string; ageDays: number}>();
  for (const item of input.staleInventoryItems ?? []) {
    if (item.isCrisis) continue;
    const id = item.id ?? item.assetId;
    if (!id) continue;
    const computed = Math.max(validAge(item.ageDays), ...[item.lastOpenedAt, item.updatedAt].map(at => at ? Math.max(0, (nowMs - (dateMs(at) ?? nowMs)) / 86_400_000) : 0));
    if (computed >= threshold) items.set(id, {id, kind: item.kind ?? item.assetKind ?? 'asset', title: item.title, ageDays: computed});
  }
  for (const item of input.kbEntropyRadar?.staleUnusedDrafts ?? []) {
    if (!items.has(item.assetId) && item.ageDays >= threshold) items.set(item.assetId, {id: item.assetId, kind: item.assetKind, title: item.title, ageDays: item.ageDays});
  }
  return [...items.values()].sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id)).map(item => handle('stale_unused_inventory', item.id, item.kind, item.title, `已闲置约 ${Math.floor(item.ageDays)} 天`, {refId: item.id}));
}

export function buildLivingMineRadar(input: LivingMineRadarInput): LivingMineRadar {
  const generatedAt = input.generatedAt ?? input.asOfAt ?? new Date(0).toISOString();
  const unknown = unknownGapHandles(input);
  const misses = missHandles(input);
  const shortages = supplyHandles(input);
  const candidates = backfillCandidates(input, nowFor(input));
  const hotCount = candidates.filter(item => item.tier === 'hot').length;
  const warmCount = candidates.filter(item => item.tier === 'warm').length;
  const coldBehindCount = candidates.filter(item => item.tier === 'cold' || item.status === 'behind').length;
  const warm: WarmBackfillRadarBucket = {key: 'warm_backfill_queue', label: METRIC_LABELS.warm_backfill_queue, count: hotCount + warmCount, topHandles: top(candidates.filter(item => item.tier !== 'cold').map(item => handle('warm_backfill_queue', item.id, item.kind, item.title, item.reasonLabel, {refId: item.id, tier: item.tier, priority: item.priority}))), hotCount, warmCount, coldBehindCount, candidates};
  const entropy = entropyBucket(input);
  const stale = staleHandles(input, nowFor(input));
  const metrics = {unknown_exam_gaps: bucket('unknown_exam_gaps', unknown), high_conf_misses: bucket('high_conf_misses', misses), supply_shortages: bucket('supply_shortages', shortages), warm_backfill_queue: warm, asset_entropy_candidates: entropy, stale_unused_inventory: bucket('stale_unused_inventory', stale)};
  const all = METRIC_ORDER.flatMap(key => metrics[key].topHandles);
  const seen = new Set<string>();
  const topHandles = all.filter(item => !seen.has(item.id) && seen.add(item.id)).slice(0, 3);
  return {generatedAt, carePaused: input.carePaused === true, metrics, totalActionableCount: Object.values(metrics).reduce((sum, item) => sum + item.count, 0), topHandles};
}

export function selectWarmBackfillBatch(candidates: readonly WarmBackfillCandidate[], options: WarmBackfillBatchOptions): WarmBackfillBatchResult {
  const rawShare = options.budgetShare ?? 0.2;
  const budgetShare = clamp01(rawShare);
  const coldBehind = candidates.filter(item => item.tier === 'cold' || item.status === 'behind').sort(sortCandidates);
  const nonColdSorted = candidates.filter(item => item.tier !== 'cold' && item.status !== 'behind').sort(sortBatchCandidates);
  if (options.foregroundActive) return {selected: [], deferred: nonColdSorted, coldBehind, budgetShare, budgetCap: 0, blockedReason: 'foreground_active', statusLabel: '前台学习活跃，后台回填已立即让路'};
  const eligible = nonColdSorted.filter(item => options.includeHot !== false || item.tier === 'warm');
  const shareCap = budgetShare <= 0 ? 0 : options.totalSlotBudget !== undefined ? Math.floor(Math.max(0, options.totalSlotBudget) * budgetShare) : eligible.length === 0 ? 0 : Math.max(1, Math.floor(eligible.length * budgetShare));
  const budgetCap = options.maxItems === undefined ? shareCap : Math.min(shareCap, Math.max(0, Math.floor(options.maxItems)));
  return {selected: eligible.slice(0, budgetCap), deferred: eligible.slice(budgetCap), coldBehind, budgetShare, budgetCap, statusLabel: budgetCap > 0 ? '后台回填按维护配额运行' : '当前维护配额暂不安排回填'};
}
