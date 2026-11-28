import type { CanonicalEvidenceSliceV1, CriterionObservationV2, EvidenceEventV1, EvidenceEventV2 } from '@mangekyo/kernel';
import { crisisScopeFromSnap, formatErrorStageLabel, type FlowGraphSnapshot } from './record-flow.ts';
import type { SliceOmission } from './evidence-refs.ts';
import { eventAttributionStatus, formalItemCriteriaV2 } from './evidence-slice-v2.ts';
// Learner-produced events preserve real partial credit and optional V2
// criterion/identity coordinates. The wire schema admits them.
type WidenedOutcome<T> = T extends unknown
  ? Omit<T, 'outcome'> & {
      readonly outcome: 'correct' | 'incorrect' | 'partial' | 'unknown';
      readonly fact_ref?: EvidenceEventV2['fact_ref'];
      readonly item_id?: string;
      readonly criteria?: readonly CriterionObservationV2[];
      readonly attribution_status?: EvidenceEventV2['attribution_status'];
    }
  : never;
export type LearnerEvidenceEvent = WidenedOutcome<EvidenceEventV1>;
export type LearnerEvidenceSliceV1 = Omit<CanonicalEvidenceSliceV1, 'events' | 'omissions'> & {
  readonly events: readonly LearnerEvidenceEvent[];
  readonly omissions?: readonly SliceOmission[];
};
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
    readonly spoilsNext?: 'none' | 'former' | 'latter' | 'both' | 'unknown';
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
  readonly events?: readonly LearnerEvidenceEvent[];
  readonly omissions?: readonly SliceOmission[];
  readonly budgetMin?: number | null;
  readonly deadlines?: CanonicalEvidenceSliceV1['constraints']['deadlines'];
  readonly exposureLocks: readonly ExposureLock[] | readonly string[] | UnifiedExposureLockResult;
  readonly candidates: readonly RecalledSelectionCandidate[];
  readonly snap?: FlowGraphSnapshot;
  readonly maxCandidates?: number;
  readonly maxInputBytes?: number;
};
export type BuildSelectionSliceResult = {
  readonly slice: LearnerEvidenceSliceV1;
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
  readonly prompt: string;
  readonly estMin: number;
  readonly infoGain: number | null;
  readonly reasonCode: 'probe-unknown' | 'reduce-uncertainty' | 'semantic-fallback';
  readonly reasonLabel: string;
  readonly uncertainty: SelectionUncertainty | null;
  readonly coveredConcepts: readonly string[];
  readonly conceptIds: readonly string[];
  readonly novelty: 'same' | 'isomorphic' | 'transfer';
  readonly score: number;
  readonly semanticScore: number;
  readonly matchReasons: readonly string[];
  readonly representation?: string;
  readonly context?: string;
  readonly method?: string;
};
export type EliminatedQuestionPlanItem = {
  readonly id: string;
  readonly rev: number;
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
  readonly estMin?: number;
  readonly infoGain?: number | null;
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
  readonly conceptId?: string;
  readonly kind: 'concept' | 'coverage';
  readonly label: string;
  readonly status: SelectionCoverageStatus;
  readonly statusLabel: string;
  readonly matchedQuestionIds: readonly string[];
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
  readonly conceptId?: string;
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
function normalizeSpoilsNext(value: unknown): RawVariantEdge['spoilsNext'] {
  const raw = str(value);
  return raw === 'none' || raw === 'former' || raw === 'latter' || raw === 'both' ? raw : 'unknown';
}
// Fail-closed: an unknown spoilage direction locks in both directions rather than failing open.
function spoilDirs(spoilsNext: RawVariantEdge['spoilsNext']): { readonly forward: boolean; readonly backward: boolean } {
  switch (spoilsNext) {
    case 'none': return { forward: false, backward: false };
    case 'latter': return { forward: true, backward: false };
    case 'former': return { forward: false, backward: true };
    default: return { forward: true, backward: true };
  }
}
function snapVariantEdges(snap: FlowGraphSnapshot | undefined): readonly RawVariantEdge[] {
  if (!snap) return [];
  const edges: RawVariantEdge[] = [];
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'content.knowledgeEdge') continue;
    const data = rec(fact.data);
    if (str(data.kind) !== 'variant_of') continue;
    const fromId = str(rec(rec(data.from).sourceUse).id);
    const toId = str(rec(rec(data.to).sourceUse).id);
    const spoilsNext = normalizeSpoilsNext(rec(data.variant).spoilsNext);
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
    if (questionId && conceptId && snap.factsById.has(conceptId)) rows.push({ questionId, conceptId, relation: str(data.kind) });
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
      // A genuine transfer-level item keeps its novelty even inside a safe variant family.
      const novelty = heldReasons.has('同族安全变式题') && question.novelty !== 'transfer' ? 'isomorphic' : (question.novelty ?? 'same');
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
    case 'explicit_exclude': return 0;
    case 'attempted': return 1;
    case 'posttest': return 2;
    case 'variant_spoiled': return 3;
    case 'help_exposed': return 4;
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
    fromId: str(edge.fromId), toId: str(edge.toId), spoilsNext: normalizeSpoilsNext(edge.spoilsNext),
  })), ...snapVariantEdges(input.snap)]) {
    if (!edge.fromId || !edge.toId || edge.fromId === edge.toId) continue;
    const key = `${edge.fromId} ${edge.toId}`;
    const held = edges.get(key);
    if (!held) {
      edges.set(key, edge);
    } else {
      // Parallel evidence for one directed pair keeps the strictest union of spoilage directions.
      const merged = spoilDirs(edge.spoilsNext);
      const current = spoilDirs(held.spoilsNext);
      const forward = merged.forward || current.forward;
      const backward = merged.backward || current.backward;
      const spoilsNext: RawVariantEdge['spoilsNext'] = forward && backward ? (edge.spoilsNext === 'unknown' || held.spoilsNext === 'unknown' ? 'unknown' : 'both')
        : forward ? 'latter'
        : backward ? 'former'
        : 'none';
      edges.set(key, { fromId: edge.fromId, toId: edge.toId, spoilsNext });
    }
  }
  // Transitive closure over the directed spoilage graph: a spoiled variant is itself an
  // exposure source for downstream family members (BFS, cycle-safe). Sources keep their
  // role even when also explicitly excluded, so propagation never silently breaks.
  const adjacency = new Map<string, readonly string[]>();
  for (const edge of edges.values()) {
    const dirs = spoilDirs(edge.spoilsNext);
    if (dirs.forward) adjacency.set(edge.fromId, [...(adjacency.get(edge.fromId) ?? []), edge.toId]);
    if (dirs.backward) adjacency.set(edge.toId, [...(adjacency.get(edge.toId) ?? []), edge.fromId]);
  }
  for (const [id, list] of adjacency) adjacency.set(id, [...new Set(list)].sort(compareId));
  const sources = [...locks.keys()].filter(id => locks.get(id)?.reason !== 'variant_spoiled').sort(compareId);
  const spoiledOrigin = new Map<string, string>();
  const queue: { id: string; origin: string }[] = [];
  for (const sourceId of sources) queue.push({ id: sourceId, origin: sourceId });
  const visited = new Set<string>(sources);
  while (queue.length) {
    const { id, origin } = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      if (!spoiledOrigin.has(next)) spoiledOrigin.set(next, origin);
      queue.push({ id: next, origin });
    }
  }
  for (const [spoiledId, origin] of [...spoiledOrigin.entries()].sort(([a], [b]) => compareId(a, b))) {
    putLock(locks, spoiledId, 'variant_spoiled', origin);
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
function sliceByteLength(slice: LearnerEvidenceSliceV1): number {
  return Buffer.byteLength(JSON.stringify(slice), 'utf8');
}
function eventTime(event: LearnerEvidenceEvent): number {
  const parsed = Date.parse(event.occurred_at);
  return Number.isFinite(parsed) ? parsed : 0;
}
function isIsoUtc(value: string): boolean {
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!parts || parts[0] !== value || value.startsWith('0000')) return false;
  const normalized = `${parts[1]}.${(parts[2] ?? '').padEnd(3, '0')}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === normalized;
}
function buildQuestionFamilyLookup(snap: FlowGraphSnapshot | undefined): (questionId: string) => string {
  const parent = new Map<string, string>();
  const findRoot = (id: string): string => {
    let root = parent.get(id) ?? id;
    if (root !== id) root = findRoot(root);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => parent.set(findRoot(left), findRoot(right));
  if (snap) {
    for (const edge of snapVariantEdges(snap)) union(edge.fromId, edge.toId);
    for (const fact of snap.factsById.values()) {
      const data = rec(fact.data);
      if (fact.type === 'content.knowledgeEdge') {
        if (str(data.kind) !== 'variant_of') continue;
        const familyTag = str(rec(data.variant).familyId);
        if (!familyTag) continue;
        const fromId = str(rec(rec(data.from).sourceUse).id);
        const toId = str(rec(rec(data.to).sourceUse).id);
        if (fromId) union(fromId, `family:${familyTag}`);
        if (toId) union(toId, `family:${familyTag}`);
        continue;
      }
      const familyId = str(data.familyId);
      if (familyId) union(fact.id, `family:${familyId}`);
      for (const key of ['variantOf', 'variant_of']) {
        const target = str(data[key]) || str(rec(data[key]).id);
        if (target) union(fact.id, target);
      }
    }
  }
  return (questionId: string): string => parent.has(questionId) ? findRoot(questionId) : questionId;
}
const parseTick = (value: unknown): bigint | null =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
function snapPriorExposures(
  snap: FlowGraphSnapshot | undefined,
): readonly { readonly questionId: string; readonly ms: number | null; readonly tick: bigint | null }[] {
  if (!snap) return [];
  const scope = crisisScopeFromSnap(snap);
  const exposures: { questionId: string; ms: number | null; tick: bigint | null }[] = [];
  const paperFallbackById = new Map<string, Record<string, unknown>>();
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'activity.retentionPosttestSubmission') continue;
    const data = rec(fact.data);
    const pid = str(data.paperId) || str(rec(data.paper).id);
    if (pid && arr(rec(data.paper).questions).length) paperFallbackById.set(pid, rec(data.paper));
  }
  const issuancePaperById = new Map<string, { readonly id: string; readonly data: Record<string, unknown> }>();
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'activity.retentionPosttest') continue;
    const pid = str(rec(rec(fact.data).paper).id);
    if (!pid) continue;
    const direct = snap.factsById.get(pid);
    const directData = direct ? rec(direct.data) : undefined;
    const pData = directData && arr(directData.questions).length ? directData : paperFallbackById.get(pid) ?? directData;
    if (pData) issuancePaperById.set(fact.id, { id: pid, data: pData });
  }
  const resolvePaper = (id: string): { readonly id: string; readonly data: Record<string, unknown> } | undefined => {
    if (!id) return undefined;
    const direct = snap.factsById.get(id);
    const directData = direct ? rec(direct.data) : undefined;
    if (directData && arr(directData.questions).length) return { id, data: directData };
    const viaIssuance = issuancePaperById.get(id);
    if (viaIssuance) return viaIssuance;
    const viaFallback = paperFallbackById.get(id);
    if (viaFallback) return { id, data: viaFallback };
    return directData ? { id, data: directData } : undefined;
  };
  const resolvePaperItem = (paperOrIssuanceId: string, itemId: string): string | undefined => {
    const paper = resolvePaper(paperOrIssuanceId);
    if (!paper) return undefined;
    for (const rawQ of arr(paper.data.questions)) {
      const q = rec(rawQ);
      if (str(q.id) === itemId) return str(rec(q.sourceQuestionRef).id) || `${paper.id}#${itemId}`;
    }
    return undefined;
  };
  for (const fact of snap.factsById.values()) {
    const data = rec(fact.data);
    const tick = parseTick(fact.createdTick);
    if (fact.type === 'activity.workbookAttempt' || fact.type === 'activity.retentionPosttestSubmission') {
      const sessionId = str(data.sessionId);
      const turnId = str(data.turnId) || str(data.studyTurnId);
      if ((sessionId && scope.sessionIds.has(sessionId)) ||
          [fact.id, sessionId, turnId].some(id => id && (scope.turnIds.has(id) || snap.feedbackByTurnId.get(id)?.isCrisis))) continue;
      const occurredAt = str(data.submittedAt) || str(data.occurredAt) || str(data.recordedAt);
      const parsed = occurredAt ? Date.parse(occurredAt) : Number.NaN;
      const ms = Number.isFinite(parsed) ? parsed : null;
      if (ms === null && tick === null) continue;
      const rawPaperId = str(data.paperId) || str(rec(data.paper).id);
      const resolvedPaper = resolvePaper(rawPaperId);
      const paperId = resolvedPaper?.id || rawPaperId;
      const paperData = resolvedPaper && arr(resolvedPaper.data.questions).length ? resolvedPaper.data : rec(data.paper);
      const sourceByItem = new Map<string, string>();
      for (const rawQ of arr(paperData.questions)) {
        const q = rec(rawQ);
        const qItemId = str(q.id);
        const srcId = str(rec(q.sourceQuestionRef).id) || (paperId && qItemId ? `${paperId}#${qItemId}` : '');
        if (qItemId && srcId) sourceByItem.set(qItemId, srcId);
      }
      const feedbackRows = arr(data.feedback);
      const answersRec = rec(data.answers);
      const attachRec = rec(data.questionAttachments);
      const hasItemEvidence = feedbackRows.length > 0 || Object.keys(answersRec).length > 0 || Object.keys(attachRec).length > 0;
      const itemIds = new Set<string>();
      for (const rawRow of feedbackRows) {
        const row = rec(rawRow);
        const itemId = str(row.questionId);
        if (itemId && str(row.result) !== 'unanswered') itemIds.add(itemId);
      }
      for (const [itemId, val] of Object.entries(answersRec)) {
        const answered = typeof val === 'string' ? val.trim().length > 0 : Array.isArray(val) ? val.length > 0 : val !== null && val !== undefined;
        if (itemId && answered) itemIds.add(itemId);
      }
      for (const [itemId, files] of Object.entries(attachRec)) {
        if (itemId && arr(files).length > 0) itemIds.add(itemId);
      }
      if (!itemIds.size && !hasItemEvidence) for (const qItemId of sourceByItem.keys()) itemIds.add(qItemId);
      for (const itemId of itemIds) {
        const questionId = sourceByItem.get(itemId);
        if (questionId) exposures.push({ questionId, ms, tick });
      }
      continue;
    }
    if (fact.type === 'activity.helpExposure') {
      const kind = str(data.kind);
      if (kind === 'prepared' || kind === 'offered' || kind === 'released' || str(data.phase) === 'permit') continue;
      const occurredAt = str(data.occurredAt) || str(data.submittedAt) || str(data.recordedAt) || str(data.displayedAt);
      const parsed = occurredAt ? Date.parse(occurredAt) : Number.NaN;
      const ms = Number.isFinite(parsed) ? parsed : null;
      if (ms === null && tick === null) continue;
      const actIds = [...new Set([
        str(rec(data.mount).activityId), str(rec(data.target).activityId), str(rec(rec(data.answer).target).activityId),
        str(rec(rec(data.mount).issuance).id), str(rec(rec(data.target).issuance).id), str(rec(rec(rec(data.answer).target).issuance).id),
      ].filter(Boolean))];
      const rawItems = new Set<string>();
      for (const candidate of [str(data.itemId), str(rec(rec(data.mount).item).itemId),
        str(rec(rec(data.target).item).itemId), str(rec(rec(rec(data.answer).target).item).itemId)]) {
        if (candidate) rawItems.add(candidate);
      }
      if (!rawItems.size) {
        for (const actId of actIds) {
          const fallbackItem = str(rec(snap.factsById.get(actId)?.data).itemId);
          if (fallbackItem) rawItems.add(fallbackItem);
        }
      }
      const resolvedIds = new Set<string>();
      const resolveFor = (item: string, ids: readonly string[]) => {
        let hit = false;
        for (const id of ids) {
          const mapped = resolvePaperItem(id, item);
          if (mapped) { resolvedIds.add(mapped); hit = true; }
        }
        if (!hit && snap.factsById.has(item)) resolvedIds.add(item);
      };
      for (const rawItem of rawItems) resolveFor(rawItem, actIds);
      for (const rawEntry of arr(data.alsoAppliesTo)) {
        const entry = rec(rawEntry);
        const entryItem = str(entry.itemId);
        if (!entryItem) continue;
        const entryActIds = [...new Set([str(entry.activityId), str(rec(entry.issuance).id)].filter(Boolean))];
        resolveFor(entryItem, entryActIds.length ? entryActIds : actIds);
      }
      if (!resolvedIds.size) {
        const contentId = str(rec(data.content).id);
        if (contentId && snap.factsById.has(contentId)) resolvedIds.add(contentId);
      }
      for (const questionId of resolvedIds) exposures.push({ questionId, ms, tick });
      continue;
    }
    if (fact.type === 'activity.recallSubmission') {
      const occurredAt = str(data.occurredAt) || str(data.submittedAt) || str(data.recordedAt);
      const parsed = occurredAt ? Date.parse(occurredAt) : Number.NaN;
      const ms = Number.isFinite(parsed) ? parsed : null;
      if (ms === null && tick === null) continue;
      const rawItem = str(data.itemId);
      const issuanceId = str(rec(data.issuance).id);
      const resolved = (issuanceId && rawItem ? resolvePaperItem(issuanceId, rawItem) : undefined) || rawItem;
      if (resolved) exposures.push({ questionId: resolved, ms, tick });
    }
  }
  return exposures;
}
/**
 * Assign chronological `item_novelty` (`transfer` -> `isomorphic` -> `same`)
 * over strictly earlier rows plus any prior authorized exposures in `snap`
 * (using UTC timestamps when present and kernel `createdTick` / `recordedTick`
 * for tick-ordered facts such as help exposures and recall submissions).
 */
