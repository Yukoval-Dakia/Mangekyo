import type { CanonicalEvidenceSliceV1, EvidenceEventV1 } from '@mangekyo/kernel';
import { formatErrorStageLabel, type FlowGraphSnapshot } from './record-flow.ts';
export type QuestionSelectionRequest = {
  readonly need?: string;
  readonly coverage?: readonly string[];
  readonly conceptIds?: readonly string[];
  readonly durationMinutes?: number;
  readonly targetNovelty?: 'same' | 'isomorphic' | 'transfer';
  readonly errorStageFocus?: readonly string[];
  readonly excludeQuestionIds?: readonly string[];
  readonly maxCandidates?: number;
};
export type SelectionBankQuestion = {
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly prompt: string;
  readonly status?: string;
  readonly conceptIds?: readonly string[];
  readonly estMin?: number;
  readonly novelty?: 'same' | 'isomorphic' | 'transfer';
};
export type SelectionQuestionMetaTag = {
  readonly kind: 'target_skill' | 'prerequisite' | 'optional_method' | 'discriminator';
  readonly term: string;
  readonly scope?: string;
};
export type SelectionQuestionMeta = {
  readonly tags?: readonly SelectionQuestionMetaTag[];
  readonly solutions?: readonly { readonly method: string }[];
  readonly estimatedMinutes?: number;
  readonly representation?: string;
  readonly context?: string;
  readonly method?: string;
};
export type RecallSelectionInput = {
  readonly snap?: FlowGraphSnapshot;
  readonly questions: readonly SelectionBankQuestion[];
  readonly questionMetas?: ReadonlyMap<string, SelectionQuestionMeta>;
};
export type RecalledSelectionCandidate = {
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly prompt: string;
  readonly conceptIds: readonly string[];
  readonly novelty: 'same' | 'isomorphic' | 'transfer';
  readonly estMin: number;
  readonly semanticScore: number;
  readonly matchReasons: readonly string[];
  readonly representation?: string;
  readonly context?: string;
  readonly method?: string;
};
export type ExposureLockReason = 'attempted' | 'posttest' | 'help_exposed' | 'variant_spoiled' | 'explicit_exclude';
export type ExposureLock = {
  readonly questionId: string;
  readonly reason: ExposureLockReason;
  readonly reasonLabel: string;
  readonly spoiledBy?: string;
};
export type UnifiedExposureInput = {
  readonly snap?: FlowGraphSnapshot;
  readonly variantEdges?: readonly {
    readonly fromId: string;
    readonly toId: string;
    readonly spoilsNext?: 'none' | 'former' | 'latter' | 'both';
  }[];
  readonly exposedQuestionIds?: ReadonlySet<string> | readonly string[];
  readonly sources?: {
    readonly attempted?: readonly string[];
    readonly posttest?: readonly string[];
    readonly helpExposed?: readonly string[];
    readonly explicitExclude?: readonly string[];
  };
};
export type UnifiedExposureLockResult = {
  readonly locks: readonly ExposureLock[];
  readonly lockIds: readonly string[];
  readonly lockById: ReadonlyMap<string, ExposureLock>;
};
export type BuildSelectionSliceInput = {
  readonly clockWatermark: string;
  readonly asOfAt: string;
  readonly events: readonly EvidenceEventV1[];
  readonly omissions?: CanonicalEvidenceSliceV1['omissions'];
  readonly budgetMin?: number | null;
  readonly deadlines?: CanonicalEvidenceSliceV1['constraints']['deadlines'];
  readonly exposureLocks: readonly ExposureLock[] | readonly string[] | UnifiedExposureLockResult;
  readonly candidates: readonly RecalledSelectionCandidate[];
  readonly snap?: FlowGraphSnapshot;
  readonly maxCandidates?: number;
  readonly maxInputBytes?: number;
};
export type BuildSelectionSliceResult = {
  readonly slice: CanonicalEvidenceSliceV1;
  readonly unmappedCandidateIds: readonly string[];
  readonly truncatedCandidateIds: readonly string[];
};
export type SelectionUncertainty =
  | { readonly kind: 'unknown'; readonly reason: string; readonly needed: string }
  | { readonly kind: 'interval'; readonly low: number; readonly high: number };
