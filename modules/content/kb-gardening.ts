import type { FactId, Revision } from '@mangekyo/kernel';
import {
  findDuplicateEntityCandidates,
  followEntityRedirect,
  type DuplicateEntityCandidate,
  type ResolvableEntityInput,
} from './entity-resolver.ts';
import { evolveGraphCommand } from './graph-evolution.ts';

export type KbEntityAssetInput = ResolvableEntityInput & {
  readonly sticky?: boolean;
  readonly updatedAt?: string;
};

export type KbTextbookPageInput = {
  readonly id: FactId;
  readonly title: string;
  readonly rev?: Revision;
  readonly updatedAt?: string;
  readonly purpose?: readonly string[];
  readonly sticky?: boolean;
  readonly userAuthoredBlockIds?: readonly string[];
  readonly status?: 'draft' | 'active' | 'archived';
  readonly referenceCount?: number;
  readonly referencedIds?: readonly FactId[];
  readonly conceptIds?: readonly FactId[];
};

export type KbQuestionInput = {
  readonly id: FactId;
  readonly title: string;
  readonly rev?: Revision;
  readonly updatedAt?: string;
  readonly purpose?: readonly string[];
  readonly sticky?: boolean;
  readonly status?: 'draft' | 'active';
  readonly attemptCount?: number;
  readonly referenceCount?: number;
  readonly referencedIds?: readonly FactId[];
  readonly conceptIds?: readonly FactId[];
};

export type KbEdgeInput = {
  readonly id: FactId;
  readonly kind: string;
  readonly fromId: FactId;
  readonly toId: FactId;
  readonly sticky?: boolean;
  readonly purpose?: readonly string[];
};

export type KbMistakeNoteInput = {
  readonly id: FactId;
  readonly targetId: FactId;
  readonly targetKind: 'chapter' | 'concept';
  readonly targetTitle?: string;
  readonly summary: string;
  readonly createdAt?: string;
  readonly sticky?: boolean;
  readonly purpose?: readonly string[];
};

export type KbGardeningThresholds = {
  readonly duplicateMinScore?: number;
  readonly staleDraftDays?: number;
  readonly compressionMinNotes?: number;
  readonly coarseConceptMinQuestions?: number;
};

export type KbGardeningSnapshot = {
  readonly nowIso: string;
  readonly requiredPurpose?: string;
  readonly revokedIds?: ReadonlySet<FactId>;
  readonly entities?: readonly KbEntityAssetInput[];
  readonly textbookPages?: readonly KbTextbookPageInput[];
  readonly questions?: readonly KbQuestionInput[];
  readonly edges?: readonly KbEdgeInput[];
  readonly knownLiveIds?: ReadonlySet<FactId>;
  readonly mistakeNotes?: readonly KbMistakeNoteInput[];
  readonly thresholds?: KbGardeningThresholds;
};

export type KbDanglingReferenceReason = 'missing' | 'revoked' | 'redirected_entity';

export type KbDanglingReference = {
  readonly id: string;
  readonly holderKind: 'edge' | 'textbook_page' | 'question';
  readonly holderId: FactId;
  readonly holderTitle?: string;
  readonly field: 'fromId' | 'toId' | 'referencedIds' | 'conceptIds';
  readonly targetId: FactId;
  readonly reason: KbDanglingReferenceReason;
  readonly resolvedTargetId?: FactId;
  readonly redirectChain?: readonly FactId[];
  readonly sticky: boolean;
};

export type KbStaleUnusedDraft = {
  readonly assetKind: 'textbook_page' | 'question';
  readonly assetId: FactId;
  readonly title: string;
  readonly rev?: Revision;
  readonly updatedAt?: string;
  readonly ageDays: number;
  readonly sticky: boolean;
  readonly hasUserAuthoredContent: boolean;
};

export type KbCompressionCandidate = {
  readonly candidateKey: string;
  readonly targetKind: 'chapter' | 'concept';
  readonly targetId: FactId;
  readonly targetTitle: string;
  readonly noteCount: number;
  readonly noteIds: readonly FactId[];
  readonly noteSummaries: readonly string[];
  readonly recommendedArtifact: 'emergency_card' | 'decision_tree';
  readonly hasUserAuthoredPage: boolean;
  readonly sticky: boolean;
};

export type KbCoarseConceptCandidate = {
  readonly conceptId: FactId;
  readonly title: string;
  readonly linkedQuestionCount: number;
  readonly sticky: boolean;
};