export function assignSelectionEventNovelty(
  rows: readonly { readonly questionId: string; readonly occurredAt: string; readonly recordedTick?: string }[],
  snap?: FlowGraphSnapshot,
): readonly ('same' | 'isomorphic' | 'transfer')[] {
  const familyOf = buildQuestionFamilyLookup(snap);
  const priorExposures = snapPriorExposures(snap);
  const parsedRows = rows.map((row, index) => {
    const parsed = Date.parse(row.occurredAt);
    return {
      questionId: row.questionId,
      family: familyOf(row.questionId),
      ms: Number.isFinite(parsed) ? parsed : null,
      tick: parseTick(row.recordedTick),
      index,
    };
  });
  const sorted = [...parsedRows].sort((left, right) => ((left.ms ?? 0) - (right.ms ?? 0)) || (left.index - right.index));
  const novelties = new Array<'same' | 'isomorphic' | 'transfer'>(rows.length).fill('transfer');
  const seenQuestions = new Set<string>();
  const seenFamilies = new Set<string>();
  let cursor = 0;
  while (cursor < sorted.length) {
    const groupEnd = sorted.findIndex((row, i) => i > cursor && (row.ms ?? 0) !== (sorted[cursor]!.ms ?? 0));
    const end = groupEnd === -1 ? sorted.length : groupEnd;
    for (const row of sorted.slice(cursor, end)) {
      let seenSame = seenQuestions.has(row.questionId);
      let seenFamily = seenSame || seenFamilies.has(row.family);
      if (!seenSame) {
        for (const exp of priorExposures) {
          const earlier = exp.ms !== null && row.ms !== null ? exp.ms < row.ms
            : exp.tick !== null && row.tick !== null ? exp.tick < row.tick : false;
          if (!earlier) continue;
          if (exp.questionId === row.questionId) { seenSame = true; break; }
          if (!seenFamily && familyOf(exp.questionId) === row.family) seenFamily = true;
        }
      }
      novelties[row.index] = seenSame ? 'same' : seenFamily ? 'isomorphic' : 'transfer';
    }
    for (const row of sorted.slice(cursor, end)) {
      seenQuestions.add(row.questionId);
      seenFamilies.add(row.family);
    }
    cursor = end;
  }
  return novelties;
}
function deriveEventsFromSnap(
  snap: FlowGraphSnapshot | undefined,
  asOfAt: string,
): { readonly events: readonly LearnerEvidenceEvent[]; readonly omissions: readonly SliceOmission[] } {
  if (!snap) return { events: [], omissions: [] };
  const asOfMs = Date.parse(asOfAt);
  const conceptEdges = snapConceptEdges(snap);
  const conceptsByQuestion = new Map<string, string[]>();
  for (const edge of conceptEdges) {
    const held = conceptsByQuestion.get(edge.questionId) ?? [];
    held.push(edge.conceptId);
    conceptsByQuestion.set(edge.questionId, held);
  }
  const events: LearnerEvidenceEvent[] = [];
  const omissions: SliceOmission[] = [];
  const omittedKeys = new Set<string>();
  const validStages = new Set(['reading', 'modeling', 'strategy', 'execution', 'expression']);
  const validHelp = new Set(['independent', 'hinted', 'hint_l1', 'hint_l2', 'solution_seen']);
  // Novelty is computed over strictly earlier rows, so simultaneous items of
  // one submission never count each other as prior exposure.
  const rows: {
    fact: RawFlowFactId; itemId: string; questionId: string; conceptIds: readonly string[];
    occurredAt: string; occurredMs: number; helpRaw: string | null; verdict: string; stageRaw: string;
    scoreNorm: number | null; factRev: number; criteria?: readonly CriterionObservationV2[];
  }[] = [];
  type RawFlowFactId = { readonly id: string; readonly createdTick?: string };
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'activity.workbookAttempt') continue;
    const data = rec(fact.data);
    // Crisis turns, including every turn sharing the crisis session, never enter events.
    const scope = crisisScopeFromSnap(snap);
    const sessionId = str(data.sessionId);
    const turnId = str(data.turnId) || str(data.studyTurnId);
    if ((sessionId && scope.sessionIds.has(sessionId)) ||
        [fact.id, sessionId, turnId].some(id => id && (scope.turnIds.has(id) || snap.feedbackByTurnId.get(id)?.isCrisis))) continue;
    const occurredAt = str(data.submittedAt) || str(data.occurredAt) || str(data.recordedAt);
    const occurredMs = Date.parse(occurredAt);
    if (!occurredAt || !isIsoUtc(occurredAt) || !Number.isFinite(occurredMs) || (Number.isFinite(asOfMs) && occurredMs > asOfMs)) continue;
    const paperId = str(data.paperId);
    const paper = paperId ? snap.factsById.get(paperId) : undefined;
    const paperData = rec(paper?.data ?? data.paper);
    const sourceByItem = new Map<string, string>();
    for (const rawQ of arr(paperData.questions)) {
      const q = rec(rawQ);
      const qItemId = str(q.id);
      const srcId = str(rec(q.sourceQuestionRef).id);
      if (qItemId && srcId) sourceByItem.set(qItemId, srcId);
    }
    const releaseCriteriaByItem = new Map<string, Parameters<typeof formalItemCriteriaV2>[1]>();
    for (const rawReleaseItem of arr(rec(paperData.assessmentRelease).items)) {
      const item = rec(rawReleaseItem);
      const rItemId = str(item.itemId);
      if (!rItemId) continue;
      const parsed = arr(item.criteria).map(rawCrit => {
        const c = rec(rawCrit);
        const evalRec = rec(c.evaluator);
        const inter = str(c.interaction);
        return {
          criterionId: str(c.criterionId),
          maximum: c.maximum === null ? null : finite(c.maximum),
          inputs: arr(c.inputs).map(rec)
            .filter(i => str(i.slotId) && typeof i.path === 'string')
            .map(i => ({ slotId: str(i.slotId), path: i.path as string })),
          evaluator: { id: str(evalRec.id) || 'workbook-formal-assessment', version: str(evalRec.version) || '1' },
          ...(arr(c.kcLinks).length ? {
            kcLinks: arr(c.kcLinks).map(rec).filter(l => str(l.kcId) && finite(l.weight) !== null).map(l => ({
              kcId: str(l.kcId),
              weight: finite(l.weight)!,
              role: (str(l.role) === 'prerequisite' ? 'prerequisite' : 'target') as 'target' | 'prerequisite',
              source: (str(l.source) === 'authored' || str(l.source) === 'verified_edge'
                ? str(l.source) : 'question_fallback') as 'authored' | 'verified_edge' | 'question_fallback',
            })),
          } : {}),
          ...(inter === 'conjunctive' || inter === 'compensatory' ? { interaction: inter as 'conjunctive' | 'compensatory' } : {}),
        };
      }).filter(c => c.criterionId);
      if (parsed.length) releaseCriteriaByItem.set(rItemId, parsed);
    }
    for (const rawRow of arr(data.feedback)) {
      const row = rec(rawRow);
      const itemId = str(row.questionId);
      const questionId = itemId ? sourceByItem.get(itemId) : undefined;
      if (!itemId || !questionId) continue;
      const assessment = snap.assessmentsByKey.get(`${fact.id}:${itemId}`);
      const formal = assessment?.criteria?.length
        ? formalItemCriteriaV2(assessment.criteria, releaseCriteriaByItem.get(itemId))
        : undefined;
      const criterionKcs = formal ? formal.criteria.flatMap(c => c.kc_links.map(l => l.kc_id)) : [];
      const conceptIds = uniqueSorted([...(conceptsByQuestion.get(questionId) ?? []), ...criterionKcs]);
      const helpRaw = str(row.helpLevel) || str(data.helpLevel);
      if (!validHelp.has(helpRaw)) {
        if (conceptIds.length) {
          const key = `${fact.id}:${fact.rev}:${itemId}`;
          if (!omittedKeys.has(key)) {
            omittedKeys.add(key);
            omissions.push({ ref: { id: fact.id, rev: fact.rev }, item_id: itemId, reason: 'unwitnessed-independence' });
          }
        }
        // Unwitnessed attempts cannot contribute to mastery scoring, but they
        // still expose the learner to the question and its variant family.
        rows.push({
          fact, itemId, questionId, conceptIds, occurredAt, occurredMs, helpRaw: null, factRev: fact.rev,
          verdict: '', stageRaw: '', scoreNorm: null,
        });
        continue;
      }
      if (!conceptIds.length) {
        // Unmapped-KC attempts cannot score mastery, but they still establish
        // prior exposure for the question and its variant family.
        rows.push({
          fact, itemId, questionId, conceptIds, occurredAt, occurredMs, helpRaw: null, factRev: fact.rev,
          verdict: '', stageRaw: '', scoreNorm: null,
        });
        continue;
      }
      if (assessment?.hasFormalOutcomes && formal) {
        rows.push({
          fact, itemId, questionId, conceptIds, occurredAt, occurredMs, helpRaw, factRev: fact.rev,
          verdict: formal.outcome,
          stageRaw: formal.errorStage ?? '',
          scoreNorm: formal.scoreNorm,
          criteria: formal.criteria,
        });
        continue;
      }
      const assessmentVerdict = str(assessment?.verdict);
      const rowVerdict = str(row.result);
      const scoreNorm = scoreNormOf(assessment?.scoreText, row, Boolean(assessmentVerdict) && assessmentVerdict !== rowVerdict);
      rows.push({
        fact, itemId, questionId, conceptIds, occurredAt, occurredMs, helpRaw, factRev: fact.rev,
        verdict: assessmentVerdict || rowVerdict,
        stageRaw: str(assessment?.errorStage) || str(row.errorStage),
        scoreNorm,
      });
    }
  }
  rows.sort((left, right) => (left.occurredMs - right.occurredMs) ||
    compareId(left.fact.id, right.fact.id) || compareId(left.itemId, right.itemId));
  const novelties = assignSelectionEventNovelty(
    rows.map(row => ({ questionId: row.questionId, occurredAt: row.occurredAt, ...(row.fact.createdTick ? { recordedTick: row.fact.createdTick } : {}) })),
    snap,
  );
  rows.forEach((row, index) => {
    if (row.helpRaw === null || !row.conceptIds.length) return;
    const outcome: LearnerEvidenceEvent['outcome'] = row.verdict === 'correct' ? 'correct'
      : row.verdict === 'incorrect' ? 'incorrect'
      : row.verdict === 'partial' ? 'partial' : 'unknown';
    const criteria = row.criteria?.length ? row.criteria : undefined;
    events.push({
      // Unique per submission item: repeated attempts at one source question are distinct
      // observations, so the deriver never hits conflicting duplicate refs.
      ref: `${row.fact.id}#${row.itemId}`,
      rev: row.factRev,
      fact_ref: { id: row.fact.id, rev: row.factRev },
      item_id: row.itemId,
      occurred_at: row.occurredAt,
      concept_ids: row.conceptIds,
      item_novelty: novelties[index]!,
      help_level: row.helpRaw as Exclude<EvidenceEventV1['help_level'], 'unknown'>,
      outcome,
      claim_ids: [],
      ...(row.scoreNorm !== null ? { score_norm: row.scoreNorm } : {}),
      ...((outcome === 'incorrect' || outcome === 'partial') && validStages.has(row.stageRaw)
        ? { error_stage: row.stageRaw as NonNullable<EvidenceEventV1['error_stage']> } : {}),
      ...(criteria ? { criteria } : {}),
      attribution_status: eventAttributionStatus({ concept_ids: row.conceptIds, ...(criteria ? { criteria } : {}) }),
    });
  });
  events.sort((a, b) => (Date.parse(a.occurred_at) - Date.parse(b.occurred_at)) || compareId(a.ref, b.ref));
  return { events, omissions };
}
function scoreNormOf(scoreText: string | undefined, row: Record<string, unknown>, assessmentOverridesVerdict: boolean): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)$/.exec((scoreText ?? '').trim());
  if (match) {
    const parsedEarned = Number(match[1]);
    const parsedMaximum = Number(match[2]);
    if (parsedMaximum > 0 && parsedEarned >= 0 && parsedEarned <= parsedMaximum) return parsedEarned / parsedMaximum;
  }
  if (assessmentOverridesVerdict) return null;
  const direct = finite(row.scoreNorm) ?? finite(row.score_norm) ?? finite(row.proportion);
  if (direct !== null && direct >= 0 && direct <= 1) return direct;
  const earned = finite(row.earned);
  const maximum = finite(row.maximum);
  if (earned !== null && maximum !== null && maximum > 0 && earned >= 0 && earned <= maximum) return earned / maximum;
  return null;
}
/** Build a schema-tight canonical evidence slice, with deterministic byte-budget truncation. */
export function buildSelectionEvidenceSlice(input: BuildSelectionSliceInput): BuildSelectionSliceResult {
  const derived = input.events === undefined ? deriveEventsFromSnap(input.snap, input.asOfAt) : undefined;
  const rawEvents = input.events ?? derived?.events ?? [];
  const omissions = [...(input.omissions ?? []), ...(derived?.omissions ?? [])];
  const scope = input.snap ? crisisScopeFromSnap(input.snap) : undefined;
  const eventIsCrisis = (ref: string): boolean => {
    if (!input.snap) return false;
    if (input.snap.feedbackByTurnId.get(ref)?.isCrisis || scope?.turnIds.has(ref) || scope?.sessionIds.has(ref)) return true;
    // Submission refs `${attemptId}#${itemId}` trace back to the owning attempt/session.
    const base = ref.split('#')[0] ?? '';
    if (base !== ref && (input.snap.feedbackByTurnId.get(base)?.isCrisis || scope?.turnIds.has(base) || scope?.sessionIds.has(base))) return true;
    const attemptFact = input.snap.factsById.get(base);
    if (attemptFact?.type === 'activity.workbookAttempt') {
      const attemptData = rec(attemptFact.data);
      const sessionId = str(attemptData.sessionId);
      const turnId = str(attemptData.turnId) || str(attemptData.studyTurnId);
      if ((sessionId && scope?.sessionIds.has(sessionId)) ||
          [sessionId, turnId].some(id => id && (scope?.turnIds.has(id) || input.snap?.feedbackByTurnId.get(id)?.isCrisis))) return true;
    }
    return false;
  };
  const crisisFiltered = rawEvents.filter(event => !eventIsCrisis(event.ref));
  const locks = uniqueSorted(lockIdsFrom(input.exposureLocks).map(str));
  // Negative or non-finite budgets are meaningless constraints; they degrade to null rather than blocking everything.
  const budgetMin = typeof input.budgetMin === 'number' && Number.isFinite(input.budgetMin) && input.budgetMin >= 0 ? input.budgetMin : null;
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
  const build = (events: readonly LearnerEvidenceEvent[], poolRows: typeof selectedPool): LearnerEvidenceSliceV1 => ({
    clock_watermark: input.clockWatermark,
    as_of_at: input.asOfAt,
    events,
    ...(omissions.length ? { omissions } : {}),
    constraints: {
      budget_min: budgetMin,
      locks,
      deadlines: input.deadlines ?? [],
    },
    candidate_pool: poolRows.map(({ candidate, conceptIds }) => ({
      ref: candidate.id,
      concept_ids: conceptIds,
      item_novelty: candidate.novelty,
      est_min: Number.isFinite(candidate.estMin) ? Math.max(0.1, candidate.estMin) : 5,
      ...(candidate.representation ? { representation: candidate.representation } : {}),
      ...(candidate.context ? { context: candidate.context } : {}),
      ...(candidate.method ? { method: candidate.method } : {}),
    })),
  });
  // Events are always emitted ascending by occurred_at; truncation drops the oldest first.
  const ascending = [...crisisFiltered].sort((left, right) => eventTime(left) - eventTime(right) || compareId(left.ref, right.ref));
  let events = ascending;
  let slice = build(events, selectedPool);
  if (sliceByteLength(slice) > maxInputBytes && events.length > 0) {
    // Binary-search the minimum number of oldest events to drop, keeping the remaining order.
    let low = 0;
    let high = events.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (sliceByteLength(build(events.slice(mid), selectedPool)) <= maxInputBytes) high = mid;
      else low = mid + 1;
    }
    events = events.slice(low);
    slice = build(events, selectedPool);
  }
  // Only when even an empty event history overflows do we shed the weakest-ranked candidates,
  // always keeping at least one candidate so the pool never silently goes empty.
  if (sliceByteLength(slice) > maxInputBytes) {
    while (selectedPool.length > 1 && sliceByteLength(slice) > maxInputBytes) {
      const removed = selectedPool[selectedPool.length - 1]!;
      truncated.add(removed.candidate.id);
      selectedPool = selectedPool.slice(0, -1);
    }
    slice = build(events, selectedPool);
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
const STAGE_CANONICAL: Readonly<Record<string, string>> = {
  reading: 'reading', comprehension: 'reading', modeling: 'modeling', strategy: 'strategy',
  execution: 'execution', expression: 'expression',
};
function canonicalStage(value: string): string {
  return STAGE_CANONICAL[value.trim().toLowerCase()] ?? value.trim().toLowerCase();
}
/** Map each error stage to the concepts actually observed failing at that stage. */
function errorStageWeakConcepts(snap: FlowGraphSnapshot | undefined): ReadonlyMap<string, ReadonlySet<string>> {
  const byStage = new Map<string, Set<string>>();
  const add = (stage: string, conceptId: string) => {
    const key = canonicalStage(stage);
    if (!key || !conceptId) return;
    const held = byStage.get(key) ?? new Set<string>();
    held.add(conceptId);
    byStage.set(key, held);
  };
  if (!snap) return byStage;
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'companion.memoryAssertion') continue;
    const data = rec(fact.data);
    const stages = new Set<string>();
    if (str(data.errorStage)) stages.add(str(data.errorStage));
    for (const entry of arr(data.evidence)) {
      if (str(rec(entry).errorStage)) stages.add(str(rec(entry).errorStage));
    }
    if (!stages.size) continue;
    for (const stage of stages) {
      for (const link of arr(data.links)) {
        const id = str(rec(link).id);
        if (id) add(stage, id);
      }
    }
  }
  // Assessments carry the exact failing stage per attempt item; resolve the item's source
  // question through its paper, then to the concepts that question targets.
  const conceptsByQuestion = new Map<string, string[]>();
  for (const edge of snapConceptEdges(snap)) {
    const held = conceptsByQuestion.get(edge.questionId) ?? [];
    held.push(edge.conceptId);
    conceptsByQuestion.set(edge.questionId, held);
  }
  for (const [key, assessment] of snap.assessmentsByKey) {
    const [attemptId, itemId] = key.split(':');
    const attempt = attemptId ? snap.factsById.get(attemptId) : undefined;
    if (!attempt || attempt.type !== 'activity.workbookAttempt') continue;
    if (assessment.projectedCriteria?.some(c => c.kc_links.some(link => link.weight > 0))) {
      for (const c of assessment.projectedCriteria) {
        if ((c.outcome !== 'incorrect' && c.outcome !== 'partial') || !c.error_stage) continue;
        for (const link of c.kc_links) if (link.weight > 0 && link.kc_id && snap.factsById.has(link.kc_id)) add(c.error_stage, link.kc_id);
      }
      continue;
    }
    const stage = assessment.errorStage ? str(assessment.errorStage) : '';
    if (!stage) continue;
    const attemptData = rec(attempt.data);
    const paper = snap.factsById.get(str(attemptData.paperId));
    const questionRows = [...arr(rec(paper?.data).questions), ...arr(rec(attemptData.paper).questions)];
    for (const rawQ of questionRows) {
      const q = rec(rawQ);
      if (str(q.id) !== itemId) continue;
      const sourceQuestionId = str(rec(q.sourceQuestionRef).id);
      if (!sourceQuestionId) continue;
      for (const conceptId of conceptsByQuestion.get(sourceQuestionId) ?? []) add(stage, conceptId);
    }
  }
  return byStage;
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
  const weakConceptsByStage = errorStageWeakConcepts(input.snap);
  const errorFocus = new Set((input.request.errorStageFocus ?? []).map(str).filter(Boolean).map(canonicalStage));
  const focusedWeakConcepts = new Set<string>();
  for (const stage of errorFocus) {
    for (const id of weakConceptsByStage.get(stage) ?? []) focusedWeakConcepts.add(id);
  }
  const eliminated: EliminatedQuestionPlanItem[] = [];
  const eliminatedIds = new Set<string>();
  const budgetShortfalls = new Set<string>();
  const pushEliminated = (candidate: RecalledSelectionCandidate, reasonCode: EliminatedQuestionPlanItem['reasonCode'],
      reasonLabel: string, detail: string, exposedBy?: string) => {
    if (eliminatedIds.has(candidate.id)) return;
    eliminatedIds.add(candidate.id);
    eliminated.push({
      id: candidate.id,
      rev: candidate.rev,
      title: candidate.title,
      reasonCode,
      reasonLabel,
      detail,
      estMin: candidate.estMin,
      ...(infoGainOk ? { infoGain: ranked.get(candidate.id)?.info_gain ?? null } : {}),
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
    errorFocus.size > 0 && candidate.conceptIds.some(id => focusedWeakConcepts.has(id)) ? 0.18 : 0;
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
    // Unranked candidates never fake zero information gain: fall back to semantic evidence instead.
    const reasonCode = infoGainOk ? (rank?.reason_code ?? 'semantic-fallback') : 'semantic-fallback';
    const itemScore = round(dynamicValueOf(candidate));
    selected.push({
      id: candidate.id,
      ref: candidate.id,
      rev: candidate.rev,
      title: candidate.title,
      prompt: candidate.prompt,
      estMin: candidate.estMin,
      infoGain: infoGainOk ? rank?.info_gain ?? null : null,
      reasonCode,
      reasonLabel: infoGainOk
        ? reasonCode === 'probe-unknown' ? '探测未知能力边界'
          : reasonCode === 'reduce-uncertainty' ? '降低当前掌握不确定性'
          : '未进入信息增益排名，按语义匹配纳入'
        : '语义与图谱覆盖优先（信息增益引擎暂不可用）',
      uncertainty: infoGainOk ? rank?.uncertainty ?? null : null,
      coveredConcepts: candidate.conceptIds,
      conceptIds: candidate.conceptIds,
      novelty: candidate.novelty,
      score: itemScore,
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
      const ids = covering.map(item => item.id);
      coverageReport.push({
        target: target.target,
        ...(target.kind === 'concept' ? { conceptId: target.target } : {}),
        kind: target.kind,
        label: target.label,
        status,
        statusLabel: high ? '已覆盖（高信息增益）' : '已覆盖（待补强证据）',
        matchedQuestionIds: ids,
        selectedQuestionIds: ids,
        detail: high ? '已选题能够以较高信息增益检验该目标。' : '已选题覆盖该目标，但证据强度或增益仍待补强。',
      });
      continue;
    }
    if (!relevant.length) {
      coverageReport.push({
        target: target.target,
        ...(target.kind === 'concept' ? { conceptId: target.target } : {}),
        kind: target.kind,
        label: target.label,
        status: 'uncovered_no_question',
        statusLabel: '题库暂无对应题，建议补缺',
        matchedQuestionIds: [],
        selectedQuestionIds: [],
        detail: '题库中暂无可用于该目标的候选题。',
      });
      gaps.push({
        kind: 'zero_question_concept',
        detail: `目标「${target.label}」没有可召回候选题。`,
        target: target.target,
        ...(target.kind === 'concept' ? { conceptId: target.target } : {}),
        suggestedAction: 'author_concept_gap',
      });
      continue;
    }
    const allLocked = relevant.every(candidate => lockById.has(candidate.id));
    const allEliminated = relevant.every(candidate => eliminatedIds.has(candidate.id));
    coverageReport.push({
      target: target.target,
      ...(target.kind === 'concept' ? { conceptId: target.target } : {}),
      kind: target.kind,
      label: target.label,
      status: allLocked ? 'uncovered_all_exposed' : 'uncovered_no_question',
      statusLabel: allLocked ? '题库均已曝光，建议出变式'
        : allEliminated ? '有候选但受预算或增益约束未纳入'
        : '题库暂无对应题，建议补缺',
      matchedQuestionIds: allLocked ? [] : relevant.map(candidate => candidate.id).slice(0, 8),
      selectedQuestionIds: [],
      detail: allLocked ? '现有相关题均已作答、复测或看过解析，无法独立检验。'
        : allEliminated ? '存在相关候选题，但受时长预算、名额或增益排序约束未纳入本次选排，并非题库缺口。'
        : '相关候选未能在预算与名额内形成有效覆盖。',
    });
    if (allLocked) {
      gaps.push({
        kind: 'all_exposed_need_variant',
        detail: `目标「${target.label}」的相关题均已曝光，需要生成安全变式。`,
        target: target.target,
        ...(target.kind === 'concept' ? { conceptId: target.target } : {}),
        suggestedAction: 'author_mistake_variant',
      });
    }
  }
  for (const stage of errorFocus) {
    const stageWeak = [...(weakConceptsByStage.get(stage) ?? [])];
    const concepts = stageWeak.filter(id => candidates.some(candidate => candidate.conceptIds.includes(id)));
    const addressed = concepts.some(id => coveredConcepts.has(id));
    // A stage-specific gap is only real when evidence actually ties weak concepts to that stage.
    if (stageWeak.length > 0 && !addressed) {
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
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const EXPOSED_ELIMINATION_REASONS = new Set<EliminatedQuestionPlanItem['reasonCode']>(['exposed_attempted', 'exposed_posttest', 'exposed_help', 'variant_spoiled']);
/** Re-filter a persisted selection plan against the current authorized snapshot before returning it. */
export function sanitizeSelectionPlan(
  plan: QuestionSelectionPlan,
  snap: FlowGraphSnapshot,
  authorizedSelectedIds?: ReadonlySet<string>,
  authorizedQuestionIds?: ReadonlySet<string>,
): QuestionSelectionPlan {
  const graphConceptIds = new Map<string, Set<string>>();
  for (const edge of snapConceptEdges(snap)) {
    const held = graphConceptIds.get(edge.questionId) ?? new Set<string>();
    held.add(edge.conceptId);
    graphConceptIds.set(edge.questionId, held);
  }
  const isAuthorizedQuestion = (id: string) =>
    authorizedQuestionIds ? authorizedQuestionIds.has(id) || (authorizedSelectedIds?.has(id) ?? false) : snap.factsById.has(id);
  const isAuthorizedRef = (id: string) => {
    const fact = snap.factsById.get(id);
    if (!fact) return false;
    return fact.type === 'content.asset' && str(rec(fact.data).kind) === 'question' ? isAuthorizedQuestion(id) : true;
  };
  const allowedConcepts = (qId: string, ids: readonly string[]) =>
    ids.filter(c => snap.factsById.has(c) && (graphConceptIds.get(qId)?.has(c) ?? false));
  const selected = plan.selected
    .filter(item => authorizedSelectedIds ? authorizedSelectedIds.has(item.id) : isAuthorizedQuestion(item.id))
    .map(item => ({
      ...item,
      conceptIds: allowedConcepts(item.id, item.conceptIds),
      coveredConcepts: allowedConcepts(item.id, item.coveredConcepts),
    }));
  const selectedById = new Map(selected.map(item => [item.id, item]));
  const eliminated = plan.eliminated
    .filter(item => isAuthorizedQuestion(item.id))
    .map(item => {
      const conceptIds = allowedConcepts(item.id, item.conceptIds);
      if (item.exposedBy && !isAuthorizedRef(item.exposedBy)) {
        const { exposedBy, ...rest } = item;
        const detail = rest.detail.includes(exposedBy)
          ? rest.detail.replaceAll(exposedBy, '').replace(/\s{2,}/g, ' ').trim()
          : rest.detail;
        return { ...rest, detail, conceptIds };
      }
      return { ...item, conceptIds };
    });
  const gaps: SelectionGap[] = plan.gaps.filter(gap => {
    if (gap.kind === 'budget_shortfall') return Boolean(gap.target && isAuthorizedQuestion(gap.target));
    return (!gap.conceptId || snap.factsById.has(gap.conceptId)) &&
      (!gap.target || !ULID_RE.test(gap.target) || isAuthorizedRef(gap.target));
  });
  const gapKey = (kind: SelectionGapKind, target?: string) => `${kind}:${target ?? ''}`;
  const seenGaps = new Set(gaps.map(gap => gapKey(gap.kind, gap.conceptId ?? gap.target)));
  const hasRemainingExposed = (entry: SelectionCoverageReportEntry, targetConcept: string) =>
    eliminated.some(e => EXPOSED_ELIMINATION_REASONS.has(e.reasonCode) && (
      entry.kind === 'concept'
        ? e.conceptIds.includes(targetConcept)
        : tokenIncludes(normalize(e.title), normalize(entry.target)) ||
          e.conceptIds.some(c => tokenIncludes(normalize(conceptTitle(snap, c)), normalize(entry.target)))
    ));
  const downgradedExposedTargets = new Set<string>();
  const coverageReport = plan.coverageReport
    .filter(entry => entry.kind !== 'concept' || snap.factsById.has(entry.conceptId ?? entry.target))
    .map(entry => {
      const targetConcept = entry.conceptId ?? entry.target;
      const matchedQuestionIds = entry.matchedQuestionIds.filter(qId =>
        isAuthorizedQuestion(qId) && (entry.kind !== 'concept' || (graphConceptIds.get(qId)?.has(targetConcept) ?? false)));
      const selectedQuestionIds = entry.selectedQuestionIds.filter(qId =>
        selectedById.has(qId) && (entry.kind !== 'concept' || selectedById.get(qId)!.conceptIds.includes(targetConcept)));
      if (selectedQuestionIds.length > 0) {
        const high = plan.deriverStatus.kind === 'ok' && selectedQuestionIds.some(qId => (selectedById.get(qId)?.infoGain ?? 0) >= 0.25);
        return {
          ...entry,
          status: (high ? 'covered_high_gain' : 'covered_low_evidence') as SelectionCoverageStatus,
          statusLabel: high ? '已覆盖（高信息增益）' : '已覆盖（待补强证据）',
          matchedQuestionIds,
          selectedQuestionIds,
          detail: high ? '已选题能够以较高信息增益检验该目标。' : '已选题覆盖该目标，但证据强度或增益仍待补强。',
        };
      }
      if (entry.status === 'uncovered_all_exposed' && !hasRemainingExposed(entry, targetConcept)) {
        const targetKey = entry.kind === 'concept' ? targetConcept : entry.target;
        downgradedExposedTargets.add(targetKey);
        const key = gapKey('zero_question_concept', targetKey);
        if (!seenGaps.has(key)) {
          seenGaps.add(key);
          gaps.push({
            kind: 'zero_question_concept',
            detail: `目标「${entry.label}」没有可召回候选题。`,
            target: entry.target,
            ...(entry.kind === 'concept' ? { conceptId: targetConcept } : {}),
            suggestedAction: 'author_concept_gap',
          });
        }
        return {
          ...entry,
          status: 'uncovered_no_question' as SelectionCoverageStatus,
          statusLabel: '题库暂无对应题，建议补缺',
          matchedQuestionIds: [],
          selectedQuestionIds: [],
          detail: '题库中暂无可用于该目标的候选题。',
        };
      }
      const lostCoverage = entry.status === 'covered_high_gain' || entry.status === 'covered_low_evidence';
      const lostMatches = entry.status === 'uncovered_no_question' && entry.matchedQuestionIds.length > 0 && matchedQuestionIds.length === 0;
      if (lostCoverage || lostMatches) {
        const key = gapKey('zero_question_concept', entry.kind === 'concept' ? targetConcept : entry.target);
        if (!seenGaps.has(key)) {
          seenGaps.add(key);
          gaps.push({
            kind: 'zero_question_concept',
            detail: `目标「${entry.label}」原覆盖题已不可用，当前提案未覆盖该目标。`,
            target: entry.target,
            ...(entry.kind === 'concept' ? { conceptId: targetConcept } : {}),
            suggestedAction: 'author_concept_gap',
          });
        }
        return {
          ...entry,
          status: 'uncovered_no_question' as SelectionCoverageStatus,
          statusLabel: matchedQuestionIds.length ? '有候选但受预算或增益约束未纳入' : '题库暂无对应题，建议补缺',
          matchedQuestionIds,
          selectedQuestionIds,
          detail: matchedQuestionIds.length ? '原已选题不再可用，当前提案尚未覆盖该目标。' : '原覆盖题不再可用，当前提案已无法覆盖该目标。',
        };
      }
      return { ...entry, matchedQuestionIds, selectedQuestionIds };
    });
  const finalGaps = gaps.filter(gap =>
    gap.kind !== 'all_exposed_need_variant' ||
    (!downgradedExposedTargets.has(gap.conceptId ?? gap.target ?? '') &&
      eliminated.some(e => EXPOSED_ELIMINATION_REASONS.has(e.reasonCode) && (!gap.conceptId || e.conceptIds.includes(gap.conceptId)))));
  return {
    ...plan,
    selected,
    eliminated,
    estimatedMinutes: selected.reduce((sum, item) => sum + item.estMin, 0),
    coverageReport,
    gaps: finalGaps,
  };
}