export type SelectionInfoGainOk = {
  readonly method_version: 'plan/information-gain@1';
  readonly ranked_candidates: readonly {
    readonly ref: string;
    readonly est_min: number;
    readonly info_gain: number;
    readonly reason_code: 'probe-unknown' | 'reduce-uncertainty';
    readonly uncertainty: SelectionUncertainty;
  }[];
};
export type SelectionInfoGainOutcome = SelectionInfoGainOk | { readonly kind: 'unavailable'; readonly reason: string };
export type FinalizeQuestionSelectionInput = {
  readonly request: QuestionSelectionRequest;
  readonly candidates: readonly RecalledSelectionCandidate[];
  readonly exposureLocks: UnifiedExposureLockResult | readonly ExposureLock[];
  readonly infoGain: SelectionInfoGainOutcome;
  readonly snap?: FlowGraphSnapshot;
  readonly maxSelected?: number;
};
export type SelectedQuestionPlanItem = {
  readonly id: string;
  readonly ref: string;
  readonly rev: number;
  readonly title: string;
  readonly estMin: number;
  readonly infoGain: number | null;
  readonly reasonCode: 'probe-unknown' | 'reduce-uncertainty' | 'semantic-fallback';
  readonly reasonLabel: string;
  readonly uncertainty: SelectionUncertainty | null;
  readonly conceptIds: readonly string[];
  readonly novelty: 'same' | 'isomorphic' | 'transfer';
  readonly semanticScore: number;
  readonly matchReasons: readonly string[];
  readonly representation?: string;
  readonly context?: string;
  readonly method?: string;
};
export type EliminatedQuestionPlanItem = {
  readonly id: string;
  readonly title: string;
  readonly reasonCode:
    | 'exposed_attempted'
    | 'exposed_posttest'
    | 'exposed_help'
    | 'variant_spoiled'
    | 'explicit_exclude'
    | 'unmapped_concepts'
    | 'over_budget'
    | 'low_info_gain'
    | 'duplicate_coverage';
  readonly reasonLabel: string;
  readonly detail: string;
  readonly exposedBy?: string;
  readonly conceptIds: readonly string[];
};
export type SelectionCoverageStatus =
  | 'covered_high_gain'
  | 'covered_low_evidence'
  | 'uncovered_all_exposed'
  | 'uncovered_no_question';
export type SelectionCoverageReportEntry = {
  readonly target: string;
  readonly kind: 'concept' | 'coverage';
  readonly label: string;
  readonly status: SelectionCoverageStatus;
  readonly statusLabel: string;
  readonly selectedQuestionIds: readonly string[];
  readonly detail: string;
};
export type SelectionGapKind =
  | 'zero_question_concept'
  | 'all_exposed_need_variant'
  | 'error_stage_unaddressed'
  | 'budget_shortfall'
  | 'deriver_unavailable';
