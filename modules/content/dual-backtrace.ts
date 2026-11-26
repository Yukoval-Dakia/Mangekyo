import type { FactId, Revision } from '@mangekyo/kernel';

export type DualBacktraceHelpExposure =
  | 'none'
  | 'unexposed'
  | 'hint'
  | 'solution_seen'
  | 'worked_example'
  | 'assisted'
  | 'unknown';

export type DualBacktraceIndependentHelpExposure = 'none' | 'unexposed';

export type DualBacktraceAttemptInput = {
  readonly attemptId: FactId;
  readonly attemptRev?: Revision;
  readonly questionId: FactId;
  readonly questionRev?: Revision;
  readonly questionTitle?: string;
  readonly questionPrompt?: string;
  readonly verdict: 'correct' | 'partial' | 'incorrect';
  readonly helpExposure: DualBacktraceHelpExposure;
  readonly independent?: boolean;
  readonly errorStage?: string | null;
  readonly errorSummary?: string | null;
  readonly learnerAnswer?: string;
  readonly learnerQuote?: string;
  readonly durationMs?: number;
  readonly submittedAt?: string;
  readonly chapterId?: FactId;
  readonly chapterTitle?: string;
  readonly textbookPageId?: FactId;
  readonly conceptIds?: readonly FactId[];
  readonly archetypeIds?: readonly FactId[];
  readonly sourceImageRef?: string;
  readonly purpose?: readonly string[];
  readonly retracted?: boolean;
};

export type DualBacktraceEdgeInput = {
  readonly kind: 'targets_concept' | 'variant_of' | 'instance_of' | 'canonical_archetype' | 'maps_to_chapter' | 'explains';
  readonly fromId: FactId;
  readonly toId: FactId;
  readonly retracted?: boolean;
};

export type DualBacktraceTarget = {
  readonly questionId?: FactId;
  readonly conceptIds?: readonly FactId[];
  readonly archetypeIds?: readonly FactId[];
  readonly errorStage?: string | null;
  readonly chapterId?: FactId;
  readonly excludeAttemptId?: FactId;
};

export type DualBacktraceMistakeMatchBasis =
  | 'error_stage'
  | 'concept'
  | 'archetype'
  | 'variant_family'
  | 'same_question';

export type DualBacktraceSuccessMatchBasis =
  | 'concept'
  | 'archetype'
  | 'variant_family'
  | 'same_question';

export type DualBacktraceEvidence<Help extends DualBacktraceHelpExposure = DualBacktraceHelpExposure> = {
  readonly attemptId: FactId;
  readonly attemptRev?: Revision;
  readonly questionId: FactId;
  readonly questionRev?: Revision;
  readonly questionTitle?: string;
  readonly learnerAnswer?: string;
  readonly learnerQuote?: string;
  readonly helpExposure: Help;
  readonly submittedAt?: string;
  readonly durationMs?: number;
  readonly chapterId?: FactId;
  readonly chapterTitle?: string;
  readonly textbookPageId?: FactId;
  readonly sourceImageRef?: string;
  readonly provenance: 'learner_evidence';
};

export type DualBacktraceSimilarMistake = {
  readonly evidence: DualBacktraceEvidence<DualBacktraceHelpExposure>;
  readonly inference: {
    readonly errorStage: string | null;
    readonly mechanismSummary: string;
    readonly matchBasis: readonly DualBacktraceMistakeMatchBasis[];
    readonly crossChapter: boolean;
    readonly provenance: 'system_inference';
  };
};

export type DualBacktraceIndependentSuccess = {
  readonly evidence: DualBacktraceEvidence<DualBacktraceIndependentHelpExposure>;
  readonly inference: {
    readonly transferBridge: string;
    readonly matchBasis: readonly DualBacktraceSuccessMatchBasis[];
    readonly crossChapter: boolean;
    readonly provenance: 'system_inference';
  };
};

export type BuildDualBacktraceInput = {
  readonly target: DualBacktraceTarget;
  readonly attempts: readonly DualBacktraceAttemptInput[];
  readonly edges?: readonly DualBacktraceEdgeInput[];
  readonly revokedIds?: ReadonlySet<string>;
  readonly requiredPurpose?: string;
  readonly allowSameQuestionSuccess?: boolean;
  readonly limit?: number;
};

