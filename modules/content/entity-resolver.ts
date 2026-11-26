import type { FactId } from '@mangekyo/kernel';
import { compareText, entityRedirectTarget, indexLatestById, purposeAllowed, pushMapValue } from './content-guard.ts';
import { normalizeKnowledgeName, type KnowledgeEntityKind } from './knowledge-entity.ts';

export type EntityEmbedding = { readonly model: string; readonly vector: readonly number[] };
export type ResolvableEntityInput = {
  readonly id: FactId; readonly kind: KnowledgeEntityKind; readonly canonicalName: string;
  readonly aliases?: readonly string[]; readonly embedding?: EntityEmbedding | null;
  readonly merged_into?: FactId | null; readonly mergedInto?: FactId | null;
  readonly sourceKind?: string; readonly purpose?: readonly string[];
  readonly revoked?: boolean; readonly referenceCount?: number;
};
export type EntityResolutionDecision = 'exact_link' | 'semantic_link' | 'needs_agent_disambiguation' | 'create_new';
export type EntityResolutionCandidate = {
  readonly entityId: FactId; readonly canonicalName: string; readonly kind: KnowledgeEntityKind;
  readonly score: number; readonly lexicalScore: number; readonly embeddingScore: number | null;
  readonly embeddingModel?: string; readonly matchedName: string; readonly matchedBy: 'canonical' | 'alias';
  readonly redirectChain: readonly FactId[]; readonly reasons: readonly string[];
};
export type EntityResolutionResult = {
  readonly decision: EntityResolutionDecision; readonly queryName: string; readonly normalizedQuery: string;
  readonly targetId: FactId | null; readonly score: number; readonly redirectChain: readonly FactId[];
  readonly candidates: readonly EntityResolutionCandidate[]; readonly reasons: readonly string[];
  readonly excludedCount: number;
};
export type DuplicateEntityCandidate = {
  readonly pairKey: string; readonly kind: KnowledgeEntityKind;
  readonly leftId: FactId; readonly rightId: FactId; readonly leftName: string; readonly rightName: string;
  readonly recommendedKeepId: FactId; readonly recommendedMergeId: FactId;
  readonly score: number; readonly lexicalScore: number; readonly embeddingScore: number | null;
  readonly crossSource: boolean; readonly sources: readonly string[]; readonly reasons: readonly string[];
};
export type EntityRedirectResult = {
  readonly startId: FactId; readonly finalId: FactId | null; readonly finalEntity: ResolvableEntityInput | null;
  readonly redirectChain: readonly FactId[]; readonly cycleDetected: boolean;
  readonly missingTargetId?: FactId; readonly kindMismatch?: boolean;
};
export type EntityResolutionThresholds = {
  readonly semanticLink?: number; readonly disambiguation?: number; readonly ambiguityMargin?: number;
  readonly maxCandidates?: number; readonly lexicalWeight?: number; readonly embeddingWeight?: number;
};
export type ResolveKnowledgeEntityQuery = {
  readonly kind: KnowledgeEntityKind; readonly name: string; readonly aliases?: readonly string[];
  readonly embedding?: EntityEmbedding | null; readonly requiredPurpose?: string;
  readonly revokedIds?: ReadonlySet<FactId>; readonly thresholds?: EntityResolutionThresholds;
};
export type DuplicateEntityScanOptions = {
  readonly minScore?: number; readonly requiredPurpose?: string; readonly revokedIds?: ReadonlySet<FactId>;
  readonly lexicalWeight?: number; readonly embeddingWeight?: number; readonly kinds?: readonly KnowledgeEntityKind[];
};

type EntityNameEntry = { readonly name: string; readonly normalized: string; readonly matchedBy: 'canonical' | 'alias' };
type EligibleEntry = {
  readonly entry: ResolvableEntityInput; readonly target: ResolvableEntityInput; readonly redirectChain: readonly FactId[];
};
const SCORE_SCALE = 1_000_000;
const DEFAULTS = {
  semanticLink: 0.86, disambiguation: 0.55, ambiguityMargin: 0.05, maxCandidates: 5,
  lexicalWeight: 0.35, embeddingWeight: 0.65, duplicateMinScore: 0.72,
} as const;

const roundScore = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * SCORE_SCALE) / SCORE_SCALE;
const isEntityRevoked = (entity: ResolvableEntityInput, revokedIds?: ReadonlySet<FactId>) =>
  entity.revoked === true || revokedIds?.has(entity.id) === true;