export type KbEntropyRadarReport = {
  readonly scannedAt: string;
  readonly duplicateConcepts: readonly DuplicateEntityCandidate[];
  readonly danglingReferences: readonly KbDanglingReference[];
  readonly staleUnusedDrafts: readonly KbStaleUnusedDraft[];
  readonly compressionCandidates: readonly KbCompressionCandidate[];
  readonly coarseConcepts: readonly KbCoarseConceptCandidate[];
  readonly excludedCount: number;
};

export type GardeningGreenActionKind =
  | 'repoint_redirected_reference'
  | 'archive_stale_unused_draft';

export type GardeningGreenAction = {
  readonly actionId: string;
  readonly tier: 'green';
  readonly actionKind: GardeningGreenActionKind;
  readonly targetKind: 'edge' | 'textbook_page' | 'question';
  readonly targetId: FactId;
  readonly title: string;
  readonly reason: string;
  readonly reversible: true;
  readonly undo_token: string;
  readonly preview: {
    readonly fromTargetId?: FactId;
    readonly toTargetId?: FactId;
    readonly redirectChain?: readonly FactId[];
    readonly previousStatus?: 'draft';
    readonly nextStatus?: 'archived';
  };
  readonly suggestedCommand: string;
};

export type GardeningYellowProposalKind =
  | 'merge_duplicate_concepts'
  | 'propose_emergency_card'
  | 'cleanup_dangling_reference'
  | 'propose_split_coarse_concept';

export type GardeningYellowProposal = {
  readonly proposalId: string;
  readonly tier: 'yellow';
  readonly proposalKind: GardeningYellowProposalKind;
  readonly title: string;
  readonly summary: string;
  readonly requiresApproval: true;
  readonly appendOnly?: boolean;
  readonly suggestedCommand:
    | 'content.evolveGraph'
    | 'content.createTextbookPage'
    | 'content.proposeTextbookRevision'
    | 'content.cleanupReference';
  readonly targetIds: readonly FactId[];
  readonly detail: {
    readonly keepEntityId?: FactId;
    readonly mergeEntityId?: FactId;
    readonly keepEntityName?: string;
    readonly mergeEntityName?: string;
    readonly similarityScore?: number;
    readonly crossSource?: boolean;
    readonly sources?: readonly string[];
    readonly compressionTargetKind?: 'chapter' | 'concept';
    readonly compressionTargetId?: FactId;
    readonly noteIds?: readonly FactId[];
    readonly noteCount?: number;
    readonly recommendedArtifact?: 'emergency_card' | 'decision_tree';
    readonly danglingReferenceId?: string;
    readonly danglingReason?: KbDanglingReferenceReason;
    readonly linkedQuestionCount?: number;
  };
};

export type GardeningRedRule =
  | 'sticky_protected'
  | 'user_authored_textbook_protected'
  | 'no_permanent_delete';

export type GardeningRedGuard = {
  readonly guardId: string;
  readonly tier: 'red';
  readonly rule: GardeningRedRule;
  readonly blocked: true;
  readonly assetKind: 'entity' | 'edge' | 'textbook_page' | 'question' | 'chapter';
  readonly assetId: FactId;
  readonly title: string;
  readonly blockedAction: string;
  readonly reason: string;
};

export type GardeningInboxPlan = {
  readonly generatedAt: string;
  readonly radar: KbEntropyRadarReport;
  readonly green: readonly GardeningGreenAction[];
  readonly yellow: readonly GardeningYellowProposal[];
  readonly red: readonly GardeningRedGuard[];
  readonly summary: {
    readonly greenCount: number;
    readonly yellowCount: number;
    readonly redCount: number;
    readonly duplicateConceptCount: number;
    readonly danglingReferenceCount: number;
    readonly staleUnusedDraftCount: number;
    readonly compressionCandidateCount: number;
  };
};

const MS_PER_DAY = 86_400_000;
const DEFAULT_DUPLICATE_MIN_SCORE = 0.72;
const DEFAULT_STALE_DRAFT_DAYS = 30;
const DEFAULT_COMPRESSION_MIN_NOTES = 3;
const DEFAULT_COARSE_CONCEPT_MIN_QUESTIONS = 25;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function purposeAllowed(purpose: readonly string[] | undefined, requiredPurpose: string | undefined): boolean {
  if (!requiredPurpose) return true;
  if (!purpose || purpose.length === 0) return false;
  return purpose.some(entry => {
    const trimmed = entry.trim();
    return trimmed === requiredPurpose || trimmed === 'all';
  });
}

