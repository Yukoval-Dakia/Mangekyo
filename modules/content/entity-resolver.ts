import type { FactId } from '@mangekyo/kernel';
import { normalizeKnowledgeName, type KnowledgeEntityKind } from './knowledge-entity.ts';

export type EntityEmbedding = {
  readonly model: string;
  readonly vector: readonly number[];
};

export type ResolvableEntityInput = {
  readonly id: FactId;
  readonly kind: KnowledgeEntityKind;
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
  readonly embedding?: EntityEmbedding | null;
  readonly merged_into?: FactId | null;
  readonly mergedInto?: FactId | null;
  readonly sourceKind?: string;
  readonly purpose?: readonly string[];
  readonly revoked?: boolean;
  readonly referenceCount?: number;
};

export type EntityResolutionDecision =
  | 'exact_link'
  | 'semantic_link'
  | 'needs_agent_disambiguation'
  | 'create_new';

export type EntityResolutionCandidate = {
  readonly entityId: FactId;
  readonly canonicalName: string;
  readonly kind: KnowledgeEntityKind;
  readonly score: number;
  readonly lexicalScore: number;
  readonly embeddingScore: number | null;
  readonly embeddingModel?: string;
  readonly matchedName: string;
  readonly matchedBy: 'canonical' | 'alias';
  readonly redirectChain: readonly FactId[];
  readonly reasons: readonly string[];
};

export type EntityResolutionResult = {
  readonly decision: EntityResolutionDecision;
  readonly queryName: string;
  readonly normalizedQuery: string;
  readonly targetId: FactId | null;
  readonly score: number;
  readonly redirectChain: readonly FactId[];
  readonly candidates: readonly EntityResolutionCandidate[];
  readonly reasons: readonly string[];
  readonly excludedCount: number;
};

export type DuplicateEntityCandidate = {
  readonly pairKey: string;
  readonly kind: KnowledgeEntityKind;
  readonly leftId: FactId;
  readonly rightId: FactId;
  readonly leftName: string;
  readonly rightName: string;
  readonly recommendedKeepId: FactId;
  readonly recommendedMergeId: FactId;
  readonly score: number;
  readonly lexicalScore: number;
  readonly embeddingScore: number | null;
  readonly crossSource: boolean;
  readonly sources: readonly string[];
  readonly reasons: readonly string[];
};

export type EntityRedirectResult = {
  readonly startId: FactId;
  readonly finalId: FactId | null;
  readonly finalEntity: ResolvableEntityInput | null;
  readonly redirectChain: readonly FactId[];
  readonly cycleDetected: boolean;
  readonly missingTargetId?: FactId;
  readonly kindMismatch?: boolean;
};

export type EntityResolutionThresholds = {
  readonly semanticLink?: number;
  readonly disambiguation?: number;
  readonly ambiguityMargin?: number;
  readonly maxCandidates?: number;
  readonly lexicalWeight?: number;
  readonly embeddingWeight?: number;
};

export type ResolveKnowledgeEntityQuery = {
  readonly kind: KnowledgeEntityKind;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly embedding?: EntityEmbedding | null;
  readonly requiredPurpose?: string;
  readonly revokedIds?: ReadonlySet<FactId>;
  readonly thresholds?: EntityResolutionThresholds;
};

export type DuplicateEntityScanOptions = {
  readonly minScore?: number;
  readonly requiredPurpose?: string;
  readonly revokedIds?: ReadonlySet<FactId>;
  readonly lexicalWeight?: number;
  readonly embeddingWeight?: number;
  readonly kinds?: readonly KnowledgeEntityKind[];
};

