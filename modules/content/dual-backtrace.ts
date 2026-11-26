import type { DualBacktraceEntryWire, DualBacktraceResultWire, FactId, Revision } from '@mangekyo/kernel';
import { addSetValue, compareText, purposeAllowed } from './content-guard.ts';

export type DualBacktraceHelpExposure =
  | 'none' | 'unexposed' | 'hint' | 'solution_seen' | 'worked_example' | 'assisted' | 'unknown';
export type DualBacktraceIndependentHelpExposure = 'none' | 'unexposed';
export type DualBacktraceAttemptInput = {
  readonly attemptId: FactId; readonly attemptRev?: Revision;
  readonly questionId: FactId; readonly questionRev?: Revision;
  readonly questionTitle?: string; readonly questionPrompt?: string;
  readonly verdict: 'correct' | 'partial' | 'incorrect'; readonly helpExposure: DualBacktraceHelpExposure;
  readonly independent?: boolean; readonly errorStage?: string | null; readonly errorSummary?: string | null;
  readonly learnerAnswer?: string; readonly learnerQuote?: string;
  readonly durationMs?: number; readonly submittedAt?: string;
  readonly chapterId?: FactId; readonly chapterTitle?: string; readonly textbookPageId?: FactId;
  readonly conceptIds?: readonly FactId[]; readonly archetypeIds?: readonly FactId[];
  readonly sourceImageRef?: string; readonly purpose?: readonly string[]; readonly retracted?: boolean;
};
export type DualBacktraceEdgeInput = {
  readonly kind: 'targets_concept' | 'variant_of' | 'instance_of' | 'canonical_archetype' | 'maps_to_chapter' | 'explains';
  readonly fromId: FactId; readonly toId: FactId; readonly retracted?: boolean;
};
export type DualBacktraceTarget = {
  readonly questionId?: FactId; readonly conceptIds?: readonly FactId[]; readonly archetypeIds?: readonly FactId[];
  readonly errorStage?: string | null; readonly chapterId?: FactId; readonly excludeAttemptId?: FactId;
};
export type DualBacktraceMistakeMatchBasis = 'error_stage' | 'concept' | 'archetype' | 'variant_family' | 'same_question';
export type DualBacktraceSuccessMatchBasis = 'concept' | 'archetype' | 'variant_family' | 'same_question';
export type DualBacktraceEvidence<Help extends DualBacktraceHelpExposure = DualBacktraceHelpExposure> = {
  readonly attemptId: FactId; readonly attemptRev?: Revision;
  readonly questionId: FactId; readonly questionRev?: Revision; readonly questionTitle?: string;
  readonly learnerAnswer?: string; readonly learnerQuote?: string; readonly helpExposure: Help;
  readonly submittedAt?: string; readonly durationMs?: number;
  readonly chapterId?: FactId; readonly chapterTitle?: string;
  readonly textbookPageId?: FactId; readonly sourceImageRef?: string; readonly provenance: 'learner_evidence';
};
type DualBacktraceInferenceWire = Omit<DualBacktraceEntryWire['inference'], 'matchBasis'>;
export type DualBacktraceSimilarMistake = Omit<DualBacktraceEntryWire, 'evidence' | 'inference'> & {
  readonly evidence: DualBacktraceEvidence<DualBacktraceHelpExposure>;
  readonly inference: DualBacktraceInferenceWire & {
    readonly errorStage: string | null; readonly mechanismSummary: string;
    readonly matchBasis: readonly DualBacktraceMistakeMatchBasis[];
  };
};
export type DualBacktraceIndependentSuccess = Omit<DualBacktraceEntryWire, 'evidence' | 'inference'> & {
  readonly evidence: DualBacktraceEvidence<DualBacktraceIndependentHelpExposure>;
  readonly inference: DualBacktraceInferenceWire & {
    readonly transferBridge: string; readonly matchBasis: readonly DualBacktraceSuccessMatchBasis[];
  };
};
export type BuildDualBacktraceInput = {
  readonly target: DualBacktraceTarget; readonly attempts: readonly DualBacktraceAttemptInput[];
  readonly edges?: readonly DualBacktraceEdgeInput[]; readonly revokedIds?: ReadonlySet<string>;
  readonly requiredPurpose?: string; readonly allowSameQuestionSuccess?: boolean; readonly limit?: number;
};
export type DualBacktraceResult = Omit<DualBacktraceResultWire, 'target' | 'similarMistakes' | 'independentSuccesses'> & {
  readonly target: DualBacktraceTarget;
  readonly similarMistakes: readonly DualBacktraceSimilarMistake[];
  readonly independentSuccesses: readonly DualBacktraceIndependentSuccess[];
};