function parseIsoMs(iso: string, label: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是合法的 ISO 时间戳。`);
  return parsed;
}

function parseOptionalIsoMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  let bucket = map.get(key);
  if (!bucket) map.set(key, bucket = new Set());
  bucket.add(value);
}

/** 0-token pure domain entropy radar over knowledge entities, textbook pages, questions, edges, and mistake notes. */
export function scanKbEntropyRadar(snapshot: KbGardeningSnapshot): KbEntropyRadarReport {
  const nowMs = parseIsoMs(snapshot.nowIso, 'nowIso');
  const requiredPurpose = snapshot.requiredPurpose?.trim() || undefined;
  const revokedIds = snapshot.revokedIds;
  const duplicateMinScore = snapshot.thresholds?.duplicateMinScore ?? DEFAULT_DUPLICATE_MIN_SCORE;
  const staleDraftDays = Math.max(1, Math.floor(snapshot.thresholds?.staleDraftDays ?? DEFAULT_STALE_DRAFT_DAYS));
  const compressionMinNotes = Math.max(1, Math.floor(snapshot.thresholds?.compressionMinNotes ?? DEFAULT_COMPRESSION_MIN_NOTES));
  const coarseConceptMinQuestions = Math.max(1, Math.floor(snapshot.thresholds?.coarseConceptMinQuestions ?? DEFAULT_COARSE_CONCEPT_MIN_QUESTIONS));

  const entityById = new Map<FactId, KbEntityAssetInput>();
  for (const entity of snapshot.entities ?? []) {
    if (!entityById.has(entity.id)) entityById.set(entity.id, entity);
  }

  const pageById = new Map<FactId, KbTextbookPageInput>();
  for (const page of snapshot.textbookPages ?? []) {
    if (!pageById.has(page.id)) pageById.set(page.id, page);
  }

  const questionById = new Map<FactId, KbQuestionInput>();
  for (const question of snapshot.questions ?? []) {
    if (!questionById.has(question.id)) questionById.set(question.id, question);
  }

  const edgeById = new Map<FactId, KbEdgeInput>();
  for (const edge of snapshot.edges ?? []) {
    if (!edgeById.has(edge.id)) edgeById.set(edge.id, edge);
  }

  const isRevoked = (id: FactId): boolean => {
    if (revokedIds?.has(id) === true) return true;
    return entityById.get(id)?.revoked === true;
  };

  let excludedCount = 0;
  for (const entity of entityById.values()) {
    if (isRevoked(entity.id) || !purposeAllowed(entity.purpose, requiredPurpose)) excludedCount += 1;
  }

  const liveIds = new Set<FactId>();
  for (const id of snapshot.knownLiveIds ?? []) {
    if (!isRevoked(id)) liveIds.add(id);
  }
  for (const entity of entityById.values()) {
    const redirectTarget = entity.merged_into ?? entity.mergedInto ?? null;
    if (redirectTarget === null && !isRevoked(entity.id)) liveIds.add(entity.id);
  }
  for (const page of pageById.values()) {
    if (!isRevoked(page.id)) liveIds.add(page.id);
  }
  for (const question of questionById.values()) {
    if (!isRevoked(question.id)) liveIds.add(question.id);
  }
  for (const edge of edgeById.values()) {
    if (!isRevoked(edge.id)) liveIds.add(edge.id);
  }

  // 1. Duplicate concepts / entities (skips redirected & revoked nodes via entity-resolver).
  const duplicateConcepts = findDuplicateEntityCandidates(snapshot.entities ?? [], {
    minScore: duplicateMinScore,
    ...(requiredPurpose !== undefined ? { requiredPurpose } : {}),
    ...(revokedIds !== undefined ? { revokedIds } : {}),
  });

  // 2. Dangling references across edges, textbook pages, and questions.
  const danglingById = new Map<string, KbDanglingReference>();
  const incomingRefCount = new Map<FactId, number>();
  const bumpIncoming = (targetId: FactId) => {
    incomingRefCount.set(targetId, (incomingRefCount.get(targetId) ?? 0) + 1);
  };

  const inspectReference = (params: {
    readonly holderKind: 'edge' | 'textbook_page' | 'question';
    readonly holderId: FactId;
    readonly holderTitle?: string;
    readonly field: 'fromId' | 'toId' | 'referencedIds' | 'conceptIds';
    readonly targetId: FactId;
    readonly sticky: boolean;
  }) => {
    bumpIncoming(params.targetId);
    const id = `${params.holderKind}:${params.holderId}:${params.field}:${params.targetId}`;
    if (danglingById.has(id)) return;

    const targetEntity = entityById.get(params.targetId);
    const hasRedirect = targetEntity !== undefined && (targetEntity.merged_into ?? targetEntity.mergedInto ?? null) !== null;
    if (hasRedirect) {
      const resolved = followEntityRedirect(params.targetId, entityById);
      if (resolved.finalId !== null && resolved.finalEntity && !isRevoked(resolved.finalId) && purposeAllowed(resolved.finalEntity.purpose, requiredPurpose)) {
        danglingById.set(id, {
          id,
          holderKind: params.holderKind,
          holderId: params.holderId,
          ...(params.holderTitle !== undefined ? { holderTitle: params.holderTitle } : {}),
          field: params.field,
          targetId: params.targetId,
          reason: 'redirected_entity',
          resolvedTargetId: resolved.finalId,
          redirectChain: resolved.redirectChain,
          sticky: params.sticky,
        });
        return;
      }
      const reason: KbDanglingReferenceReason = resolved.finalId !== null && isRevoked(resolved.finalId) ? 'revoked' : 'missing';
      danglingById.set(id, {
        id,
        holderKind: params.holderKind,
        holderId: params.holderId,
        ...(params.holderTitle !== undefined ? { holderTitle: params.holderTitle } : {}),
        field: params.field,
        targetId: params.targetId,
        reason,
        sticky: params.sticky,
      });
      return;
    }

    if (isRevoked(params.targetId)) {
      danglingById.set(id, {
        id,
        holderKind: params.holderKind,
        holderId: params.holderId,
        ...(params.holderTitle !== undefined ? { holderTitle: params.holderTitle } : {}),
        field: params.field,
        targetId: params.targetId,
        reason: 'revoked',
        sticky: params.sticky,
      });
      return;
    }

    if (!liveIds.has(params.targetId)) {
      danglingById.set(id, {
        id,
        holderKind: params.holderKind,
        holderId: params.holderId,
        ...(params.holderTitle !== undefined ? { holderTitle: params.holderTitle } : {}),
        field: params.field,
        targetId: params.targetId,
        reason: 'missing',
        sticky: params.sticky,
      });
    }
  };

  const conceptQuestionIds = new Map<FactId, Set<FactId>>();

  for (const edge of edgeById.values()) {
    if (isRevoked(edge.id) || !purposeAllowed(edge.purpose, requiredPurpose)) {
      excludedCount += 1;
      continue;
    }
    const sticky = edge.sticky === true;
    const holderTitle = `${edge.kind} (${edge.id})`;
    inspectReference({ holderKind: 'edge', holderId: edge.id, holderTitle, field: 'fromId', targetId: edge.fromId, sticky });
    inspectReference({ holderKind: 'edge', holderId: edge.id, holderTitle, field: 'toId', targetId: edge.toId, sticky });
    if (edge.kind === 'targets_concept' && !isRevoked(edge.fromId) && !isRevoked(edge.toId)) {
      const targetEntity = entityById.get(edge.toId);
      if (targetEntity?.kind === 'concept' && (targetEntity.merged_into ?? targetEntity.mergedInto ?? null) === null) {
        addSetValue(conceptQuestionIds, edge.toId, edge.fromId);
      }
    }
  }

  for (const page of pageById.values()) {
    if (isRevoked(page.id) || !purposeAllowed(page.purpose, requiredPurpose)) {
      excludedCount += 1;
      continue;
    }
    if (page.status === 'archived') continue;
    const sticky = page.sticky === true;
    for (const refId of page.referencedIds ?? []) {
      inspectReference({ holderKind: 'textbook_page', holderId: page.id, holderTitle: page.title, field: 'referencedIds', targetId: refId, sticky });
    }
    for (const conceptId of page.conceptIds ?? []) {
      inspectReference({ holderKind: 'textbook_page', holderId: page.id, holderTitle: page.title, field: 'conceptIds', targetId: conceptId, sticky });
    }
  }

  for (const question of questionById.values()) {
    if (isRevoked(question.id) || !purposeAllowed(question.purpose, requiredPurpose)) {
      excludedCount += 1;
      continue;
    }
    const sticky = question.sticky === true;
    for (const refId of question.referencedIds ?? []) {
      inspectReference({ holderKind: 'question', holderId: question.id, holderTitle: question.title, field: 'referencedIds', targetId: refId, sticky });
    }
    for (const conceptId of question.conceptIds ?? []) {
      inspectReference({ holderKind: 'question', holderId: question.id, holderTitle: question.title, field: 'conceptIds', targetId: conceptId, sticky });
      const targetEntity = entityById.get(conceptId);
      if (targetEntity?.kind === 'concept' && !isRevoked(conceptId) && (targetEntity.merged_into ?? targetEntity.mergedInto ?? null) === null) {
        addSetValue(conceptQuestionIds, conceptId, question.id);
      }
    }
  }

  const danglingReferences = [...danglingById.values()].sort((left, right) => compareText(left.id, right.id));

  // 3. Stale unused drafts (status === 'draft', age >= staleDraftDays, referenceCount === 0, attemptCount === 0).
  const staleUnusedDrafts: KbStaleUnusedDraft[] = [];
  for (const page of pageById.values()) {
    if (isRevoked(page.id) || !purposeAllowed(page.purpose, requiredPurpose)) continue;
    if (page.status !== 'draft') continue;
    const refCount = page.referenceCount ?? (incomingRefCount.get(page.id) ?? 0);
    if (refCount > 0) continue;
    const updatedMs = parseOptionalIsoMs(page.updatedAt);
    if (updatedMs === null || nowMs - updatedMs < staleDraftDays * MS_PER_DAY) continue;
    const ageDays = Math.floor((nowMs - updatedMs) / MS_PER_DAY);
    const hasUserAuthoredContent = (page.userAuthoredBlockIds?.length ?? 0) > 0;
    staleUnusedDrafts.push({
      assetKind: 'textbook_page',
      assetId: page.id,
      title: page.title,
      ...(page.rev !== undefined ? { rev: page.rev } : {}),
      ...(page.updatedAt !== undefined ? { updatedAt: page.updatedAt } : {}),
      ageDays,
      sticky: page.sticky === true,
      hasUserAuthoredContent,
    });
  }

  for (const question of questionById.values()) {
    if (isRevoked(question.id) || !purposeAllowed(question.purpose, requiredPurpose)) continue;
    if (question.status !== 'draft') continue;
    const refCount = question.referenceCount ?? (incomingRefCount.get(question.id) ?? 0);
    const attemptCount = question.attemptCount ?? 0;
    if (refCount > 0 || attemptCount > 0) continue;
    const updatedMs = parseOptionalIsoMs(question.updatedAt);
    if (updatedMs === null || nowMs - updatedMs < staleDraftDays * MS_PER_DAY) continue;
    const ageDays = Math.floor((nowMs - updatedMs) / MS_PER_DAY);
    staleUnusedDrafts.push({
      assetKind: 'question',
      assetId: question.id,
      title: question.title,
      ...(question.rev !== undefined ? { rev: question.rev } : {}),
      ...(question.updatedAt !== undefined ? { updatedAt: question.updatedAt } : {}),
      ageDays,
      sticky: question.sticky === true,
      hasUserAuthoredContent: false,
    });
  }
  staleUnusedDrafts.sort((left, right) =>
    right.ageDays - left.ageDays ||
    compareText(left.assetKind, right.assetKind) ||
    compareText(left.assetId, right.assetId));

  // 4. Compression candidates (accumulated mistakeNotes) & coarse concept split signals.
  const notesByTarget = new Map<string, KbMistakeNoteInput[]>();
  const seenNoteIds = new Set<FactId>();
  for (const note of snapshot.mistakeNotes ?? []) {
    if (seenNoteIds.has(note.id)) continue;
    seenNoteIds.add(note.id);
    if (isRevoked(note.id) || isRevoked(note.targetId) || !purposeAllowed(note.purpose, requiredPurpose)) {
      excludedCount += 1;
      continue;
    }
    const groupKey = `${note.targetKind}:${note.targetId}`;
    let bucket = notesByTarget.get(groupKey);
    if (!bucket) notesByTarget.set(groupKey, bucket = []);
    bucket.push(note);
  }

  const compressionCandidates: KbCompressionCandidate[] = [];
  for (const [candidateKey, notes] of notesByTarget) {
    if (notes.length < compressionMinNotes) continue;
    const sortedNotes = [...notes].sort((left, right) => compareText(left.id, right.id));
    const first = sortedNotes[0]!;
    const targetPage = pageById.get(first.targetId);
    const targetEntity = entityById.get(first.targetId);
    const targetTitle = first.targetTitle?.trim() || targetPage?.title || targetEntity?.canonicalName || first.targetId;
    let hasUserAuthoredPage = (targetPage?.userAuthoredBlockIds?.length ?? 0) > 0;
    if (!hasUserAuthoredPage && first.targetKind === 'concept') {
      for (const page of pageById.values()) {
        if (isRevoked(page.id) || page.status === 'archived') continue;
        if ((page.conceptIds ?? []).includes(first.targetId) && (page.userAuthoredBlockIds?.length ?? 0) > 0) {
          hasUserAuthoredPage = true;
          break;
        }
      }
    }
    const sticky = targetPage?.sticky === true || targetEntity?.sticky === true || sortedNotes.some(note => note.sticky === true);
    const recommendedArtifact: 'emergency_card' | 'decision_tree' =
      first.targetKind === 'concept' && sortedNotes.length >= 5 ? 'decision_tree' : 'emergency_card';
    compressionCandidates.push({
      candidateKey,
      targetKind: first.targetKind,
      targetId: first.targetId,
      targetTitle,
      noteCount: sortedNotes.length,
      noteIds: sortedNotes.map(note => note.id),
      noteSummaries: sortedNotes.map(note => note.summary),
      recommendedArtifact,
      hasUserAuthoredPage,
      sticky,
    });
  }
  compressionCandidates.sort((left, right) =>
    right.noteCount - left.noteCount || compareText(left.candidateKey, right.candidateKey));

  const coarseConcepts: KbCoarseConceptCandidate[] = [];
  for (const [conceptId, linkedQuestions] of conceptQuestionIds) {
    if (linkedQuestions.size < coarseConceptMinQuestions) continue;
    const concept = entityById.get(conceptId);
    if (!concept || !purposeAllowed(concept.purpose, requiredPurpose)) continue;
    coarseConcepts.push({
      conceptId,
      title: concept.canonicalName,
      linkedQuestionCount: linkedQuestions.size,
      sticky: concept.sticky === true,
    });
  }
  coarseConcepts.sort((left, right) =>
    right.linkedQuestionCount - left.linkedQuestionCount || compareText(left.conceptId, right.conceptId));

  return {
    scannedAt: snapshot.nowIso,
    duplicateConcepts,
    danglingReferences,
    staleUnusedDrafts,
    compressionCandidates,
    coarseConcepts,
    excludedCount,
  };
}

/** Build deterministic green/yellow/red autonomy gardening plan from snapshot with strict sticky & user-textbook guardrails. */
export function buildKbGardeningPlan(snapshot: KbGardeningSnapshot): GardeningInboxPlan {
  const radar = scanKbEntropyRadar(snapshot);
  const entityById = new Map<FactId, KbEntityAssetInput>();
  for (const entity of snapshot.entities ?? []) {
    if (!entityById.has(entity.id)) entityById.set(entity.id, entity);
  }

  const green: GardeningGreenAction[] = [];
  const yellow: GardeningYellowProposal[] = [];
  const red: GardeningRedGuard[] = [];

  // 1. Duplicate concepts -> yellow merge proposal or red sticky protection.
  for (const dup of radar.duplicateConcepts) {
    const mergeEntity = entityById.get(dup.recommendedMergeId);
    const keepEntity = entityById.get(dup.recommendedKeepId);
    const mergeName = dup.recommendedMergeId === dup.leftId ? dup.leftName : dup.rightName;
    const keepName = dup.recommendedKeepId === dup.leftId ? dup.leftName : dup.rightName;
    if (mergeEntity?.sticky === true) {
      red.push({
        guardId: `red:sticky_merge:${dup.pairKey}`,
        tier: 'red',
        rule: 'sticky_protected',
        blocked: true,
        assetKind: 'entity',
        assetId: dup.recommendedMergeId,
        title: mergeName,
        blockedAction: 'merge_duplicate_concepts',
        reason: `重复概念候选「${mergeName}」已设置 sticky 保护，严禁自动或批量合出`,
      });
      continue;
    }
    yellow.push({
      proposalId: `yellow:merge:${dup.pairKey}`,
      tier: 'yellow',
      proposalKind: 'merge_duplicate_concepts',
      title: `合并重复概念：「${mergeName}」→「${keepName}」`,
      summary: `检测到跨源/同源重复${dup.kind}（相似度 ${dup.score.toFixed(3)}），建议将「${mergeName}」并入「${keepName}」${keepEntity?.sticky === true ? '（保留侧已置顶保护）' : ''}`,
      requiresApproval: true,
      suggestedCommand: evolveGraphCommand,
      targetIds: [dup.recommendedMergeId, dup.recommendedKeepId],
      detail: {
        keepEntityId: dup.recommendedKeepId,
        mergeEntityId: dup.recommendedMergeId,
        keepEntityName: keepName,
        mergeEntityName: mergeName,
        similarityScore: dup.score,
        crossSource: dup.crossSource,
        sources: dup.sources,
      },
    });
  }

  // 2. Dangling references -> green reversible repoint, yellow cleanup, or red sticky protection.
  for (const finding of radar.danglingReferences) {
    const holderTitle = finding.holderTitle ?? `${finding.holderKind}:${finding.holderId}`;
    if (finding.sticky) {
      red.push({
        guardId: `red:sticky_ref:${finding.id}`,
        tier: 'red',
        rule: 'sticky_protected',
        blocked: true,
        assetKind: finding.holderKind,
        assetId: finding.holderId,
        title: holderTitle,
        blockedAction: finding.reason === 'redirected_entity' ? 'repoint_redirected_reference' : 'cleanup_dangling_reference',
        reason: `来源对象「${holderTitle}」已设置 sticky 保护，严禁自动改写或清理其引用`,
      });
      continue;
    }
    if (finding.reason === 'redirected_entity' && finding.resolvedTargetId !== undefined) {
      green.push({
        actionId: `green:repoint:${finding.id}`,
        tier: 'green',
        actionKind: 'repoint_redirected_reference',
        targetKind: finding.holderKind,
        targetId: finding.holderId,
        title: `改指已合并引用：${holderTitle}`,
        reason: `${finding.holderKind} ${finding.holderId}.${finding.field} 指向已合并实体 ${finding.targetId}，可安全可逆改指至 ${finding.resolvedTargetId}`,
        reversible: true,
        undo_token: `undo:kb-garden:repoint_redirected_reference:${finding.holderKind}:${finding.holderId}:${finding.field}:${finding.targetId}->${finding.resolvedTargetId}`,
        preview: {
          fromTargetId: finding.targetId,
          toTargetId: finding.resolvedTargetId,
          ...(finding.redirectChain !== undefined ? { redirectChain: finding.redirectChain } : {}),
        },
        suggestedCommand: 'content.repointReference',
      });
      continue;
    }
    yellow.push({
      proposalId: `yellow:dangling:${finding.id}`,
      tier: 'yellow',
      proposalKind: 'cleanup_dangling_reference',
      title: `清理悬空引用：${holderTitle}`,
      summary: `${finding.holderKind} ${finding.holderId}.${finding.field} 指向${finding.reason === 'revoked' ? '已撤权' : '不存在的'}目标 ${finding.targetId}，待人工确认清理`,
      requiresApproval: true,
      suggestedCommand: 'content.cleanupReference',
      targetIds: [finding.holderId, finding.targetId],
      detail: {
        danglingReferenceId: finding.id,
        danglingReason: finding.reason,
      },
    });
  }

  // 3. Stale unused drafts -> green reversible archive (never permanent delete) or red guardrails.
  for (const draft of radar.staleUnusedDrafts) {
    if (draft.sticky) {
      red.push({
        guardId: `red:sticky_draft:${draft.assetKind}:${draft.assetId}`,
        tier: 'red',
        rule: 'sticky_protected',
        blocked: true,
        assetKind: draft.assetKind,
        assetId: draft.assetId,
        title: draft.title,
        blockedAction: 'archive_stale_unused_draft',
        reason: `草稿「${draft.title}」已设置 sticky 保护，严禁自动归档`,
      });
    }
    if (draft.hasUserAuthoredContent) {
      red.push({
        guardId: `red:user_textbook_draft:${draft.assetKind}:${draft.assetId}`,
        tier: 'red',
        rule: 'user_authored_textbook_protected',
        blocked: true,
        assetKind: draft.assetKind,
        assetId: draft.assetId,
        title: draft.title,
        blockedAction: 'archive_stale_unused_draft',
        reason: `草稿教材页「${draft.title}」包含用户原创正文块，严禁自动归档或覆写`,
      });
    }
    if (!draft.sticky && !draft.hasUserAuthoredContent) {
      green.push({
        actionId: `green:archive_draft:${draft.assetKind}:${draft.assetId}`,
        tier: 'green',
        actionKind: 'archive_stale_unused_draft',
        targetKind: draft.assetKind,
        targetId: draft.assetId,
        title: `归档闲置草稿：${draft.title}`,
        reason: `草稿「${draft.title}」已闲置 ${draft.ageDays} 天且零引用、零作答，可逆归档（非永久删除）`,
        reversible: true,
        undo_token: `undo:kb-garden:archive_stale_unused_draft:${draft.assetKind}:${draft.assetId}:${draft.rev ?? 'draft'}`,
        preview: {
          previousStatus: 'draft',
          nextStatus: 'archived',
        },
        suggestedCommand: 'content.archiveDraft',
      });
    }
  }

  // 4. Compression candidates -> yellow append-only emergency card (+ explicit red guardrails for user-authored/sticky pages).
  for (const candidate of radar.compressionCandidates) {
    yellow.push({
      proposalId: `yellow:emergency_card:${candidate.candidateKey}`,
      tier: 'yellow',
      proposalKind: 'propose_emergency_card',
      title: `生成伴生${candidate.recommendedArtifact === 'decision_tree' ? '决策树' : '考前 3 分钟急救卡'}：${candidate.targetTitle}`,
      summary: `「${candidate.targetTitle}」已累计 ${candidate.noteCount} 条错题/避坑备注，建议追加伴生急救卡（仅追加，不覆写用户教材正文）`,
      requiresApproval: true,
      appendOnly: true,
      suggestedCommand: 'content.createTextbookPage',
      targetIds: [candidate.targetId, ...candidate.noteIds],
      detail: {
        compressionTargetKind: candidate.targetKind,
        compressionTargetId: candidate.targetId,
        noteIds: candidate.noteIds,
        noteCount: candidate.noteCount,
        recommendedArtifact: candidate.recommendedArtifact,
      },
    });
    const guardAssetKind: GardeningRedGuard['assetKind'] = candidate.targetKind === 'chapter' ? 'chapter' : 'entity';
    if (candidate.hasUserAuthoredPage) {
      red.push({
        guardId: `red:user_textbook_compress:${candidate.candidateKey}`,
        tier: 'red',
        rule: 'user_authored_textbook_protected',
        blocked: true,
        assetKind: guardAssetKind,
        assetId: candidate.targetId,
        title: candidate.targetTitle,
        blockedAction: 'overwrite_user_authored_textbook',
        reason: `「${candidate.targetTitle}」包含用户原创教材正文，严禁覆写原文，仅允许通过待审清单生成伴生急救卡`,
      });
    }
    if (candidate.sticky) {
      red.push({
        guardId: `red:sticky_compress:${candidate.candidateKey}`,
        tier: 'red',
        rule: 'sticky_protected',
        blocked: true,
        assetKind: guardAssetKind,
        assetId: candidate.targetId,
        title: candidate.targetTitle,
        blockedAction: 'overwrite_sticky_target',
        reason: `「${candidate.targetTitle}」已设置 sticky 保护，严禁自动修改原文，仅允许人工审批伴生急救卡`,
      });
    }
  }

  // 5. Coarse concept split signals -> yellow split proposal or red sticky protection.
  for (const coarse of radar.coarseConcepts) {
    if (coarse.sticky) {
      red.push({
        guardId: `red:sticky_coarse:${coarse.conceptId}`,
        tier: 'red',
        rule: 'sticky_protected',
        blocked: true,
        assetKind: 'entity',
        assetId: coarse.conceptId,
        title: coarse.title,
        blockedAction: 'propose_split_coarse_concept',
        reason: `粗粒度概念「${coarse.title}」已设置 sticky 保护，严禁自动拆解`,
      });
      continue;
    }
    yellow.push({
      proposalId: `yellow:split_concept:${coarse.conceptId}`,
      tier: 'yellow',
      proposalKind: 'propose_split_coarse_concept',
      title: `拆分粗粒度概念：${coarse.title}`,
      summary: `概念「${coarse.title}」已挂载 ${coarse.linkedQuestionCount} 道题目，建议拆分为更细粒度子概念`,
      requiresApproval: true,
      suggestedCommand: evolveGraphCommand,
      targetIds: [coarse.conceptId],
      detail: {
        linkedQuestionCount: coarse.linkedQuestionCount,
      },
    });
  }

  return {
    generatedAt: snapshot.nowIso,
    radar,
    green,
    yellow,
    red,
    summary: {
      greenCount: green.length,
      yellowCount: yellow.length,
      redCount: red.length,
      duplicateConceptCount: radar.duplicateConcepts.length,
      danglingReferenceCount: radar.danglingReferences.length,
      staleUnusedDraftCount: radar.staleUnusedDrafts.length,
      compressionCandidateCount: radar.compressionCandidates.length,
    },
  };
}