export type DualBacktraceResult = {
  readonly target: DualBacktraceTarget;
  readonly similarMistakes: readonly DualBacktraceSimilarMistake[];
  readonly independentSuccesses: readonly DualBacktraceIndependentSuccess[];
  readonly excludedRevokedCount: number;
};

const stageLabels: Readonly<Record<string, string>> = {
  reading: '审题漏条件',
  modeling: '概念模型错误',
  strategy: '思路卡壳',
  execution: '计算或执行失误',
  expression: '表达规范丢分',
};

const basisLabels: Readonly<Record<DualBacktraceMistakeMatchBasis, string>> = {
  error_stage: '同错步机理',
  archetype: '同母题',
  variant_family: '同变式族',
  concept: '同概念',
  same_question: '同题',
};

const basisWeights: Readonly<Record<DualBacktraceMistakeMatchBasis, number>> = {
  error_stage: 4,
  archetype: 3,
  variant_family: 3,
  concept: 2,
  same_question: 2,
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  let set = map.get(key);
  if (!set) map.set(key, set = new Set());
  set.add(value);
}

function normalizeStage(stage: string | null | undefined): string | null {
  const trimmed = stage?.trim();
  return trimmed ? trimmed : null;
}

function isIndependentHelpExposure(help: DualBacktraceHelpExposure): help is DualBacktraceIndependentHelpExposure {
  return help === 'none' || help === 'unexposed';
}

function purposeAllowed(purpose: readonly string[] | undefined, requiredPurpose: string | undefined) {
  if (!requiredPurpose) return true;
  return purpose !== undefined && purpose.some(entry => {
    const normalized = entry.trim();
    return normalized === requiredPurpose || normalized === 'all';
  });
}

function intersects(left: ReadonlySet<FactId>, right: ReadonlySet<FactId>) {
  if (!left.size || !right.size) return false;
  for (const item of left) if (right.has(item)) return true;
  return false;
}

function scoreBasis(basis: readonly DualBacktraceMistakeMatchBasis[]) {
  let score = 0;
  for (const item of basis) score += basisWeights[item];
  return score;
}

function compareSubmittedAtDesc(left: string | undefined, right: string | undefined) {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  return compareText(right, left);
}

function firstSorted(values: ReadonlySet<FactId> | undefined): FactId | undefined {
  if (!values || values.size === 0) return undefined;
  return [...values].sort(compareText)[0];
}

function buildEvidence<Help extends DualBacktraceHelpExposure>(
  attempt: DualBacktraceAttemptInput,
  helpExposure: Help,
  chapterId: FactId | undefined,
  revokedIds: ReadonlySet<string> | undefined,
): DualBacktraceEvidence<Help> {
  const textbookPageId = attempt.textbookPageId !== undefined && !revokedIds?.has(attempt.textbookPageId)
    ? attempt.textbookPageId
    : undefined;
  return {
    attemptId: attempt.attemptId,
    ...(attempt.attemptRev !== undefined ? { attemptRev: attempt.attemptRev } : {}),
    questionId: attempt.questionId,
    ...(attempt.questionRev !== undefined ? { questionRev: attempt.questionRev } : {}),
    ...(attempt.questionTitle !== undefined ? { questionTitle: attempt.questionTitle } : {}),
    ...(attempt.learnerAnswer !== undefined ? { learnerAnswer: attempt.learnerAnswer } : {}),
    ...(attempt.learnerQuote !== undefined ? { learnerQuote: attempt.learnerQuote } : {}),
    helpExposure,
    ...(attempt.submittedAt !== undefined ? { submittedAt: attempt.submittedAt } : {}),
    ...(attempt.durationMs !== undefined ? { durationMs: attempt.durationMs } : {}),
    ...(chapterId !== undefined ? { chapterId } : {}),
    ...(attempt.chapterTitle !== undefined ? { chapterTitle: attempt.chapterTitle } : {}),
    ...(textbookPageId !== undefined ? { textbookPageId } : {}),
    ...(attempt.sourceImageRef !== undefined ? { sourceImageRef: attempt.sourceImageRef } : {}),
    provenance: 'learner_evidence',
  };
}