const stageLabels: Readonly<Record<string, string>> = {
  reading: '审题漏条件', modeling: '概念模型错误', strategy: '思路卡壳', execution: '计算或执行失误', expression: '表达规范丢分',
};
const basisLabels: Readonly<Record<DualBacktraceMistakeMatchBasis, string>> = {
  error_stage: '同错步机理', archetype: '同母题', variant_family: '同变式族', concept: '同概念', same_question: '同题',
};
const basisWeights: Readonly<Record<DualBacktraceMistakeMatchBasis, number>> = {
  error_stage: 4, archetype: 3, variant_family: 3, concept: 2, same_question: 2,
};
const normalizeStage = (stage: string | null | undefined): string | null => stage?.trim() || null;
const isIndependentHelp = (help: DualBacktraceHelpExposure): help is DualBacktraceIndependentHelpExposure =>
  help === 'none' || help === 'unexposed';
const intersects = (left: ReadonlySet<FactId>, right: ReadonlySet<FactId>) => [...left].some(item => right.has(item));
const scoreBasis = (basis: readonly DualBacktraceMistakeMatchBasis[]) => basis.reduce((s, item) => s + basisWeights[item], 0);
const firstSorted = (values: ReadonlySet<FactId> | undefined): FactId | undefined =>
  values?.size ? [...values].sort(compareText)[0] : undefined;
function compareSubmittedAtDesc(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const lMs = Date.parse(left);
  const rMs = Date.parse(right);
  return Number.isFinite(lMs) && Number.isFinite(rMs) && lMs !== rMs ? rMs - lMs : compareText(right, left);
}

function collectStructuralBasis(
  sharedArch: boolean, inVariantFamily: boolean, sharedConcept: boolean, sameQuestion: boolean,
): DualBacktraceSuccessMatchBasis[] {
  const basis: DualBacktraceSuccessMatchBasis[] = [];
  if (sharedArch) basis.push('archetype');
  if (inVariantFamily) basis.push('variant_family');
  if (sharedConcept) basis.push('concept');
  if (sameQuestion) basis.push('same_question');
  return basis;
}
function buildEvidence<Help extends DualBacktraceHelpExposure>(
  attempt: DualBacktraceAttemptInput, helpExposure: Help, chapterId: FactId | undefined,
  revokedIds: ReadonlySet<string> | undefined,
): DualBacktraceEvidence<Help> {
  const optional = {
    attemptRev: attempt.attemptRev, questionRev: attempt.questionRev, questionTitle: attempt.questionTitle,
    learnerAnswer: attempt.learnerAnswer, learnerQuote: attempt.learnerQuote,
    submittedAt: attempt.submittedAt, durationMs: attempt.durationMs, chapterId,
    chapterTitle: attempt.chapterId !== undefined && chapterId === attempt.chapterId ? attempt.chapterTitle : undefined,
    textbookPageId: attempt.textbookPageId !== undefined && !revokedIds?.has(attempt.textbookPageId)
      ? attempt.textbookPageId : undefined,
    sourceImageRef: attempt.sourceImageRef !== undefined && !revokedIds?.has(attempt.sourceImageRef)
      ? attempt.sourceImageRef : undefined,
  };
  const defined = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined));
  return { attemptId: attempt.attemptId, questionId: attempt.questionId, helpExposure, provenance: 'learner_evidence', ...defined };
}
function describeMechanism(
  errorStage: string | null, errorSummary: string | null | undefined, basis: readonly DualBacktraceMistakeMatchBasis[],
) {
  const summary = errorSummary?.trim();
  const stageText = errorStage !== null ? (stageLabels[errorStage] ?? errorStage) : null;
  if (summary) return stageText && !summary.includes(stageText) ? `${stageText}：${summary}` : summary;
  const matched = basis.map(item => basisLabels[item]).join('、');
  return stageText ? `基于${matched}匹配，历史曾在「${stageText}」阶段出现同类失误` : `基于${matched}匹配，历史曾出现相似失误`;
}
function describeTransferBridge(title: string | undefined, basis: readonly DualBacktraceSuccessMatchBasis[], crossChapter: boolean) {
  const matched = basis.map(item => basisLabels[item]).join('、');
  const titlePart = title?.trim() ? `「${title.trim()}」` : '该相似结构题';
  return `${crossChapter ? '跨章节' : ''}${matched}可迁移先例：你曾独立解出${titlePart}，可迁移复用当时的解题脚手架`;
}
function compareRanked<T extends {
  readonly evidence: { readonly attemptId: FactId; readonly submittedAt?: string };
  readonly inference: { readonly crossChapter: boolean; readonly matchBasis: readonly DualBacktraceMistakeMatchBasis[] };
}>(left: T, right: T): number {
  return Number(right.inference.crossChapter) - Number(left.inference.crossChapter) ||
    scoreBasis(right.inference.matchBasis) - scoreBasis(left.inference.matchBasis) ||
    right.inference.matchBasis.length - left.inference.matchBasis.length ||
    compareSubmittedAtDesc(left.evidence.submittedAt, right.evidence.submittedAt) ||
    compareText(left.evidence.attemptId, right.evidence.attemptId);
}