const DEFAULT_SEMANTIC_LINK = 0.86;
const DEFAULT_DISAMBIGUATION = 0.55;
const DEFAULT_AMBIGUITY_MARGIN = 0.05;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_LEXICAL_WEIGHT = 0.35;
const DEFAULT_EMBEDDING_WEIGHT = 0.65;
const DEFAULT_DUPLICATE_MIN_SCORE = 0.72;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roundScore(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

function entityRedirectTarget(entity: ResolvableEntityInput): FactId | null {
  return entity.merged_into ?? entity.mergedInto ?? null;
}

function isEntityRevoked(entity: ResolvableEntityInput, revokedIds: ReadonlySet<FactId> | undefined): boolean {
  return entity.revoked === true || revokedIds?.has(entity.id) === true;
}

function isPurposeAllowed(purpose: readonly string[] | undefined, requiredPurpose: string | undefined): boolean {
  if (!requiredPurpose) return true;
  if (!purpose || purpose.length === 0) return false;
  return purpose.some(entry => {
    const trimmed = entry.trim();
    return trimmed === requiredPurpose || trimmed === 'all';
  });
}

function isValidEmbedding(embedding: EntityEmbedding | null | undefined): embedding is EntityEmbedding {
  if (!embedding || typeof embedding.model !== 'string' || !embedding.model.trim()) return false;
  if (!Array.isArray(embedding.vector) || embedding.vector.length === 0) return false;
  let hasNonZero = false;
  for (const component of embedding.vector) {
    if (typeof component !== 'number' || !Number.isFinite(component)) return false;
    if (component !== 0) hasNonZero = true;
  }
  return hasNonZero;
}

export function cosineSimilarity(
  left: EntityEmbedding | null | undefined,
  right: EntityEmbedding | null | undefined,
): number | null {
  if (!isValidEmbedding(left) || !isValidEmbedding(right)) return null;
  if (left.model.trim() !== right.model.trim()) return null;
  if (left.vector.length !== right.vector.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.vector.length; index++) {
    const a = left.vector[index]!;
    const b = right.vector[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return roundScore(dot / denom);
}

function stripPunctuationForNgrams(name: string): string {
  return normalizeKnowledgeName(name).replace(/[^\p{L}\p{N}]+/gu, '');
}

function buildCharacterNgramBag(name: string): { readonly counts: Map<string, number>; readonly total: number } {
  const cleaned = stripPunctuationForNgrams(name);
  const chars = Array.from(cleaned);
  const counts = new Map<string, number>();
  let total = 0;
  const add = (gram: string) => {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
    total += 1;
  };
  if (chars.length === 1) {
    add(chars[0]!);
  } else if (chars.length === 2) {
    add(chars[0]! + chars[1]!);
  } else if (chars.length >= 3) {
    for (let index = 0; index <= chars.length - 3; index++) {
      add(chars[index]! + chars[index + 1]! + chars[index + 2]!);
    }
    for (let index = 0; index <= chars.length - 2; index++) {
      add(chars[index]! + chars[index + 1]!);
    }
  }
  return { counts, total };
}

export function lexicalNgramDice(leftName: string, rightName: string): number {
  const leftNormalized = normalizeKnowledgeName(leftName);
  const rightNormalized = normalizeKnowledgeName(rightName);
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  const leftBag = buildCharacterNgramBag(leftNormalized);
  const rightBag = buildCharacterNgramBag(rightNormalized);
  if (leftBag.total === 0 || rightBag.total === 0) return 0;
  let overlap = 0;
  for (const [gram, leftCount] of leftBag.counts) {
    const rightCount = rightBag.counts.get(gram);
    if (rightCount !== undefined) overlap += Math.min(leftCount, rightCount);
  }
  return roundScore((2 * overlap) / (leftBag.total + rightBag.total));
}

function resolveWeights(lexicalWeight?: number, embeddingWeight?: number): { readonly lexical: number; readonly embedding: number } {
  const lexical = lexicalWeight !== undefined && Number.isFinite(lexicalWeight) && lexicalWeight >= 0
    ? lexicalWeight
    : DEFAULT_LEXICAL_WEIGHT;
  const embedding = embeddingWeight !== undefined && Number.isFinite(embeddingWeight) && embeddingWeight >= 0
    ? embeddingWeight
    : DEFAULT_EMBEDDING_WEIGHT;
  const sum = lexical + embedding;
  if (sum <= 0) return { lexical: DEFAULT_LEXICAL_WEIGHT, embedding: DEFAULT_EMBEDDING_WEIGHT };
  return { lexical: lexical / sum, embedding: embedding / sum };
}

function fuseScores(
  lexicalScore: number,
  embeddingScore: number | null,
  weights: { readonly lexical: number; readonly embedding: number },
): number {
  if (embeddingScore === null) return roundScore(lexicalScore);
  return roundScore(lexicalScore * weights.lexical + embeddingScore * weights.embedding);
}

/** Safely follow `merged_into ?? mergedInto` redirects with cycle detection and kind consistency checks. */
export function followEntityRedirect(
  id: FactId,
  entityById: ReadonlyMap<FactId, ResolvableEntityInput>,
): EntityRedirectResult {
  const redirectChain: FactId[] = [];
  const visited = new Set<FactId>();
  let currentId: FactId = id;
  let expectedKind: KnowledgeEntityKind | undefined;
  for (;;) {
    if (visited.has(currentId)) {
      return { startId: id, finalId: null, finalEntity: null, redirectChain, cycleDetected: true };
    }
    const entity = entityById.get(currentId);
    if (!entity) {
      return { startId: id, finalId: null, finalEntity: null, redirectChain, cycleDetected: false, missingTargetId: currentId };
    }
    if (expectedKind !== undefined && entity.kind !== expectedKind) {
      return { startId: id, finalId: null, finalEntity: null, redirectChain, cycleDetected: false, kindMismatch: true };
    }
    expectedKind = entity.kind;
    const nextId = entityRedirectTarget(entity);
    if (nextId === null) {
      return { startId: id, finalId: entity.id, finalEntity: entity, redirectChain, cycleDetected: false };
    }
    visited.add(currentId);
    redirectChain.push(currentId);
    currentId = nextId;
  }
}

type EntityNameEntry = {
  readonly name: string;
  readonly normalized: string;
  readonly matchedBy: 'canonical' | 'alias';
};

function entityNameEntries(entity: ResolvableEntityInput): EntityNameEntry[] {
  const entries: EntityNameEntry[] = [];
  const canonicalNormalized = normalizeKnowledgeName(entity.canonicalName);
  if (canonicalNormalized) {
    entries.push({ name: entity.canonicalName, normalized: canonicalNormalized, matchedBy: 'canonical' });
  }
  for (const alias of entity.aliases ?? []) {
    const normalized = normalizeKnowledgeName(alias);
    if (normalized) entries.push({ name: alias, normalized, matchedBy: 'alias' });
  }
  return entries;
}

function shouldPreferCandidate(candidate: EntityResolutionCandidate, existing: EntityResolutionCandidate): boolean {
  if (candidate.score !== existing.score) return candidate.score > existing.score;
  if (candidate.lexicalScore !== existing.lexicalScore) return candidate.lexicalScore > existing.lexicalScore;
  if (candidate.redirectChain.length !== existing.redirectChain.length) {
    return candidate.redirectChain.length < existing.redirectChain.length;
  }
  if (candidate.matchedBy !== existing.matchedBy) return candidate.matchedBy === 'canonical';
  return compareText(candidate.matchedName, existing.matchedName) < 0;
}

function sortCandidates(candidates: readonly EntityResolutionCandidate[]): EntityResolutionCandidate[] {
  return [...candidates].sort((left, right) =>
    right.score - left.score ||
    right.lexicalScore - left.lexicalScore ||
    compareText(left.entityId, right.entityId));
}

/** Deterministic 3-stage entity resolution: exact link (with redirect) -> hybrid recall -> threshold decision. */
export function resolveKnowledgeEntity(
  query: ResolveKnowledgeEntityQuery,
  entities: readonly ResolvableEntityInput[],
): EntityResolutionResult {
  const normalizedQuery = normalizeKnowledgeName(query.name);
  const queryNames = [query.name, ...(query.aliases ?? [])]
    .map(name => ({ raw: name, normalized: normalizeKnowledgeName(name) }))
    .filter(item => item.normalized.length > 0);
  const queryNormalizedSet = new Set(queryNames.map(item => item.normalized));
  const requiredPurpose = query.requiredPurpose?.trim() || undefined;
  const semanticLinkThreshold = query.thresholds?.semanticLink ?? DEFAULT_SEMANTIC_LINK;
  const disambiguationThreshold = query.thresholds?.disambiguation ?? DEFAULT_DISAMBIGUATION;
  const ambiguityMargin = query.thresholds?.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;
  const maxCandidates = Math.max(1, Math.floor(query.thresholds?.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  const weights = resolveWeights(query.thresholds?.lexicalWeight, query.thresholds?.embeddingWeight);

  const entityById = new Map<FactId, ResolvableEntityInput>();
  for (const entity of entities) {
    if (!entityById.has(entity.id)) entityById.set(entity.id, entity);
  }

  let excludedCount = 0;
  const eligibleEntries: {
    readonly entry: ResolvableEntityInput;
    readonly target: ResolvableEntityInput;
    readonly redirectChain: readonly FactId[];
  }[] = [];

  for (const entry of entityById.values()) {
    if (entry.kind !== query.kind) continue;
    const redirected = followEntityRedirect(entry.id, entityById);
    if (redirected.cycleDetected || redirected.kindMismatch || !redirected.finalEntity) {
      continue;
    }
    const target = redirected.finalEntity;
    const entryRevoked = isEntityRevoked(entry, query.revokedIds);
    const hopRevoked = redirected.redirectChain.some(hopId => {
      const hop = entityById.get(hopId);
      return hop !== undefined && isEntityRevoked(hop, query.revokedIds);
    });
    const targetRevoked = isEntityRevoked(target, query.revokedIds);
    const targetPurposeOk = isPurposeAllowed(target.purpose, requiredPurpose);
    const entryPurposeOk = entry.id === target.id || entry.purpose === undefined || isPurposeAllowed(entry.purpose, requiredPurpose);
    if (entryRevoked || hopRevoked || targetRevoked || !targetPurposeOk || !entryPurposeOk) {
      excludedCount += 1;
      continue;
    }
    eligibleEntries.push({ entry, target, redirectChain: redirected.redirectChain });
  }

  if (queryNormalizedSet.size === 0) {
    return {
      decision: 'create_new',
      queryName: query.name,
      normalizedQuery,
      targetId: null,
      score: 0,
      redirectChain: [],
      candidates: [],
      reasons: ['查询名称为空，无法匹配现有实体'],
      excludedCount,
    };
  }

  // Stage 1: exact normalized match across canonicalName & aliases (including merged_into redirects).
  const exactByTarget = new Map<FactId, EntityResolutionCandidate>();
  for (const { entry, target, redirectChain } of eligibleEntries) {
    const matched = entityNameEntries(entry).find(item => queryNormalizedSet.has(item.normalized));
    if (!matched) continue;
    const targetEmbedding = target.embedding ?? entry.embedding;
    const embeddingScore = cosineSimilarity(query.embedding, targetEmbedding);
    const reasons: string[] = [
      matched.matchedBy === 'canonical'
        ? `规范名精确命中「${matched.name}」`
        : `别名精确命中「${matched.name}」`,
    ];
    if (redirectChain.length > 0) {
      reasons.push(`已沿 merged_into 链归位至「${target.canonicalName}」`);
    }
    if (embeddingScore !== null && targetEmbedding) {
      reasons.push(`语义向量(${targetEmbedding.model})余弦相似度 ${embeddingScore.toFixed(3)}`);
    }
    const candidate: EntityResolutionCandidate = {
      entityId: target.id,
      canonicalName: target.canonicalName,
      kind: target.kind,
      score: 1,
      lexicalScore: 1,
      embeddingScore,
      ...(embeddingScore !== null && targetEmbedding ? { embeddingModel: targetEmbedding.model.trim() } : {}),
      matchedName: matched.name,
      matchedBy: matched.matchedBy,
      redirectChain,
      reasons,
    };
    const existing = exactByTarget.get(target.id);
    if (!existing || shouldPreferCandidate(candidate, existing)) {
      exactByTarget.set(target.id, candidate);
    }
  }

  if (exactByTarget.size === 1) {
    const [winner] = exactByTarget.values();
    return {
      decision: 'exact_link',
      queryName: query.name,
      normalizedQuery,
      targetId: winner!.entityId,
      score: 1,
      redirectChain: winner!.redirectChain,
      candidates: [winner!],
      reasons: winner!.reasons,
      excludedCount,
    };
  }

  if (exactByTarget.size > 1) {
    const rankedExact = sortCandidates([...exactByTarget.values()]).slice(0, maxCandidates);
    return {
      decision: 'needs_agent_disambiguation',
      queryName: query.name,
      normalizedQuery,
      targetId: null,
      score: 1,
      redirectChain: [],
      candidates: rankedExact,
      reasons: [`发现 ${exactByTarget.size} 个不同规范实体精确撞名，需交由上下文裁决`],
      excludedCount,
    };
  }

  // Stage 2: hybrid recall (CJK/Latin character n-gram Dice + optional embedding cosine similarity).
  const candidateByTarget = new Map<FactId, EntityResolutionCandidate>();
  for (const { entry, target, redirectChain } of eligibleEntries) {
    const nameEntries = entityNameEntries(entry);
    let bestLexical = 0;
    let bestName = entry.canonicalName;
    let bestMatchedBy: 'canonical' | 'alias' = 'canonical';
    for (const candidateName of nameEntries) {
      for (const qName of queryNames) {
        const lexical = lexicalNgramDice(qName.raw, candidateName.name);
        const better = lexical > bestLexical ||
          (lexical === bestLexical && candidateName.matchedBy === 'canonical' && bestMatchedBy === 'alias');
        if (better) {
          bestLexical = lexical;
          bestName = candidateName.name;
          bestMatchedBy = candidateName.matchedBy;
        }
      }
    }
    const targetEmbedding = target.embedding ?? entry.embedding;
    const embeddingScore = cosineSimilarity(query.embedding, targetEmbedding);
    const score = fuseScores(bestLexical, embeddingScore, weights);
    const reasons: string[] = [
      `${bestMatchedBy === 'canonical' ? '规范名' : '别名'}「${bestName}」字符 n-gram 相似度 ${bestLexical.toFixed(3)}`,
    ];
    if (embeddingScore !== null && targetEmbedding) {
      reasons.push(`语义向量(${targetEmbedding.model})余弦相似度 ${embeddingScore.toFixed(3)}，融合分 ${score.toFixed(3)}`);
    }
    if (redirectChain.length > 0) {
      reasons.push(`已沿 merged_into 链归位至「${target.canonicalName}」`);
    }
    const candidate: EntityResolutionCandidate = {
      entityId: target.id,
      canonicalName: target.canonicalName,
      kind: target.kind,
      score,
      lexicalScore: bestLexical,
      embeddingScore,
      ...(embeddingScore !== null && targetEmbedding ? { embeddingModel: targetEmbedding.model.trim() } : {}),
      matchedName: bestName,
      matchedBy: bestMatchedBy,
      redirectChain,
      reasons,
    };
    const existing = candidateByTarget.get(target.id);
    if (!existing || shouldPreferCandidate(candidate, existing)) {
      candidateByTarget.set(target.id, candidate);
    }
  }

  // Stage 3: deterministic threshold decision.
  const ranked = sortCandidates([...candidateByTarget.values()]);
  const top1 = ranked[0];
  const top2 = ranked[1];
  const boundedCandidates = ranked.slice(0, maxCandidates);

  if (top1 && top1.score >= semanticLinkThreshold) {
    const clearWinner = !top2 || top2.score < disambiguationThreshold || (top1.score - top2.score) >= ambiguityMargin;
    if (clearWinner) {
      return {
        decision: 'semantic_link',
        queryName: query.name,
        normalizedQuery,
        targetId: top1.entityId,
        score: top1.score,
        redirectChain: top1.redirectChain,
        candidates: boundedCandidates,
        reasons: [...top1.reasons, `最高分 ${top1.score.toFixed(3)} >= 语义直连阈值 ${semanticLinkThreshold.toFixed(2)}`],
        excludedCount,
      };
    }
    return {
      decision: 'needs_agent_disambiguation',
      queryName: query.name,
      normalizedQuery,
      targetId: null,
      score: top1.score,
      redirectChain: [],
      candidates: boundedCandidates,
      reasons: [
        `前两名候选得分接近（${top1.score.toFixed(3)} vs ${top2!.score.toFixed(3)}，差值 < ${ambiguityMargin.toFixed(2)}），需交由上下文裁决`,
      ],
      excludedCount,
    };
  }

  if (top1 && top1.score >= disambiguationThreshold) {
    return {
      decision: 'needs_agent_disambiguation',
      queryName: query.name,
      normalizedQuery,
      targetId: null,
      score: top1.score,
      redirectChain: [],
      candidates: boundedCandidates,
      reasons: [
        `最高分 ${top1.score.toFixed(3)} 落在消歧区间 [${disambiguationThreshold.toFixed(2)}, ${semanticLinkThreshold.toFixed(2)})，需交由上下文裁决`,
      ],
      excludedCount,
    };
  }

  return {
    decision: 'create_new',
    queryName: query.name,
    normalizedQuery,
    targetId: null,
    score: top1?.score ?? 0,
    redirectChain: [],
    candidates: boundedCandidates.filter(candidate => candidate.score > 0),
    reasons: [`最高分 ${(top1?.score ?? 0).toFixed(3)} 低于消歧阈值 ${disambiguationThreshold.toFixed(2)}，建议新建规范实体`],
    excludedCount,
  };
}

function chooseKeepAndMerge(left: ResolvableEntityInput, right: ResolvableEntityInput) {
  const refDiff = (right.referenceCount ?? 0) - (left.referenceCount ?? 0);
  if (refDiff !== 0) return refDiff < 0 ? { keep: left, merge: right } : { keep: right, merge: left };
  const aliasDiff = (right.aliases?.length ?? 0) - (left.aliases?.length ?? 0);
  if (aliasDiff !== 0) return aliasDiff < 0 ? { keep: left, merge: right } : { keep: right, merge: left };
  return compareText(left.id, right.id) <= 0 ? { keep: left, merge: right } : { keep: right, merge: left };
}

/** Batch duplicate scan across sources (Notion notes, papers, textbooks). Skips redirected/revoked/out-of-purpose nodes. */
export function findDuplicateEntityCandidates(
  entities: readonly ResolvableEntityInput[],
  options: DuplicateEntityScanOptions = {},
): DuplicateEntityCandidate[] {
  const minScore = options.minScore ?? DEFAULT_DUPLICATE_MIN_SCORE;
  const requiredPurpose = options.requiredPurpose?.trim() || undefined;
  const weights = resolveWeights(options.lexicalWeight, options.embeddingWeight);
  const allowedKinds = options.kinds ? new Set(options.kinds) : null;

  const activeByKind = new Map<KnowledgeEntityKind, ResolvableEntityInput[]>();
  const seenIds = new Set<FactId>();
  for (const entity of entities) {
    if (seenIds.has(entity.id)) continue;
    seenIds.add(entity.id);
    if (entityRedirectTarget(entity) !== null) continue;
    if (isEntityRevoked(entity, options.revokedIds)) continue;
    if (!isPurposeAllowed(entity.purpose, requiredPurpose)) continue;
    if (allowedKinds && !allowedKinds.has(entity.kind)) continue;
    let bucket = activeByKind.get(entity.kind);
    if (!bucket) activeByKind.set(entity.kind, bucket = []);
    bucket.push(entity);
  }

  const duplicates: DuplicateEntityCandidate[] = [];
  for (const [kind, bucket] of activeByKind) {
    const sortedBucket = [...bucket].sort((a, b) => compareText(a.id, b.id));
    for (let i = 0; i < sortedBucket.length; i++) {
      const left = sortedBucket[i]!;
      const leftEntries = entityNameEntries(left);
      const leftNormalized = new Set(leftEntries.map(item => item.normalized));
      for (let j = i + 1; j < sortedBucket.length; j++) {
        const right = sortedBucket[j]!;
        const rightEntries = entityNameEntries(right);
        const exactHit = rightEntries.find(item => leftNormalized.has(item.normalized));
        let lexicalScore = exactHit ? 1 : 0;
        if (!exactHit) {
          for (const leftName of leftEntries) {
            for (const rightName of rightEntries) {
              const sim = lexicalNgramDice(leftName.name, rightName.name);
              if (sim > lexicalScore) lexicalScore = sim;
            }
          }
        }
        const embeddingScore = cosineSimilarity(left.embedding, right.embedding);
        const score = exactHit ? 1 : fuseScores(lexicalScore, embeddingScore, weights);
        if (score < minScore) continue;

        const leftSource = left.sourceKind?.trim() || undefined;
        const rightSource = right.sourceKind?.trim() || undefined;
        const sources = [...new Set([leftSource, rightSource].filter((value): value is string => Boolean(value)))].sort(compareText);
        const crossSource = Boolean(leftSource && rightSource && leftSource !== rightSource);
        const { keep, merge } = chooseKeepAndMerge(left, right);
        const reasons: string[] = [];
        if (exactHit) reasons.push(`规范名/别名精确碰撞「${exactHit.name}」`);
        else reasons.push(`名称 n-gram 相似度 ${lexicalScore.toFixed(3)}`);
        if (embeddingScore !== null) reasons.push(`语义向量余弦相似度 ${embeddingScore.toFixed(3)}`);
        if (crossSource) reasons.push(`跨来源重复候选（${sources.join(' / ')}）`);

        duplicates.push({
          pairKey: `${left.id}::${right.id}`,
          kind,
          leftId: left.id,
          rightId: right.id,
          leftName: left.canonicalName,
          rightName: right.canonicalName,
          recommendedKeepId: keep.id,
          recommendedMergeId: merge.id,
          score,
          lexicalScore,
          embeddingScore,
          crossSource,
          sources,
          reasons,
        });
      }
    }
  }

  return duplicates.sort((left, right) => right.score - left.score || compareText(left.pairKey, right.pairKey));
}