function describeMechanism(
  errorStage: string | null,
  errorSummary: string | null | undefined,
  basis: readonly DualBacktraceMistakeMatchBasis[],
) {
  const summary = errorSummary?.trim();
  const stageText = errorStage !== null ? (stageLabels[errorStage] ?? errorStage) : null;
  if (summary) {
    return stageText && !summary.includes(stageText) ? `${stageText}：${summary}` : summary;
  }
  const matched = basis.map(item => basisLabels[item]).join('、');
  return stageText
    ? `基于${matched}匹配，历史曾在「${stageText}」阶段出现同类失误`
    : `基于${matched}匹配，历史曾出现相似失误`;
}

function describeTransferBridge(
  questionTitle: string | undefined,
  basis: readonly DualBacktraceSuccessMatchBasis[],
  crossChapter: boolean,
) {
  const matched = basis.map(item => basisLabels[item]).join('、');
  const titlePart = questionTitle?.trim() ? `「${questionTitle.trim()}」` : '该相似结构题';
  return `${crossChapter ? '跨章节' : ''}${matched}可迁移先例：你曾独立解出${titlePart}，可迁移复用当时的解题脚手架`;
}

/**
 * Pure domain retrieval and isolation projection for dual-channel backtrace:
 * 1) similarMistakes — learner's own prior mistakes sharing error mechanism or structure;
 * 2) independentSuccesses — strictly unassisted ('none' | 'unexposed') independent successes only.
 */