const isValidEmbedding = (emb: EntityEmbedding | null | undefined): emb is EntityEmbedding =>
  Boolean(emb && typeof emb.model === 'string' && emb.model.trim() && Array.isArray(emb.vector) && emb.vector.length &&
    emb.vector.every(v => typeof v === 'number' && Number.isFinite(v)) && emb.vector.some(v => v !== 0));

export function cosineSimilarity(
  left: EntityEmbedding | null | undefined,
  right: EntityEmbedding | null | undefined,
): number | null {
  if (!isValidEmbedding(left) || !isValidEmbedding(right)) return null;
  if (left.model.trim() !== right.model.trim() || left.vector.length !== right.vector.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.vector.length; i++) {
    const a = left.vector[i]!;
    const b = right.vector[i]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return Number.isFinite(denom) && denom > 0 ? roundScore(dot / denom) : null;
}

function buildNgramBag(chars: readonly string[], unigramOnly: boolean) {
  const counts = new Map<string, number>();
  let total = 0;
  const add = (gram: string) => { counts.set(gram, (counts.get(gram) ?? 0) + 1); total += 1; };
  if (unigramOnly || chars.length === 1) for (const ch of chars) add(ch);
  else if (chars.length === 2) add(chars[0]! + chars[1]!);
  else {
    for (let i = 0; i <= chars.length - 3; i++) add(chars[i]! + chars[i + 1]! + chars[i + 2]!);
    for (let i = 0; i <= chars.length - 2; i++) add(chars[i]! + chars[i + 1]!);
  }
  return { counts, total };
}

export function lexicalNgramDice(leftName: string, rightName: string): number {
  const leftNorm = normalizeKnowledgeName(leftName);
  const rightNorm = normalizeKnowledgeName(rightName);
  if (!leftNorm || !rightNorm) return 0;
  if (leftNorm === rightNorm) return 1;
  const leftChars = Array.from(leftNorm.replace(/[^\p{L}\p{N}]+/gu, ''));
  const rightChars = Array.from(rightNorm.replace(/[^\p{L}\p{N}]+/gu, ''));
  if (!leftChars.length || !rightChars.length) return 0;
  const unigramOnly = leftChars.length === 1 || rightChars.length === 1;
  const leftBag = buildNgramBag(leftChars, unigramOnly);
  const rightBag = buildNgramBag(rightChars, unigramOnly);
  let overlap = 0;
  for (const [gram, count] of leftBag.counts) overlap += Math.min(count, rightBag.counts.get(gram) ?? 0);
  return roundScore((2 * overlap) / (leftBag.total + rightBag.total));
}

function resolveWeights(lexicalWeight?: number, embeddingWeight?: number) {
  const lex = lexicalWeight !== undefined && Number.isFinite(lexicalWeight) && lexicalWeight >= 0
    ? lexicalWeight : DEFAULTS.lexicalWeight;
  const emb = embeddingWeight !== undefined && Number.isFinite(embeddingWeight) && embeddingWeight >= 0
    ? embeddingWeight : DEFAULTS.embeddingWeight;
  const sum = lex + emb;
  return sum > 0 ? { lexical: lex / sum, embedding: emb / sum } : { lexical: DEFAULTS.lexicalWeight, embedding: DEFAULTS.embeddingWeight };
}

const fuseScores = (lexical: number, embedding: number | null, weights: { readonly lexical: number; readonly embedding: number }) =>
  embedding === null ? roundScore(lexical) : roundScore(lexical * weights.lexical + embedding * weights.embedding);

/** Safely follow `merged_into ?? mergedInto` redirects with cycle detection and kind consistency checks. */
export function followEntityRedirect(
  id: FactId,
  entityById: ReadonlyMap<FactId, ResolvableEntityInput>,
): EntityRedirectResult {
  const redirectChain: FactId[] = [];
  const visited = new Set<FactId>();
  let currentId: FactId = id;
  let expectedKind: KnowledgeEntityKind | undefined;
  const fail = (extra: Partial<EntityRedirectResult>): EntityRedirectResult =>
    ({ startId: id, finalId: null, finalEntity: null, redirectChain, cycleDetected: false, ...extra });
  for (;;) {
    if (visited.has(currentId)) return fail({ cycleDetected: true });
    const entity = entityById.get(currentId);
    if (!entity) return fail({ missingTargetId: currentId });
    if (expectedKind !== undefined && entity.kind !== expectedKind) return fail({ kindMismatch: true });
    expectedKind = entity.kind;
    const nextId = entityRedirectTarget(entity);
    if (nextId === null) return { startId: id, finalId: entity.id, finalEntity: entity, redirectChain, cycleDetected: false };
    visited.add(currentId);
    redirectChain.push(currentId);
    currentId = nextId;
  }
}

function entityNameEntries(entity: ResolvableEntityInput): EntityNameEntry[] {
  const entries: EntityNameEntry[] = [];
  const canonical = normalizeKnowledgeName(entity.canonicalName);
  if (canonical) entries.push({ name: entity.canonicalName, normalized: canonical, matchedBy: 'canonical' });
  for (const alias of entity.aliases ?? []) {
    const normalized = normalizeKnowledgeName(alias);
    if (normalized) entries.push({ name: alias, normalized, matchedBy: 'alias' });
  }
  return entries;
}

function bestLexicalMatch(
  leftNames: readonly { readonly raw: string }[],
  rightEntries: readonly EntityNameEntry[],
  fallbackName: string,
) {
  let score = 0;
  let matchedName = fallbackName;
  let matchedBy: 'canonical' | 'alias' = 'canonical';
  for (const entry of rightEntries) {
    for (const q of leftNames) {
      const sim = lexicalNgramDice(q.raw, entry.name);
      if (sim > score || (sim === score && entry.matchedBy === 'canonical' && matchedBy === 'alias')) {
        score = sim;
        matchedName = entry.name;
        matchedBy = entry.matchedBy;
      }
    }
  }
  return { score, matchedName, matchedBy };
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

const upsertCandidate = (map: Map<FactId, EntityResolutionCandidate>, candidate: EntityResolutionCandidate) => {
  const existing = map.get(candidate.entityId);
  if (!existing || shouldPreferCandidate(candidate, existing)) map.set(candidate.entityId, candidate);
};
const sortCandidates = (candidates: Iterable<EntityResolutionCandidate>) =>
  [...candidates].sort((l, r) => r.score - l.score || r.lexicalScore - l.lexicalScore || compareText(l.entityId, r.entityId));

function makeCandidate(
  target: ResolvableEntityInput, score: number, lexicalScore: number, embeddingScore: number | null,
  embedding: EntityEmbedding | null | undefined, matchedName: string, matchedBy: 'canonical' | 'alias',
  redirectChain: readonly FactId[], reasons: readonly string[],
): EntityResolutionCandidate {
  return {
    entityId: target.id, canonicalName: target.canonicalName, kind: target.kind, score, lexicalScore, embeddingScore,
    ...(embeddingScore !== null && embedding ? { embeddingModel: embedding.model.trim() } : {}),
    matchedName, matchedBy, redirectChain, reasons,
  };
}

/** Deterministic 3-stage entity resolution: exact link (with redirect) -> hybrid recall -> threshold decision. */
export function resolveKnowledgeEntity(
  query: ResolveKnowledgeEntityQuery,
  entities: readonly ResolvableEntityInput[],
): EntityResolutionResult {
  const normalizedQuery = normalizeKnowledgeName(query.name);
  const queryNames = [query.name, ...(query.aliases ?? [])]
    .map(raw => ({ raw, normalized: normalizeKnowledgeName(raw) }))
    .filter(item => item.normalized.length > 0);
  const queryNormalizedSet = new Set(queryNames.map(item => item.normalized));
  const requiredPurpose = query.requiredPurpose?.trim() || undefined;
  const semanticLinkThreshold = query.thresholds?.semanticLink ?? DEFAULTS.semanticLink;
  const disambiguationThreshold = query.thresholds?.disambiguation ?? DEFAULTS.disambiguation;
  const ambiguityMargin = query.thresholds?.ambiguityMargin ?? DEFAULTS.ambiguityMargin;
  const maxCandidates = Math.max(1, Math.floor(query.thresholds?.maxCandidates ?? DEFAULTS.maxCandidates));
  const weights = resolveWeights(query.thresholds?.lexicalWeight, query.thresholds?.embeddingWeight);
  const entityById = indexLatestById(entities);

  let excludedCount = 0;
  const eligibleEntries: EligibleEntry[] = [];
  for (const entry of entityById.values()) {
    if (entry.kind !== query.kind) continue;
    const redirected = followEntityRedirect(entry.id, entityById);
    if (redirected.cycleDetected || redirected.kindMismatch || !redirected.finalEntity) continue;
    const target = redirected.finalEntity;
    const chainNodes = [...redirected.redirectChain.map(hopId => entityById.get(hopId)!), target];
    if (chainNodes.some(node => isEntityRevoked(node, query.revokedIds) || !purposeAllowed(node.purpose, requiredPurpose))) {
      excludedCount += 1;
      continue;
    }
    eligibleEntries.push({ entry, target, redirectChain: redirected.redirectChain });
  }

  const makeResult = (
    decision: EntityResolutionDecision, targetId: FactId | null, score: number,
    redirectChain: readonly FactId[], candidates: readonly EntityResolutionCandidate[], reasons: readonly string[],
  ): EntityResolutionResult => ({
    decision, queryName: query.name, normalizedQuery, targetId, score, redirectChain, candidates, reasons, excludedCount,
  });

  if (!queryNormalizedSet.size) return makeResult('create_new', null, 0, [], [], ['查询名称为空，无法匹配现有实体']);

  const exactByTarget = new Map<FactId, EntityResolutionCandidate>();
  for (const { entry, target, redirectChain } of eligibleEntries) {
    const matched = entityNameEntries(entry).find(item => queryNormalizedSet.has(item.normalized));
    if (!matched) continue;
    const emb = target.embedding ?? entry.embedding;
    const embScore = cosineSimilarity(query.embedding, emb);
    const reasons = [
      `${matched.matchedBy === 'canonical' ? '规范名' : '别名'}精确命中「${matched.name}」`,
      ...(redirectChain.length ? [`已沿 merged_into 链归位至「${target.canonicalName}」`] : []),
      ...(embScore !== null && emb ? [`语义向量(${emb.model})余弦相似度 ${embScore.toFixed(3)}`] : []),
    ];
    upsertCandidate(exactByTarget, makeCandidate(
      target, 1, 1, embScore, emb, matched.name, matched.matchedBy, redirectChain, reasons,
    ));
  }
  if (exactByTarget.size === 1) {
    const [winner] = exactByTarget.values();
    return makeResult('exact_link', winner!.entityId, 1, winner!.redirectChain, [winner!], winner!.reasons);
  }
  if (exactByTarget.size > 1) {
    return makeResult('needs_agent_disambiguation', null, 1, [], sortCandidates(exactByTarget.values()).slice(0, maxCandidates),
      [`发现 ${exactByTarget.size} 个不同规范实体精确撞名，需交由上下文裁决`]);
  }

  const candidateByTarget = new Map<FactId, EntityResolutionCandidate>();
  for (const { entry, target, redirectChain } of eligibleEntries) {
    const lex = bestLexicalMatch(queryNames, entityNameEntries(entry), entry.canonicalName);
    const emb = target.embedding ?? entry.embedding;
    const embScore = cosineSimilarity(query.embedding, emb);
    const score = fuseScores(lex.score, embScore, weights);
    const reasons = [
      `${lex.matchedBy === 'canonical' ? '规范名' : '别名'}「${lex.matchedName}」字符 n-gram 相似度 ${lex.score.toFixed(3)}`,
      ...(embScore !== null && emb ? [`语义向量(${emb.model})余弦相似度 ${embScore.toFixed(3)}，融合分 ${score.toFixed(3)}`] : []),
      ...(redirectChain.length ? [`已沿 merged_into 链归位至「${target.canonicalName}」`] : []),
    ];
    upsertCandidate(candidateByTarget, makeCandidate(
      target, score, lex.score, embScore, emb, lex.matchedName, lex.matchedBy, redirectChain, reasons,
    ));
  }

  const ranked = sortCandidates(candidateByTarget.values());
  const [top1, top2] = ranked;
  const bounded = ranked.slice(0, maxCandidates);
  if (top1 && top1.score >= semanticLinkThreshold) {
    const clearWinner = !top2 || top2.score < disambiguationThreshold ||
      Math.round((top1.score - top2.score) * SCORE_SCALE) >= Math.round(ambiguityMargin * SCORE_SCALE);
    if (clearWinner) {
      return makeResult('semantic_link', top1.entityId, top1.score, top1.redirectChain, bounded,
        [...top1.reasons, `最高分 ${top1.score.toFixed(3)} >= 语义直连阈值 ${semanticLinkThreshold.toFixed(2)}`]);
    }
    return makeResult('needs_agent_disambiguation', null, top1.score, [], bounded,
      [`前两名候选得分接近（${top1.score.toFixed(3)} vs ${top2!.score.toFixed(3)}，差值 < ${ambiguityMargin.toFixed(2)}），需交由上下文裁决`]);
  }
  if (top1 && top1.score >= disambiguationThreshold) {
    return makeResult('needs_agent_disambiguation', null, top1.score, [], bounded,
      [`最高分 ${top1.score.toFixed(3)} 落在消歧区间 [${disambiguationThreshold.toFixed(2)}, ${semanticLinkThreshold.toFixed(2)})，需交由上下文裁决`]);
  }
  return makeResult('create_new', null, top1?.score ?? 0, [], bounded.filter(c => c.score > 0),
    [`最高分 ${(top1?.score ?? 0).toFixed(3)} 低于消歧阈值 ${disambiguationThreshold.toFixed(2)}，建议新建规范实体`]);
}

function chooseKeepAndMerge(left: ResolvableEntityInput, right: ResolvableEntityInput) {
  const diff = (right.referenceCount ?? 0) - (left.referenceCount ?? 0) ||
    (right.aliases?.length ?? 0) - (left.aliases?.length ?? 0) || compareText(left.id, right.id);
  return diff <= 0 ? { keep: left, merge: right } : { keep: right, merge: left };
}

/** Batch duplicate scan across sources (Notion notes, papers, textbooks). Skips redirected/revoked/out-of-purpose nodes. */
export function findDuplicateEntityCandidates(
  entities: readonly ResolvableEntityInput[],
  options: DuplicateEntityScanOptions = {},
): DuplicateEntityCandidate[] {
  const minScore = options.minScore ?? DEFAULTS.duplicateMinScore;
  const requiredPurpose = options.requiredPurpose?.trim() || undefined;
  const weights = resolveWeights(options.lexicalWeight, options.embeddingWeight);
  const allowedKinds = options.kinds ? new Set(options.kinds) : null;
  const activeByKind = new Map<KnowledgeEntityKind, ResolvableEntityInput[]>();
  for (const entity of indexLatestById(entities).values()) {
    if (entityRedirectTarget(entity) !== null || isEntityRevoked(entity, options.revokedIds)) continue;
    if (!purposeAllowed(entity.purpose, requiredPurpose) || (allowedKinds && !allowedKinds.has(entity.kind))) continue;
    pushMapValue(activeByKind, entity.kind, entity);
  }
  const duplicates: DuplicateEntityCandidate[] = [];
  for (const [kind, bucket] of activeByKind) {
    const sorted = [...bucket].sort((a, b) => compareText(a.id, b.id));
    for (let i = 0; i < sorted.length; i++) {
      const left = sorted[i]!;
      const leftEntries = entityNameEntries(left);
      const leftRaw = leftEntries.map(e => ({ raw: e.name }));
      const leftNorm = new Set(leftEntries.map(e => e.normalized));
      for (let j = i + 1; j < sorted.length; j++) {
        const right = sorted[j]!;
        const rightEntries = entityNameEntries(right);
        const exactHit = rightEntries.find(item => leftNorm.has(item.normalized));
        const lexicalScore = exactHit ? 1 : bestLexicalMatch(leftRaw, rightEntries, right.canonicalName).score;
        const embeddingScore = cosineSimilarity(left.embedding, right.embedding);
        const score = exactHit ? 1 : fuseScores(lexicalScore, embeddingScore, weights);
        if (score < minScore) continue;
        const ls = left.sourceKind?.trim() || undefined;
        const rs = right.sourceKind?.trim() || undefined;
        const sources = [...new Set([ls, rs].filter((v): v is string => Boolean(v)))].sort(compareText);
        const crossSource = Boolean(ls && rs && ls !== rs);
        const { keep, merge } = chooseKeepAndMerge(left, right);
        duplicates.push({
          pairKey: `${left.id}::${right.id}`, kind, leftId: left.id, rightId: right.id,
          leftName: left.canonicalName, rightName: right.canonicalName,
          recommendedKeepId: keep.id, recommendedMergeId: merge.id,
          score, lexicalScore, embeddingScore, crossSource, sources,
          reasons: [
            exactHit ? `规范名/别名精确碰撞「${exactHit.name}」` : `名称 n-gram 相似度 ${lexicalScore.toFixed(3)}`,
            ...(embeddingScore !== null ? [`语义向量余弦相似度 ${embeddingScore.toFixed(3)}`] : []),
            ...(crossSource ? [`跨来源重复候选（${sources.join(' / ')}）`] : []),
          ],
        });
      }
    }
  }
  return duplicates.sort((l, r) => r.score - l.score || compareText(l.pairKey, r.pairKey));
}