/** Pure domain retrieval and isolation projection for dual-channel backtrace (similarMistakes vs independentSuccesses). */
export function buildDualBacktrace(input: BuildDualBacktraceInput): DualBacktraceResult {
  const requiredPurpose = input.requiredPurpose?.trim() || undefined;
  const revoked = (id: string | undefined) => id !== undefined && input.revokedIds?.has(id) === true;
  const limit = input.limit === undefined ? 5 : Number.isFinite(input.limit) ? Math.max(0, Math.floor(input.limit)) : 5;
  const addAllowed = (set: Set<FactId>, ids: Iterable<FactId> | undefined) => {
    for (const id of ids ?? []) if (!revoked(id)) set.add(id);
  };
  const latestAttempts = new Map<FactId, DualBacktraceAttemptInput>();
  const retractedIds = new Set<FactId>();
  for (const a of input.attempts) { if (a.retracted === true) retractedIds.add(a.attemptId); latestAttempts.set(a.attemptId, a); }
  let excludedRevokedCount = 0;
  const activeAttempts: DualBacktraceAttemptInput[] = [];
  for (const a of latestAttempts.values()) {
    if (retractedIds.has(a.attemptId) || revoked(a.attemptId) || revoked(a.questionId) || !purposeAllowed(a.purpose, requiredPurpose)) {
      excludedRevokedCount += 1;
    } else activeAttempts.push(a);
  }
  const questionConcepts = new Map<FactId, Set<FactId>>();
  const questionArchetypes = new Map<FactId, Set<FactId>>();
  const variantAdjacency = new Map<FactId, Set<FactId>>();
  const mapsToChapter = new Map<FactId, Set<FactId>>();
  const explainedByChapter = new Map<FactId, Set<FactId>>();
  for (const edge of input.edges ?? []) {
    if (edge.retracted === true || revoked(edge.fromId) || revoked(edge.toId)) continue;
    if (edge.kind === 'targets_concept') addSetValue(questionConcepts, edge.fromId, edge.toId);
    else if (edge.kind === 'instance_of' || edge.kind === 'canonical_archetype') {
      addSetValue(questionArchetypes, edge.fromId, edge.toId);
      addSetValue(questionArchetypes, edge.toId, edge.toId);
    } else if (edge.kind === 'variant_of' && edge.fromId !== edge.toId) {
      addSetValue(variantAdjacency, edge.fromId, edge.toId);
      addSetValue(variantAdjacency, edge.toId, edge.fromId);
    } else if (edge.kind === 'maps_to_chapter') addSetValue(mapsToChapter, edge.fromId, edge.toId);
    else if (edge.kind === 'explains') addSetValue(explainedByChapter, edge.toId, edge.fromId);
  }
  const attemptConceptSets = new Map<FactId, Set<FactId>>();
  const attemptArchetypeSets = new Map<FactId, Set<FactId>>();
  for (const a of activeAttempts) {
    const concepts = new Set<FactId>(questionConcepts.get(a.questionId) ?? []);
    const archetypes = new Set<FactId>(questionArchetypes.get(a.questionId) ?? []);
    addAllowed(concepts, a.conceptIds);
    addAllowed(archetypes, a.archetypeIds);
    for (const archId of archetypes) addAllowed(concepts, questionConcepts.get(archId));
    attemptConceptSets.set(a.attemptId, concepts);
    attemptArchetypeSets.set(a.attemptId, archetypes);
  }
  const targetConcepts = new Set<FactId>();
  const targetArchetypes = new Set<FactId>();
  addAllowed(targetConcepts, input.target.conceptIds);
  addAllowed(targetArchetypes, input.target.archetypeIds);
  const targetQId = input.target.questionId;
  const targetVariantFamily = new Set<FactId>();
  if (targetQId !== undefined && !revoked(targetQId)) {
    addAllowed(targetConcepts, questionConcepts.get(targetQId));
    addAllowed(targetArchetypes, questionArchetypes.get(targetQId));
    for (const a of activeAttempts) {
      if (a.questionId !== targetQId) continue;
      addAllowed(targetConcepts, attemptConceptSets.get(a.attemptId));
      addAllowed(targetArchetypes, attemptArchetypeSets.get(a.attemptId));
    }
    const visited = new Set<FactId>([targetQId]);
    const queue: FactId[] = [targetQId];
    for (let head = 0; head < queue.length; head++) {
      for (const next of variantAdjacency.get(queue[head]!) ?? []) {
        if (!visited.has(next)) { visited.add(next); targetVariantFamily.add(next); queue.push(next); }
      }
    }
  }
  for (const archId of targetArchetypes) addAllowed(targetConcepts, questionConcepts.get(archId));

  const firstFrom = (ids: readonly FactId[], map: Map<FactId, Set<FactId>>) => {
    for (const id of ids) { const hit = firstSorted(map.get(id)); if (hit !== undefined) return hit; }
    return undefined;
  };
  const firstFromEither = (id: FactId | undefined) =>
    id !== undefined && !revoked(id) ? firstSorted(mapsToChapter.get(id)) ?? firstSorted(explainedByChapter.get(id)) : undefined;
  const resolveChapterId = (
    explicitId: FactId | undefined, questionId: FactId | undefined,
    concepts: ReadonlySet<FactId>, archetypes: ReadonlySet<FactId>, textbookPageId: FactId | undefined,
  ): FactId | undefined => {
    if (explicitId !== undefined && !revoked(explicitId)) return explicitId;
    const direct = firstFromEither(questionId) ??
      (textbookPageId !== undefined && !revoked(textbookPageId) ? firstSorted(mapsToChapter.get(textbookPageId)) : undefined);
    if (direct !== undefined) return direct;
    const sortedConcepts = [...concepts].sort(compareText);
    const fromConcept = firstFrom(sortedConcepts, mapsToChapter) ?? firstFrom(sortedConcepts, explainedByChapter);
    if (fromConcept !== undefined) return fromConcept;
    for (const archId of [...archetypes].sort(compareText)) {
      const hit = firstFromEither(archId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  let targetChapterId = resolveChapterId(input.target.chapterId, targetQId, targetConcepts, targetArchetypes, undefined);
  if (targetChapterId === undefined && input.target.excludeAttemptId !== undefined) {
    const excluded = activeAttempts.find(a => a.attemptId === input.target.excludeAttemptId);
    if (excluded?.chapterId !== undefined && !revoked(excluded.chapterId)) targetChapterId = excluded.chapterId;
  }
  const targetErrorStage = normalizeStage(input.target.errorStage);
  const similarMistakes: DualBacktraceSimilarMistake[] = [];
  const independentSuccesses: DualBacktraceIndependentSuccess[] = [];
  for (const attempt of activeAttempts) {
    if (attempt.attemptId === input.target.excludeAttemptId) continue;
    const concepts = attemptConceptSets.get(attempt.attemptId)!;
    const archetypes = attemptArchetypeSets.get(attempt.attemptId)!;
    const sameQ = targetQId !== undefined && attempt.questionId === targetQId;
    const inVariant = !sameQ && targetVariantFamily.has(attempt.questionId);
    const sharedArch = intersects(archetypes, targetArchetypes);
    const sharedConcept = intersects(concepts, targetConcepts);
    const attemptChapterId = resolveChapterId(attempt.chapterId, attempt.questionId, concepts, archetypes, attempt.textbookPageId);
    const crossChapter = targetChapterId !== undefined && attemptChapterId !== undefined && attemptChapterId !== targetChapterId;
    if (attempt.verdict === 'incorrect' || attempt.verdict === 'partial') {
      const attemptStage = normalizeStage(attempt.errorStage);
      const stageMatched = targetErrorStage !== null && attemptStage === targetErrorStage;
      const structural = collectStructuralBasis(sharedArch, inVariant, sharedConcept, sameQ);
      if (targetErrorStage !== null ? !stageMatched : !structural.length) continue;
      const matchBasis: DualBacktraceMistakeMatchBasis[] = stageMatched ? ['error_stage', ...structural] : structural;
      similarMistakes.push({
        evidence: buildEvidence(attempt, attempt.helpExposure, attemptChapterId, input.revokedIds),
        inference: {
          errorStage: attemptStage, mechanismSummary: describeMechanism(attemptStage, attempt.errorSummary, matchBasis),
          matchBasis, crossChapter, provenance: 'system_inference',
        },
      });
      continue;
    }
    const allowSame = sameQ && input.allowSameQuestionSuccess === true;
    if (attempt.verdict !== 'correct' || !isIndependentHelp(attempt.helpExposure) || attempt.independent === false) continue;
    if (sameQ && !allowSame) continue;
    const matchBasis = collectStructuralBasis(sharedArch, inVariant, sharedConcept, allowSame);
    if (!matchBasis.length) continue;
    independentSuccesses.push({
      evidence: buildEvidence(attempt, attempt.helpExposure, attemptChapterId, input.revokedIds),
      inference: {
        transferBridge: describeTransferBridge(attempt.questionTitle, matchBasis, crossChapter),
        matchBasis, crossChapter, provenance: 'system_inference',
      },
    });
  }
  return {
    target: input.target,
    similarMistakes: similarMistakes.sort(compareRanked).slice(0, limit),
    independentSuccesses: independentSuccesses.sort(compareRanked).slice(0, limit),
    excludedRevokedCount,
  };
}