export type SelectionGap = {
  readonly kind: SelectionGapKind;
  readonly detail: string;
  readonly target?: string;
  readonly suggestedAction?: 'author_concept_gap' | 'author_mistake_variant';
  readonly errorStage?: string;
};
export type QuestionSelectionPlan = {
  readonly selected: readonly SelectedQuestionPlanItem[];
  readonly eliminated: readonly EliminatedQuestionPlanItem[];
  readonly estimatedMinutes: number;
  readonly coverageReport: readonly SelectionCoverageReportEntry[];
  readonly gaps: readonly SelectionGap[];
  readonly deriverStatus:
    | { readonly kind: 'ok'; readonly methodVersion: 'plan/information-gain@1' }
    | { readonly kind: 'unavailable'; readonly reason: string };
  readonly exposureLockCount: number;
};
const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const normalize = (value: string): string => value.normalize('NFKC').toLowerCase();
const uniqueSorted = (values: readonly string[]): readonly string[] => [...new Set(values.filter(Boolean))].sort();
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const round = (value: number): number => Math.round(value * 1000) / 1000;
const compareId = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const tokenIncludes = (haystack: string, needle: string): boolean => Boolean(needle) && haystack.includes(needle);
function termsOf(request: QuestionSelectionRequest): readonly string[] {
  return uniqueSorted([str(request.need), ...(request.coverage ?? []).map(str)].filter(Boolean).map(normalize));
}
function conceptTitle(snap: FlowGraphSnapshot | undefined, conceptId: string): string {
  const fact = snap?.factsById.get(conceptId);
  return str(rec(fact?.data).title) || str(rec(fact?.data).canonicalName);
}
type RawVariantEdge = {
  readonly fromId: string;
  readonly toId: string;
  readonly spoilsNext: 'none' | 'former' | 'latter' | 'both' | 'unknown';
};
function snapVariantEdges(snap: FlowGraphSnapshot | undefined): readonly RawVariantEdge[] {
  if (!snap) return [];
  const edges: RawVariantEdge[] = [];
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'content.knowledgeEdge') continue;
    const data = rec(fact.data);
    if (str(data.kind) !== 'variant_of') continue;
    const fromId = str(rec(rec(data.from).sourceUse).id);
    const toId = str(rec(rec(data.to).sourceUse).id);
    const raw = str(rec(data.variant).spoilsNext);
    const spoilsNext = raw === 'none' || raw === 'former' || raw === 'latter' || raw === 'both' ? raw : 'unknown';
    if (fromId && toId) edges.push({ fromId, toId, spoilsNext });
  }
  return edges;
}
function snapConceptEdges(snap: FlowGraphSnapshot | undefined): readonly { readonly questionId: string; readonly conceptId: string; readonly relation: string }[] {
  if (!snap) return [];
  const rows: { readonly questionId: string; readonly conceptId: string; readonly relation: string }[] = [];
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'content.knowledgeEdge') continue;
    const data = rec(fact.data);
    if (str(data.kind) !== 'targets_concept') continue;
    const questionId = str(rec(rec(data.from).sourceUse).id);
    const conceptId = str(rec(rec(data.to).sourceUse).id);
    if (questionId && conceptId) rows.push({ questionId, conceptId, relation: str(data.kind) });
  }
  return rows;
}
function estimateMinutes(question: SelectionBankQuestion, meta: SelectionQuestionMeta | undefined): number {
  const explicit = finite(meta?.estimatedMinutes) ?? finite(question.estMin);
  if (explicit !== null && explicit > 0) return explicit;
  const length = normalize(`${question.title}\n${question.prompt}`).length;
  const estimated = length < 120 ? 3 : length <= 320 ? 5 : 7;
  return Math.max(1, estimated);
}
function metadataOf(input: RecallSelectionInput, questionId: string): SelectionQuestionMeta | undefined {
  return input.questionMetas?.get(questionId);
}
function addScore(scores: Map<string, number>, id: string, amount: number) {
  scores.set(id, (scores.get(id) ?? 0) + amount);
}
function addReason(reasons: Map<string, Set<string>>, id: string, reason: string) {
  const held = reasons.get(id) ?? new Set<string>();
  held.add(reason);
  reasons.set(id, held);
}
function masteryWeaknessWeight(snap: FlowGraphSnapshot | undefined, conceptId: string): number {
  if (!snap) return 0;
  const mastery = rec(rec(snap.factsById.get(conceptId)?.data).mastery);
  const level = str(mastery.level);
  if (level === 'unknown') return 0.15;
  if (level === 'fragile') return 0.3;
  if (level === 'developing') return 0.18;
  return 0.06;
}
/** Four-dimension deterministic semantic recall over an authorized question bank snapshot. */
export function recallSelectionCandidates(request: QuestionSelectionRequest, input: RecallSelectionInput): readonly RecalledSelectionCandidate[] {
  const questions = input.questions.filter(question => question.status !== 'restricted');
  const ids = new Set(questions.map(question => question.id));
  const terms = termsOf(request);
  const targetConcepts = uniqueSorted((request.conceptIds ?? []).map(str));
  const targetSet = new Set(targetConcepts);
  const conceptEdges = snapConceptEdges(input.snap);
  const graphConceptIds = new Map<string, Set<string>>();
  for (const edge of conceptEdges) {
    const held = graphConceptIds.get(edge.questionId) ?? new Set<string>();
    held.add(edge.conceptId);
    graphConceptIds.set(edge.questionId, held);
  }
  const conceptOf = (question: SelectionBankQuestion): readonly string[] =>
    uniqueSorted([...(question.conceptIds ?? []).map(str), ...(graphConceptIds.get(question.id) ?? [])]);
  const neighborWeight = new Map<string, number>();
  for (const target of targetConcepts) {
    for (const neighbor of input.snap?.neighborsById.get(target) ?? []) {
      if (!['prereq_of', 'related_to', 'prerequisite', 'successor'].includes(neighbor.relation)) continue;
      neighborWeight.set(neighbor.targetId, Math.max(neighborWeight.get(neighbor.targetId) ?? 0, 0.6));
    }
  }
  const scores = new Map<string, number>();
  const reasons = new Map<string, Set<string>>();
  const semanticById = new Map<string, { representation?: string; context?: string; method?: string }>();
  const noExplicitTarget = terms.length === 0 && targetConcepts.length === 0;
  for (const question of questions) {
    const conceptIds = conceptOf(question);
    const directHits = conceptIds.filter(id => targetSet.has(id));
    if (directHits.length) {
      addScore(scores, question.id, 1 + 0.15 * (directHits.length - 1));
      addReason(reasons, question.id, '直接命中目标概念');
    }
    const neighborHits = conceptIds.filter(id => !targetSet.has(id) && neighborWeight.has(id));
    if (neighborHits.length) {
      addScore(scores, question.id, 0.6);
      addReason(reasons, question.id, '关联目标概念先修或邻近知识点');
    }
    const meta = metadataOf(input, question.id);
    const dimensions: { representation?: string; context?: string; method?: string } = {
      ...(str(meta?.representation) ? { representation: str(meta?.representation) } : {}),
      ...(str(meta?.context) ? { context: str(meta?.context) } : {}),
      ...(str(meta?.method) || str(meta?.solutions?.[0]?.method)
        ? { method: str(meta?.method) || str(meta?.solutions?.[0]?.method) } : {}),
    };
    semanticById.set(question.id, dimensions);
    if (meta?.tags?.length) {
      const tagWeight = { target_skill: 1.2, prerequisite: 0.55, optional_method: 0.5, discriminator: 0.8 } as const;
      let metaScore = 0;
      for (const tag of meta.tags) {
        const haystacks = [normalize(str(tag.term)), normalize(str(tag.scope))].filter(Boolean);
        const targetTitles = targetConcepts.map(id => normalize(conceptTitle(input.snap, id))).filter(Boolean);
        const hit = terms.some(term => haystacks.some(text => tokenIncludes(text, term) || tokenIncludes(term, text)))
          || targetTitles.some(title => haystacks.some(text => tokenIncludes(text, title) || tokenIncludes(title, text)))
          || conceptIds.some(id => targetSet.has(id) && tag.kind === 'target_skill');
        if (hit) {
          metaScore += tagWeight[tag.kind];
          addReason(reasons, question.id, tag.kind === 'target_skill' ? '语义标签命中目标技能'
            : tag.kind === 'prerequisite' ? '语义标签命中先修能力'
            : tag.kind === 'optional_method' ? '语义标签命中可选解法' : '语义标签命中辨别条件');
        }
      }
      if (metaScore > 0) addScore(scores, question.id, Math.min(1.6, metaScore));
    }
    const titlePrompt = normalize(`${question.title}\n${question.prompt}`);
    const termHits = terms.filter(term => tokenIncludes(titlePrompt, term));
    if (termHits.length) {
      addScore(scores, question.id, Math.min(0.9, 0.35 + 0.12 * (termHits.length - 1)));
      addReason(reasons, question.id, '题面自由词项命中');
    }
    if (noExplicitTarget) {
      const weakness = conceptIds.reduce((best, id) => Math.max(best, masteryWeaknessWeight(input.snap, id)), 0);
      addScore(scores, question.id, 0.1 + weakness + (conceptEdges.some(edge => edge.questionId === question.id) ? 0.12 : 0));
      addReason(reasons, question.id, '题库候选（按图谱关联与薄弱度排序）');
    }
  }
  const variantEdges = snapVariantEdges(input.snap);
  const directMatched = [...scores.keys()];
  for (const edge of variantEdges) {
    for (const sourceId of directMatched) {
      let candidateId: string | undefined;
      if (edge.fromId === sourceId && (edge.spoilsNext === 'none' || edge.spoilsNext === 'former')) candidateId = edge.toId;
      if (edge.toId === sourceId && (edge.spoilsNext === 'none' || edge.spoilsNext === 'latter')) candidateId = edge.fromId;
      if (!candidateId || candidateId === sourceId || !ids.has(candidateId)) continue;
      addScore(scores, candidateId, scores.has(candidateId) ? 0.08 : 0.42);
      addReason(reasons, candidateId, '同族安全变式题');
    }
  }
  const excluded = new Set((request.excludeQuestionIds ?? []).map(str).filter(Boolean));
  const limit = Math.max(1, Math.floor(finite(request.maxCandidates) ?? 64));
  return questions
    .filter(question => scores.has(question.id) && !excluded.has(question.id))
    .map(question => {
      const meta = metadataOf(input, question.id);
      const dimensions = semanticById.get(question.id) ?? {};
      const heldReasons = reasons.get(question.id) ?? new Set<string>();
      const novelty = heldReasons.has('同族安全变式题') ? 'isomorphic' : (question.novelty ?? 'same');
      return {
        id: question.id,
        rev: question.rev,
        title: question.title,
        prompt: question.prompt,
        conceptIds: conceptOf(question),
        novelty,
        estMin: estimateMinutes(question, meta),
        semanticScore: round(clamp((scores.get(question.id) ?? 0) / 2.8, 0, 1)),
        matchReasons: [...heldReasons].sort(),
        ...(dimensions.representation ? { representation: dimensions.representation } : {}),
        ...(dimensions.context ? { context: dimensions.context } : {}),
        ...(dimensions.method ? { method: dimensions.method } : {}),
      } satisfies RecalledSelectionCandidate;
    })
    .sort((left, right) => right.semanticScore - left.semanticScore || compareId(left.id, right.id))
    .slice(0, limit);
}
function exposureLabel(reason: ExposureLockReason): string {
  switch (reason) {
    case 'attempted': return '已作答曝光';
    case 'posttest': return '复测已曝光';
    case 'help_exposed': return '已看提示或解析';
    case 'variant_spoiled': return '同族题解法已剧透';
    case 'explicit_exclude': return '本次已排除';
  }
}
function lockRank(reason: ExposureLockReason): number {
  switch (reason) {
    case 'attempted': return 0;
    case 'posttest': return 1;
    case 'help_exposed': return 2;
    case 'variant_spoiled': return 3;
    case 'explicit_exclude': return 4;
  }
}
function putLock(locks: Map<string, ExposureLock>, questionId: string, reason: ExposureLockReason, spoiledBy?: string) {
  if (!questionId) return;
  const next: ExposureLock = { questionId, reason, reasonLabel: exposureLabel(reason), ...(spoiledBy ? { spoiledBy } : {}) };
  const held = locks.get(questionId);
  if (!held || lockRank(reason) < lockRank(held.reason) ||
      (lockRank(reason) === lockRank(held.reason) && compareId(next.spoiledBy ?? '', held.spoiledBy ?? '') < 0)) {
    locks.set(questionId, next);
  }
}
function attemptedQuestionsFromSnap(snap: FlowGraphSnapshot | undefined): readonly string[] {
  if (!snap) return [];
  const exposed = new Set<string>();
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'activity.workbookAttempt') continue;
    const paperId = str(rec(fact.data).paperId);
    const paper = paperId ? snap.factsById.get(paperId) : undefined;
    for (const rawQuestion of arr(rec(paper?.data).questions)) {
      const questionId = str(rec(rec(rawQuestion).sourceQuestionRef).id);
      if (questionId) exposed.add(questionId);
    }
  }
  return [...exposed].sort();
}
/** Merge all real exposure channels and explicit exclusions into deterministic lock ids. */
export function buildUnifiedExposureLocks(input: UnifiedExposureInput): UnifiedExposureLockResult {
  const locks = new Map<string, ExposureLock>();
  const explicit = new Set((input.sources?.explicitExclude ?? []).map(str).filter(Boolean));
  const exposedIds = input.exposedQuestionIds instanceof Set ? [...input.exposedQuestionIds] : [...(input.exposedQuestionIds ?? [])];
  for (const id of [...exposedIds, ...(input.sources?.attempted ?? []), ...attemptedQuestionsFromSnap(input.snap)].map(str).filter(Boolean)) {
    putLock(locks, id, 'attempted');
  }
  for (const id of (input.sources?.posttest ?? []).map(str).filter(Boolean)) putLock(locks, id, 'posttest');
  for (const id of (input.sources?.helpExposed ?? []).map(str).filter(Boolean)) putLock(locks, id, 'help_exposed');
  const edges = new Map<string, RawVariantEdge>();
  for (const edge of [...(input.variantEdges ?? []).map(edge => ({
    fromId: str(edge.fromId), toId: str(edge.toId), spoilsNext: (edge.spoilsNext ?? 'unknown') as RawVariantEdge['spoilsNext'],
  })), ...snapVariantEdges(input.snap)]) {
    if (!edge.fromId || !edge.toId || edge.fromId === edge.toId) continue;
    const key = `${edge.fromId} ${edge.toId}`;
    if (!edges.has(key)) edges.set(key, edge);
  }
  const directlyExposed = [...locks.keys()].filter(id => locks.get(id)?.reason !== 'variant_spoiled' && !explicit.has(id));
  for (const exposedId of directlyExposed) {
    for (const edge of edges.values()) {
      if (edge.fromId === exposedId && (edge.spoilsNext === 'latter' || edge.spoilsNext === 'both')) putLock(locks, edge.toId, 'variant_spoiled', exposedId);
      if (edge.toId === exposedId && (edge.spoilsNext === 'former' || edge.spoilsNext === 'both')) putLock(locks, edge.fromId, 'variant_spoiled', exposedId);
    }
  }
  for (const id of explicit) putLock(locks, id, 'explicit_exclude');
  const ordered = [...locks.values()].sort((left, right) => compareId(left.questionId, right.questionId) || lockRank(left.reason) - lockRank(right.reason));
  return { locks: ordered, lockIds: ordered.map(lock => lock.questionId), lockById: new Map(ordered.map(lock => [lock.questionId, lock])) };
}
function isUnifiedExposureLockResult(input: readonly ExposureLock[] | readonly string[] | UnifiedExposureLockResult): input is UnifiedExposureLockResult {
  return !Array.isArray(input) && input !== null && typeof input === 'object' && 'lockIds' in input && 'lockById' in input;
}
function lockIdsFrom(input: BuildSelectionSliceInput['exposureLocks']): readonly string[] {
  if (isUnifiedExposureLockResult(input)) return input.lockIds;
  if (input.length === 0) return [];
  if (typeof input[0] === 'string') return input as readonly string[];
  return (input as readonly ExposureLock[]).map(lock => lock.questionId);
}
function sliceByteLength(slice: CanonicalEvidenceSliceV1): number {
  return Buffer.byteLength(JSON.stringify(slice), 'utf8');
}
function eventTime(event: EvidenceEventV1): number {
  const parsed = Date.parse(event.occurred_at);
  return Number.isFinite(parsed) ? parsed : 0;
}
/** Build a schema-tight canonical evidence slice, with deterministic byte-budget truncation. */
export function buildSelectionEvidenceSlice(input: BuildSelectionSliceInput): BuildSelectionSliceResult {
  const crisisFiltered = input.snap
    ? input.events.filter(event => !input.snap?.feedbackByTurnId.get(event.ref)?.isCrisis)
    : [...input.events];
  const locks = uniqueSorted(lockIdsFrom(input.exposureLocks).map(str));
  const maxCandidates = Math.max(1, Math.min(64, Math.floor(finite(input.maxCandidates) ?? 64)));
  const seen = new Set<string>();
  const unmapped: string[] = [];
  const pool: { candidate: RecalledSelectionCandidate; conceptIds: readonly string[] }[] = [];
  for (const candidate of input.candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const conceptIds = uniqueSorted((candidate.conceptIds ?? []).map(str));
    if (!conceptIds.length) {
      unmapped.push(candidate.id);
      continue;
    }
    pool.push({ candidate, conceptIds });
  }
  pool.sort((left, right) => right.candidate.semanticScore - left.candidate.semanticScore || compareId(left.candidate.id, right.candidate.id));
  let selectedPool = pool.slice(0, maxCandidates);
  const truncated = new Set<string>();
  const maxInputBytes = Math.max(1024, Math.floor(finite(input.maxInputBytes) ?? 240 * 1024));
  const build = (events: readonly EvidenceEventV1[], poolRows: typeof selectedPool): CanonicalEvidenceSliceV1 => ({
    clock_watermark: input.clockWatermark,
    as_of_at: input.asOfAt,
    events,
    ...(input.omissions?.length ? { omissions: input.omissions } : {}),
    constraints: {
      budget_min: input.budgetMin ?? null,
      locks,
      deadlines: input.deadlines ?? [],
    },
    candidate_pool: poolRows.map(({ candidate, conceptIds }) => ({
      ref: candidate.id,
      concept_ids: conceptIds,
      item_novelty: candidate.novelty,
      est_min: Math.max(0.1, candidate.estMin),
      ...(candidate.representation ? { representation: candidate.representation } : {}),
      ...(candidate.context ? { context: candidate.context } : {}),
      ...(candidate.method ? { method: candidate.method } : {}),
    })),
  });
  let events = [...crisisFiltered];
  let slice = build(events, selectedPool);
  while (sliceByteLength(slice) > maxInputBytes && selectedPool.length > 0) {
    const removed = selectedPool[selectedPool.length - 1]!;
    truncated.add(removed.candidate.id);
    selectedPool = selectedPool.slice(0, -1);
    slice = build(events, selectedPool);
  }
  if (sliceByteLength(slice) > maxInputBytes && events.length > 0) {
    const ordered = [...events].sort((left, right) => eventTime(right) - eventTime(left) || compareId(left.ref, right.ref));
    let kept = ordered.length;
    let replaced = false;
    while (kept > 0) {
      const trial = build(ordered.slice(0, kept), selectedPool);
      if (sliceByteLength(trial) <= maxInputBytes) {
        events = ordered.slice(0, kept);
        slice = trial;
        replaced = true;
        break;
      }
      kept -= 1;
    }
    if (!replaced) {
      events = [];
      slice = build([], selectedPool);
    }
  }
  return {
    slice,
    unmappedCandidateIds: uniqueSorted(unmapped),
    truncatedCandidateIds: [...truncated].sort(),
  };
}
function lockMapFrom(input: FinalizeQuestionSelectionInput['exposureLocks']): ReadonlyMap<string, ExposureLock> {
  if (isUnifiedExposureLockResult(input)) return input.lockById;
  return new Map(input.map(lock => [lock.questionId, lock]));
}
function eliminationReason(lock: ExposureLock): EliminatedQuestionPlanItem['reasonCode'] {
  switch (lock.reason) {
    case 'attempted': return 'exposed_attempted';
    case 'posttest': return 'exposed_posttest';
    case 'help_exposed': return 'exposed_help';
    case 'variant_spoiled': return 'variant_spoiled';
    case 'explicit_exclude': return 'explicit_exclude';
  }
}
function errorStageWeakConcepts(snap: FlowGraphSnapshot | undefined): ReadonlySet<string> {
  const weak = new Set<string>();
  if (!snap) return weak;
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'companion.memoryAssertion') continue;
    const data = rec(fact.data);
    if (!str(data.errorStage) && !arr(data.evidence).some(entry => str(rec(entry).errorStage))) continue;
    for (const link of arr(data.links)) {
      const id = str(rec(link).id);
      if (id) weak.add(id);
    }
  }
  return weak;
}
function candidateMatchesCoverage(candidate: RecalledSelectionCandidate, target: string, input: FinalizeQuestionSelectionInput, kind: 'concept' | 'coverage'): boolean {
  if (kind === 'concept') return candidate.conceptIds.includes(target);
  const needle = normalize(target);
  if (!needle) return false;
  if (tokenIncludes(normalize(candidate.title), needle) || tokenIncludes(normalize(candidate.prompt), needle)) return true;
  return candidate.matchReasons.some(reason => tokenIncludes(normalize(reason), needle));
}
function coverageTargetLabel(target: string, input: FinalizeQuestionSelectionInput): string {
  return conceptTitle(input.snap, target) || target;
}
/** Deterministic greedy selection with honest degradation when the information-gain engine is unavailable. */
export function finalizeQuestionSelection(input: FinalizeQuestionSelectionInput): QuestionSelectionPlan {
  const lockById = lockMapFrom(input.exposureLocks);
  const candidates = [...new Map(input.candidates.map(candidate => [candidate.id, candidate])).values()]
    .sort((left, right) => compareId(left.id, right.id));
  const budget = finite(input.request.durationMinutes);
  const maxSelected = Math.max(1, Math.min(32, Math.floor(finite(input.maxSelected) ?? 5)));
  const ranked = new Map<string, SelectionInfoGainOk['ranked_candidates'][number]>();
  const infoGainOk = 'ranked_candidates' in input.infoGain;
  if (infoGainOk) {
    for (const row of input.infoGain.ranked_candidates) {
      const held = ranked.get(row.ref);
      if (!held || row.info_gain > held.info_gain || (row.info_gain === held.info_gain && compareId(row.ref, held.ref) < 0)) ranked.set(row.ref, row);
    }
  }
  const weakConcepts = errorStageWeakConcepts(input.snap);
  const errorFocus = new Set((input.request.errorStageFocus ?? []).map(str).filter(Boolean));
  const eliminated: EliminatedQuestionPlanItem[] = [];
  const eliminatedIds = new Set<string>();
  const budgetShortfalls = new Set<string>();
  const pushEliminated = (candidate: RecalledSelectionCandidate, reasonCode: EliminatedQuestionPlanItem['reasonCode'],
      reasonLabel: string, detail: string, exposedBy?: string) => {
    if (eliminatedIds.has(candidate.id)) return;
    eliminatedIds.add(candidate.id);
    eliminated.push({
      id: candidate.id,
      title: candidate.title,
      reasonCode,
      reasonLabel,
      detail,
      ...(exposedBy ? { exposedBy } : {}),
      conceptIds: candidate.conceptIds,
    });
  };
  const eligible: RecalledSelectionCandidate[] = [];
  for (const candidate of candidates) {
    const lock = lockById.get(candidate.id);
    if (lock) {
      pushEliminated(candidate, eliminationReason(lock), lock.reasonLabel,
        lock.reason === 'variant_spoiled'
          ? `同族题 ${lock.spoiledBy ?? ''} 的解法已曝光，本题无法独立检验迁移。`
          : `${lock.reasonLabel}，不能作为本次独立练习证据。`, lock.spoiledBy);
      continue;
    }
    if (!candidate.conceptIds.length) {
      pushEliminated(candidate, 'unmapped_concepts', '缺少知识点映射',
        '候选题没有可用概念映射，无法进入信息增益评估与覆盖核算。');
      continue;
    }
    eligible.push(candidate);
  }
  const selected: SelectedQuestionPlanItem[] = [];
  const selectedIds = new Set<string>();
  const coveredConcepts = new Set<string>();
  const focusBonus = (candidate: RecalledSelectionCandidate) =>
    errorFocus.size > 0 && candidate.conceptIds.some(id => weakConcepts.has(id)) ? 0.18 : 0;
  const targetNoveltyBonus = (candidate: RecalledSelectionCandidate) =>
    input.request.targetNovelty !== undefined && candidate.novelty === input.request.targetNovelty ? 0.08 : 0;
  const baseValueOf = (candidate: RecalledSelectionCandidate) => infoGainOk
    ? (ranked.get(candidate.id)?.info_gain ?? 0) * 3 + candidate.semanticScore + focusBonus(candidate) + targetNoveltyBonus(candidate)
    : candidate.semanticScore * 2 + focusBonus(candidate) + targetNoveltyBonus(candidate);
  const dynamicValueOf = (candidate: RecalledSelectionCandidate) =>
    baseValueOf(candidate) + (candidate.conceptIds.some(id => !coveredConcepts.has(id)) ? 0.18 : 0);
  const compareOrder = (left: RecalledSelectionCandidate, right: RecalledSelectionCandidate) =>
    dynamicValueOf(right) - dynamicValueOf(left) || right.semanticScore - left.semanticScore || compareId(left.id, right.id);
  let usedMinutes = 0;
  const remaining = [...eligible];
  while (selected.length < maxSelected && remaining.length) {
    remaining.sort(compareOrder);
    const candidate = remaining.shift()!;
    const overBudget = budget !== null && usedMinutes + candidate.estMin > budget;
    if (overBudget) {
      const rankedRow = ranked.get(candidate.id);
      pushEliminated(candidate, 'over_budget', '超出时长预算',
        `预计用时 ${candidate.estMin} 分钟，加入后将超出本次 ${budget} 分钟预算。`);
      if ((infoGainOk && (rankedRow?.info_gain ?? 0) >= 0.25) || (!infoGainOk && candidate.semanticScore >= 0.35)) {
        budgetShortfalls.add(candidate.id);
      }
      continue;
    }
    const rank = ranked.get(candidate.id);
    const reasonCode = infoGainOk ? (rank?.reason_code ?? 'reduce-uncertainty') : 'semantic-fallback';
    selected.push({
      id: candidate.id,
      ref: candidate.id,
      rev: candidate.rev,
      title: candidate.title,
      estMin: candidate.estMin,
      infoGain: infoGainOk ? rank?.info_gain ?? 0 : null,
      reasonCode,
      reasonLabel: infoGainOk
        ? reasonCode === 'probe-unknown' ? '探测未知能力边界' : '降低当前掌握不确定性'
        : '语义与图谱覆盖优先（信息增益引擎暂不可用）',
      uncertainty: infoGainOk ? rank?.uncertainty ?? null : null,
      conceptIds: candidate.conceptIds,
      novelty: candidate.novelty,
      semanticScore: candidate.semanticScore,
      matchReasons: candidate.matchReasons,
      ...(candidate.representation ? { representation: candidate.representation } : {}),
      ...(candidate.context ? { context: candidate.context } : {}),
      ...(candidate.method ? { method: candidate.method } : {}),
    });
    selectedIds.add(candidate.id);
    usedMinutes += candidate.estMin;
    for (const conceptId of candidate.conceptIds) coveredConcepts.add(conceptId);
  }
  for (const candidate of remaining) {
    if (selectedIds.has(candidate.id) || eliminatedIds.has(candidate.id)) continue;
    const uncovered = candidate.conceptIds.filter(id => !coveredConcepts.has(id));
    pushEliminated(candidate, uncovered.length === 0 ? 'duplicate_coverage' : 'low_info_gain',
      uncovered.length === 0 ? '知识点已覆盖' : '信息增益较低',
      uncovered.length === 0
        ? '本题覆盖的知识点已由更高价值候选覆盖，继续加入只会重复占用时间。'
        : '在时长与名额约束下，本题的预期增益低于已选候选。');
  }
  const targets: { target: string; kind: 'concept' | 'coverage'; label: string }[] = [
    ...(input.request.conceptIds ?? []).map(str).filter(Boolean).map(id => ({ target: id, kind: 'concept' as const, label: coverageTargetLabel(id, input) })),
    ...(input.request.coverage ?? []).map(str).filter(Boolean).map(text => ({ target: text, kind: 'coverage' as const, label: text })),
  ];
  const coverageReport: SelectionCoverageReportEntry[] = [];
  const gaps: SelectionGap[] = [];
  const seenTargets = new Set<string>();
  for (const target of targets) {
    const key = `${target.kind}:${target.target}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    const relevant = candidates.filter(candidate => candidateMatchesCoverage(candidate, target.target, input, target.kind));
    const relevantIds = new Set(relevant.map(candidate => candidate.id));
    const covering = selected.filter(item => relevantIds.has(item.id));
    if (covering.length) {
      const high = infoGainOk && covering.some(item => (item.infoGain ?? 0) >= 0.25);
      const status: SelectionCoverageStatus = high ? 'covered_high_gain' : 'covered_low_evidence';
      coverageReport.push({
        target: target.target,
        kind: target.kind,
        label: target.label,
        status,
        statusLabel: high ? '已覆盖（高信息增益）' : '已覆盖（待补强证据）',
        selectedQuestionIds: covering.map(item => item.id),
        detail: high ? '已选题能够以较高信息增益检验该目标。' : '已选题覆盖该目标，但证据强度或增益仍待补强。',
      });
      continue;
    }
    if (!relevant.length) {
      coverageReport.push({
        target: target.target,
        kind: target.kind,
        label: target.label,
        status: 'uncovered_no_question',
        statusLabel: '题库暂无对应题，建议补缺',
        selectedQuestionIds: [],
        detail: '题库中暂无可用于该目标的候选题。',
      });
      gaps.push({
        kind: 'zero_question_concept',
        detail: `目标「${target.label}」没有可召回候选题。`,
        target: target.target,
        suggestedAction: 'author_concept_gap',
      });
      continue;
    }
    const allLocked = relevant.every(candidate => lockById.has(candidate.id));
    coverageReport.push({
      target: target.target,
      kind: target.kind,
      label: target.label,
      status: allLocked ? 'uncovered_all_exposed' : 'uncovered_no_question',
      statusLabel: allLocked ? '题库均已曝光，建议出变式' : '题库暂无对应题，建议补缺',
      selectedQuestionIds: [],
      detail: allLocked ? '现有相关题均已作答、复测或看过解析，无法独立检验。' : '相关候选未能在预算与名额内形成有效覆盖。',
    });
    if (allLocked) {
      gaps.push({
        kind: 'all_exposed_need_variant',
        detail: `目标「${target.label}」的相关题均已曝光，需要生成安全变式。`,
        target: target.target,
        suggestedAction: 'author_mistake_variant',
      });
    }
  }
  for (const stage of errorFocus) {
    const concepts = [...weakConcepts].filter(id => candidates.some(candidate => candidate.conceptIds.includes(id)));
    const addressed = concepts.some(id => coveredConcepts.has(id));
    if (!addressed) {
      gaps.push({
        kind: 'error_stage_unaddressed',
        detail: `本次选排尚未覆盖与「${formatErrorStageLabel(stage)}」相关的薄弱概念。`,
        errorStage: stage,
      });
    }
  }
  for (const id of [...budgetShortfalls].sort()) {
    const candidate = candidates.find(item => item.id === id);
    if (!candidate) continue;
    if (candidate.conceptIds.some(conceptId => coveredConcepts.has(conceptId)) && gaps.some(gap => gap.kind === 'budget_shortfall')) continue;
    gaps.push({
      kind: 'budget_shortfall',
      detail: `高价值候选「${candidate.title}」预计 ${candidate.estMin} 分钟，因时长预算不足未纳入。`,
      target: id,
    });
  }
  if (!infoGainOk) {
    gaps.push({
      kind: 'deriver_unavailable',
      detail: `信息增益引擎不可用：${input.infoGain.reason}；已按语义、图谱覆盖与时长预算诚实降级。`,
    });
  }
  return {
    selected,
    eliminated: eliminated.slice(0, 16),
    estimatedMinutes: selected.reduce((sum, item) => sum + item.estMin, 0),
    coverageReport,
    gaps,
    deriverStatus: infoGainOk
      ? { kind: 'ok', methodVersion: 'plan/information-gain@1' }
      : { kind: 'unavailable', reason: input.infoGain.reason },
    exposureLockCount: lockById.size,
  };
}