export function buildDualBacktrace(input: BuildDualBacktraceInput): DualBacktraceResult {
  const requiredPurpose = input.requiredPurpose?.trim() || undefined;
  const revoked = (id: string | undefined) => id !== undefined && input.revokedIds?.has(id) === true;
  const limit = input.limit === undefined
    ? 5
    : Number.isFinite(input.limit) ? Math.max(0, Math.floor(input.limit)) : 5;

  const retractedAttemptIds = new Set<FactId>();
  for (const attempt of input.attempts) if (attempt.retracted === true) retractedAttemptIds.add(attempt.attemptId);

  let excludedRevokedCount = 0;
  const activeAttempts: DualBacktraceAttemptInput[] = [];
  const seenAttemptIds = new Set<FactId>();
  for (const attempt of input.attempts) {
    if (retractedAttemptIds.has(attempt.attemptId) ||
        revoked(attempt.attemptId) ||
        revoked(attempt.questionId) ||
        !purposeAllowed(attempt.purpose, requiredPurpose)) {
      excludedRevokedCount += 1;
      continue;
    }
    if (seenAttemptIds.has(attempt.attemptId)) continue;
    seenAttemptIds.add(attempt.attemptId);
    activeAttempts.push(attempt);
  }

  const activeEdges = (input.edges ?? []).filter(edge =>
    edge.retracted !== true && !revoked(edge.fromId) && !revoked(edge.toId));

  const questionConcepts = new Map<FactId, Set<FactId>>();
  const questionArchetypes = new Map<FactId, Set<FactId>>();
  const variantAdjacency = new Map<FactId, Set<FactId>>();
  const mapsToChapter = new Map<FactId, Set<FactId>>();
  const explainedByChapter = new Map<FactId, Set<FactId>>();

  for (const edge of activeEdges) {
    if (edge.kind === 'targets_concept') {
      addSetValue(questionConcepts, edge.fromId, edge.toId);
    } else if (edge.kind === 'instance_of' || edge.kind === 'canonical_archetype') {
      addSetValue(questionArchetypes, edge.fromId, edge.toId);
      addSetValue(questionArchetypes, edge.toId, edge.toId);
    } else if (edge.kind === 'variant_of' && edge.fromId !== edge.toId) {
      addSetValue(variantAdjacency, edge.fromId, edge.toId);
      addSetValue(variantAdjacency, edge.toId, edge.fromId);
    } else if (edge.kind === 'maps_to_chapter') {
      addSetValue(mapsToChapter, edge.fromId, edge.toId);
    } else if (edge.kind === 'explains') {
      addSetValue(explainedByChapter, edge.toId, edge.fromId);
    }
  }

  const attemptConceptSets = new Map<FactId, Set<FactId>>();
  const attemptArchetypeSets = new Map<FactId, Set<FactId>>();
  for (const attempt of activeAttempts) {
    const concepts = new Set<FactId>(questionConcepts.get(attempt.questionId) ?? []);
    for (const conceptId of attempt.conceptIds ?? []) {
      if (!revoked(conceptId)) concepts.add(conceptId);
    }
    const archetypes = new Set<FactId>(questionArchetypes.get(attempt.questionId) ?? []);
    for (const archetypeId of attempt.archetypeIds ?? []) {
      if (!revoked(archetypeId)) archetypes.add(archetypeId);
    }
    attemptConceptSets.set(attempt.attemptId, concepts);
    attemptArchetypeSets.set(attempt.attemptId, archetypes);
  }

  const targetConcepts = new Set<FactId>();
  for (const conceptId of input.target.conceptIds ?? []) {
    if (!revoked(conceptId)) targetConcepts.add(conceptId);
  }
  const targetArchetypes = new Set<FactId>();
  for (const archetypeId of input.target.archetypeIds ?? []) {
    if (!revoked(archetypeId)) targetArchetypes.add(archetypeId);
  }
  if (input.target.questionId !== undefined && !revoked(input.target.questionId)) {
    for (const conceptId of questionConcepts.get(input.target.questionId) ?? []) targetConcepts.add(conceptId);
    for (const archetypeId of questionArchetypes.get(input.target.questionId) ?? []) targetArchetypes.add(archetypeId);
    for (const attempt of activeAttempts) {
      if (attempt.questionId !== input.target.questionId) continue;
      for (const conceptId of attemptConceptSets.get(attempt.attemptId) ?? []) targetConcepts.add(conceptId);
      for (const archetypeId of attemptArchetypeSets.get(attempt.attemptId) ?? []) targetArchetypes.add(archetypeId);
    }
  }
  for (const archetypeId of targetArchetypes) {
    for (const conceptId of questionConcepts.get(archetypeId) ?? []) targetConcepts.add(conceptId);
  }

  const targetVariantFamily = new Set<FactId>();
  if (input.target.questionId !== undefined && !revoked(input.target.questionId)) {
    const visited = new Set<FactId>([input.target.questionId]);
    const queue: FactId[] = [input.target.questionId];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const next of variantAdjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        targetVariantFamily.add(next);
        queue.push(next);
      }
    }
  }

  const resolveChapterId = (
    explicitChapterId: FactId | undefined,
    questionId: FactId | undefined,
    concepts: ReadonlySet<FactId>,
    archetypes: ReadonlySet<FactId>,
    textbookPageId: FactId | undefined,
  ): FactId | undefined => {
    if (explicitChapterId !== undefined && !revoked(explicitChapterId)) return explicitChapterId;
    if (questionId !== undefined && !revoked(questionId)) {
      const fromQuestion = firstSorted(mapsToChapter.get(questionId)) ?? firstSorted(explainedByChapter.get(questionId));
      if (fromQuestion !== undefined) return fromQuestion;
    }
    if (textbookPageId !== undefined && !revoked(textbookPageId)) {
      const fromPage = firstSorted(mapsToChapter.get(textbookPageId));
      if (fromPage !== undefined) return fromPage;
    }
    const sortedConcepts = [...concepts].sort(compareText);
    for (const conceptId of sortedConcepts) {
      const mapped = firstSorted(mapsToChapter.get(conceptId));
      if (mapped !== undefined) return mapped;
    }
    for (const conceptId of sortedConcepts) {
      const explained = firstSorted(explainedByChapter.get(conceptId));
      if (explained !== undefined) return explained;
    }
    for (const archetypeId of [...archetypes].sort(compareText)) {
      const mapped = firstSorted(mapsToChapter.get(archetypeId)) ?? firstSorted(explainedByChapter.get(archetypeId));
      if (mapped !== undefined) return mapped;
    }
    return undefined;
  };

  let targetChapterId = resolveChapterId(
    input.target.chapterId,
    input.target.questionId,
    targetConcepts,
    targetArchetypes,
    undefined,
  );
  if (targetChapterId === undefined && input.target.excludeAttemptId !== undefined) {
    const excludedCurrent = activeAttempts.find(attempt => attempt.attemptId === input.target.excludeAttemptId);
    if (excludedCurrent?.chapterId !== undefined && !revoked(excludedCurrent.chapterId)) {
      targetChapterId = excludedCurrent.chapterId;
    }
  }

  const targetErrorStage = normalizeStage(input.target.errorStage);
  const similarMistakes: DualBacktraceSimilarMistake[] = [];
  const independentSuccesses: DualBacktraceIndependentSuccess[] = [];

  for (const attempt of activeAttempts) {
    if (attempt.attemptId === input.target.excludeAttemptId) continue;
    const concepts = attemptConceptSets.get(attempt.attemptId)!;
    const archetypes = attemptArchetypeSets.get(attempt.attemptId)!;
    const sameQuestion = input.target.questionId !== undefined && attempt.questionId === input.target.questionId;
    const inVariantFamily = !sameQuestion && targetVariantFamily.has(attempt.questionId);
    const sharedArchetype = intersects(archetypes, targetArchetypes);
    const sharedConcept = intersects(concepts, targetConcepts);
    const attemptChapterId = resolveChapterId(
      attempt.chapterId,
      attempt.questionId,
      concepts,
      archetypes,
      attempt.textbookPageId,
    );
    const crossChapter = targetChapterId !== undefined &&
      attemptChapterId !== undefined &&
      attemptChapterId !== targetChapterId;

    if (attempt.verdict === 'incorrect' || attempt.verdict === 'partial') {
      const attemptErrorStage = normalizeStage(attempt.errorStage);
      const stageMatched = targetErrorStage !== null && attemptErrorStage === targetErrorStage;
      const structuralBasis: DualBacktraceMistakeMatchBasis[] = [];
      if (sharedArchetype) structuralBasis.push('archetype');
      if (inVariantFamily) structuralBasis.push('variant_family');
      if (sharedConcept) structuralBasis.push('concept');
      if (sameQuestion) structuralBasis.push('same_question');

      const matched = targetErrorStage !== null ? stageMatched : structuralBasis.length > 0;
      if (!matched) continue;

      const matchBasis: DualBacktraceMistakeMatchBasis[] = stageMatched
        ? ['error_stage', ...structuralBasis]
        : structuralBasis;
      similarMistakes.push({
        evidence: buildEvidence(attempt, attempt.helpExposure, attemptChapterId, input.revokedIds),
        inference: {
          errorStage: attemptErrorStage,
          mechanismSummary: describeMechanism(attemptErrorStage, attempt.errorSummary, matchBasis),
          matchBasis,
          crossChapter,
          provenance: 'system_inference',
        },
      });
      continue;
    }

    // Channel 2: strictly unassisted independent successes only (zero contamination).
    if (attempt.verdict !== 'correct') continue;
    if (!isIndependentHelpExposure(attempt.helpExposure)) continue;
    if (attempt.independent === false) continue;
    if (sameQuestion && input.allowSameQuestionSuccess !== true) continue;

    const matchBasis: DualBacktraceSuccessMatchBasis[] = [];
    if (sharedArchetype) matchBasis.push('archetype');
    if (inVariantFamily) matchBasis.push('variant_family');
    if (sharedConcept) matchBasis.push('concept');
    if (sameQuestion && input.allowSameQuestionSuccess === true) matchBasis.push('same_question');
    if (!matchBasis.length) continue;

    independentSuccesses.push({
      evidence: buildEvidence(attempt, attempt.helpExposure, attemptChapterId, input.revokedIds),
      inference: {
        transferBridge: describeTransferBridge(attempt.questionTitle, matchBasis, crossChapter),
        matchBasis,
        crossChapter,
        provenance: 'system_inference',
      },
    });
  }

  similarMistakes.sort((left, right) =>
    Number(right.inference.crossChapter) - Number(left.inference.crossChapter) ||
    scoreBasis(right.inference.matchBasis) - scoreBasis(left.inference.matchBasis) ||
    right.inference.matchBasis.length - left.inference.matchBasis.length ||
    compareSubmittedAtDesc(left.evidence.submittedAt, right.evidence.submittedAt) ||
    compareText(left.evidence.attemptId, right.evidence.attemptId));

  independentSuccesses.sort((left, right) =>
    Number(right.inference.crossChapter) - Number(left.inference.crossChapter) ||
    scoreBasis(right.inference.matchBasis) - scoreBasis(left.inference.matchBasis) ||
    right.inference.matchBasis.length - left.inference.matchBasis.length ||
    compareSubmittedAtDesc(left.evidence.submittedAt, right.evidence.submittedAt) ||
    compareText(left.evidence.attemptId, right.evidence.attemptId));

  return {
    target: input.target,
    similarMistakes: similarMistakes.slice(0, limit),
    independentSuccesses: independentSuccesses.slice(0, limit),
    excludedRevokedCount,
  };
}
