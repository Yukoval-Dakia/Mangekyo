import type {
  FactId, KbDanglingReferenceWire, KbEntropyRadarWire, KbGardeningDuplicateTargetIdsWire,
  KbGardeningPlanWire, KbStaleUnusedDraftWire, Revision,
} from '@mangekyo/kernel';
import {
  addSetValue, compareText, entityRedirectTarget, indexLatestById, parseIsoMs, parseOptionalIsoMs, purposeAllowed,
} from './content-guard.ts';
import {
  findDuplicateEntityCandidates, followEntityRedirect,
  type DuplicateEntityCandidate, type ResolvableEntityInput,
} from './entity-resolver.ts';
import { evolveGraphCommand } from './graph-evolution.ts';

export type KbEntityAssetInput = ResolvableEntityInput & { readonly sticky?: boolean; readonly updatedAt?: string };
export type KbTextbookPageInput = {
  readonly id: FactId; readonly title: string; readonly rev?: Revision; readonly updatedAt?: string;
  readonly purpose?: readonly string[]; readonly sticky?: boolean; readonly userAuthoredBlockIds?: readonly string[];
  readonly status?: 'draft' | 'active' | 'archived'; readonly referenceCount?: number;
  readonly referencedIds?: readonly FactId[]; readonly conceptIds?: readonly FactId[];
};
export type KbQuestionInput = {
  readonly id: FactId; readonly title: string; readonly rev?: Revision; readonly updatedAt?: string;
  readonly purpose?: readonly string[]; readonly sticky?: boolean; readonly status?: 'draft' | 'active';
  readonly attemptCount?: number; readonly referenceCount?: number;
  readonly referencedIds?: readonly FactId[]; readonly conceptIds?: readonly FactId[];
};
export type KbEdgeInput = {
  readonly id: FactId; readonly kind: string; readonly fromId: FactId; readonly toId: FactId;
  readonly sticky?: boolean; readonly purpose?: readonly string[];
};
export type KbMistakeNoteInput = {
  readonly id: FactId; readonly targetId: FactId; readonly targetKind: 'chapter' | 'concept';
  readonly targetTitle?: string; readonly summary: string; readonly createdAt?: string;
  readonly sticky?: boolean; readonly purpose?: readonly string[];
};
export type KbGardeningThresholds = {
  readonly duplicateMinScore?: number; readonly staleDraftDays?: number;
  readonly compressionMinNotes?: number; readonly coarseConceptMinQuestions?: number;
};
export type KbGardeningSnapshot = {
  readonly nowIso: string; readonly requiredPurpose?: string; readonly revokedIds?: ReadonlySet<FactId>;
  readonly entities?: readonly KbEntityAssetInput[]; readonly textbookPages?: readonly KbTextbookPageInput[];
  readonly questions?: readonly KbQuestionInput[]; readonly edges?: readonly KbEdgeInput[];
  readonly knownLiveIds?: ReadonlySet<FactId>; readonly mistakeNotes?: readonly KbMistakeNoteInput[];
  readonly thresholds?: KbGardeningThresholds;
};
export type KbDanglingReferenceReason = KbDanglingReferenceWire['reason'];
export type KbDanglingReference = Omit<KbDanglingReferenceWire, 'holderId' | 'targetId' | 'resolvedTargetId' | 'redirectChain'> & {
  readonly holderId: FactId; readonly targetId: FactId; readonly resolvedTargetId?: FactId; readonly redirectChain?: readonly FactId[];
};
export type KbStaleUnusedDraft = Omit<KbStaleUnusedDraftWire, 'assetId' | 'rev'> & {
  readonly assetId: FactId; readonly rev?: Revision;
};
export type KbCompressionCandidate = {
  readonly candidateKey: string; readonly targetKind: 'chapter' | 'concept'; readonly targetId: FactId;
  readonly targetTitle: string; readonly noteCount: number; readonly noteIds: readonly FactId[];
  readonly noteSummaries: readonly string[]; readonly recommendedArtifact: 'emergency_card' | 'decision_tree';
  readonly hasUserAuthoredPage: boolean; readonly sticky: boolean;
};
export type KbCoarseConceptCandidate = {
  readonly conceptId: FactId; readonly title: string; readonly linkedQuestionCount: number; readonly sticky: boolean;
};
export type KbEntropyRadarReport = Omit<KbEntropyRadarWire, 'duplicateConcepts' | 'danglingReferences' | 'staleUnusedDrafts' | 'compressionCandidates' | 'coarseConcepts'> & {
  readonly duplicateConcepts: readonly DuplicateEntityCandidate[];
  readonly danglingReferences: readonly KbDanglingReference[]; readonly staleUnusedDrafts: readonly KbStaleUnusedDraft[];
  readonly compressionCandidates: readonly KbCompressionCandidate[]; readonly coarseConcepts: readonly KbCoarseConceptCandidate[];
  /** Opaque ids of excluded revoked rows (never titles or bodies) so dangling diagnostics stay explainable. */
  readonly revokedIds?: readonly FactId[];
};
export type GardeningGreenActionKind = 'repoint_redirected_reference' | 'archive_stale_unused_draft';
export type GardeningGreenAction = {
  readonly actionId: string; readonly tier: 'green'; readonly actionKind: GardeningGreenActionKind;
  readonly targetKind: 'edge' | 'textbook_page' | 'question'; readonly targetId: FactId;
  readonly title: string; readonly reason: string; readonly reversible: true; readonly undo_token: string;
  readonly preview: {
    readonly fromTargetId?: FactId; readonly toTargetId?: FactId; readonly redirectChain?: readonly FactId[];
    readonly previousStatus?: 'draft'; readonly nextStatus?: 'archived';
  };
  readonly suggestedCommand: string;
};
export type GardeningYellowProposalKind =
  | 'merge_duplicate_concepts' | 'propose_emergency_card' | 'cleanup_dangling_reference' | 'propose_split_coarse_concept';
export type GardeningYellowProposal = {
  readonly proposalId: string; readonly tier: 'yellow'; readonly proposalKind: GardeningYellowProposalKind;
  readonly title: string; readonly summary: string; readonly requiresApproval: true; readonly appendOnly?: boolean;
  readonly suggestedCommand:
    | 'content.evolveGraph' | 'content.createTextbookPage' | 'content.proposeTextbookRevision' | 'content.cleanupReference';
  readonly targetIds: readonly FactId[];
  readonly detail: {
    readonly keepEntityId?: FactId; readonly mergeEntityId?: FactId;
    readonly keepEntityName?: string; readonly mergeEntityName?: string;
    readonly similarityScore?: number; readonly crossSource?: boolean; readonly sources?: readonly string[];
    readonly compressionTargetKind?: 'chapter' | 'concept'; readonly compressionTargetId?: FactId;
    readonly noteIds?: readonly FactId[]; readonly noteCount?: number;
    readonly recommendedArtifact?: 'emergency_card' | 'decision_tree';
    readonly danglingReferenceId?: string; readonly danglingReason?: KbDanglingReferenceReason;
    readonly linkedQuestionCount?: number;
  };
};
export type KbGardeningDuplicateTargetIds = KbGardeningDuplicateTargetIdsWire &
  readonly [mergeTargetId: FactId, keepTargetId: FactId];
export type GardeningRedRule = 'sticky_protected' | 'user_authored_textbook_protected' | 'no_permanent_delete';
export type GardeningRedGuard = {
  readonly guardId: string; readonly tier: 'red'; readonly rule: GardeningRedRule; readonly blocked: true;
  readonly assetKind: 'entity' | 'edge' | 'textbook_page' | 'question' | 'chapter';
  readonly assetId: FactId; readonly title: string; readonly blockedAction: string; readonly reason: string;
};
export type GardeningInboxPlan = Omit<KbGardeningPlanWire, 'radar' | 'green' | 'yellow' | 'red'> & {
  readonly radar: KbEntropyRadarReport; readonly green: readonly GardeningGreenAction[];
  readonly yellow: readonly GardeningYellowProposal[]; readonly red: readonly GardeningRedGuard[];
};

type NoteGroup = { readonly targetKind: 'chapter' | 'concept'; readonly targetId: FactId; readonly notes: KbMistakeNoteInput[] };
const MS_PER_DAY = 86_400_000;
const DEFAULTS = { duplicateMinScore: 0.72, staleDraftDays: 30, compressionMinNotes: 3, coarseConceptMinQuestions: 25 } as const;

/** 0-token pure domain entropy radar over knowledge entities, textbook pages, questions, edges, and mistake notes. */
export function scanKbEntropyRadar(snapshot: KbGardeningSnapshot): KbEntropyRadarReport {
  const nowMs = parseIsoMs(snapshot.nowIso, 'nowIso');
  const requiredPurpose = snapshot.requiredPurpose?.trim() || undefined;
  const revokedIds = snapshot.revokedIds;
  const duplicateMinScore = snapshot.thresholds?.duplicateMinScore ?? DEFAULTS.duplicateMinScore;
  const staleDraftDays = Math.max(1, Math.floor(snapshot.thresholds?.staleDraftDays ?? DEFAULTS.staleDraftDays));
  const compressionMinNotes = Math.max(1, Math.floor(snapshot.thresholds?.compressionMinNotes ?? DEFAULTS.compressionMinNotes));
  const coarseMin = Math.max(1, Math.floor(snapshot.thresholds?.coarseConceptMinQuestions ?? DEFAULTS.coarseConceptMinQuestions));

  const entityById = indexLatestById(snapshot.entities);
  const pageById = indexLatestById(snapshot.textbookPages);
  const questionById = indexLatestById(snapshot.questions);
  const edgeById = indexLatestById(snapshot.edges);
  const isRevoked = (id: FactId): boolean => revokedIds?.has(id) === true || entityById.get(id)?.revoked === true;

  let excludedCount = 0;
  for (const e of entityById.values()) if (isRevoked(e.id) || !purposeAllowed(e.purpose, requiredPurpose)) excludedCount += 1;

  const liveIds = new Set<FactId>();
  const addLive = (id: FactId) => { if (!isRevoked(id)) liveIds.add(id); };
  for (const id of snapshot.knownLiveIds ?? []) addLive(id);
  for (const e of entityById.values()) if (entityRedirectTarget(e) === null) addLive(e.id);
  for (const item of [...pageById.values(), ...questionById.values(), ...edgeById.values()]) addLive(item.id);

  const duplicateConcepts = findDuplicateEntityCandidates(snapshot.entities ?? [], {
    minScore: duplicateMinScore,
    ...(requiredPurpose !== undefined ? { requiredPurpose } : {}),
    ...(revokedIds !== undefined ? { revokedIds } : {}),
  });

  // Count incoming refs across all non-revoked assets regardless of purpose so cross-purpose refs block archive.
  const incomingRefCount = new Map<FactId, number>();
  const bump = (ids: Iterable<FactId> | undefined) => {
    for (const id of ids ?? []) incomingRefCount.set(id, (incomingRefCount.get(id) ?? 0) + 1);
  };
  for (const edge of edgeById.values()) if (!isRevoked(edge.id)) bump([edge.fromId, edge.toId]);
  for (const page of pageById.values()) {
    if (!isRevoked(page.id) && page.status !== 'archived') { bump(page.referencedIds); bump(page.conceptIds); }
  }
  for (const q of questionById.values()) if (!isRevoked(q.id)) { bump(q.referencedIds); bump(q.conceptIds); }

  const resolveAuthorizedRedirect = (startId: FactId) => {
    const resolved = followEntityRedirect(startId, entityById);
    const chainIds = [...resolved.redirectChain, ...(resolved.finalId !== null ? [resolved.finalId] : [])];
    const anyRevoked = chainIds.some(isRevoked) ||
      (resolved.missingTargetId !== undefined && isRevoked(resolved.missingTargetId));
    const allAuthorized = resolved.finalId !== null && resolved.finalEntity !== null && !anyRevoked &&
      chainIds.every(id => purposeAllowed(entityById.get(id)?.purpose, requiredPurpose));
    return { resolved, anyRevoked, allAuthorized };
  };

  const danglingById = new Map<string, KbDanglingReference>();
  const inspectReference = (
    holderKind: KbDanglingReference['holderKind'], holderId: FactId, holderTitle: string | undefined,
    field: KbDanglingReference['field'], targetId: FactId, sticky: boolean, hasUserAuthoredContent = false,
  ) => {
    const id = `${holderKind}:${holderId}:${field}:${targetId}`;
    if (danglingById.has(id)) return;
    const record = (reason: KbDanglingReferenceReason, resolvedTargetId?: FactId, redirectChain?: readonly FactId[]) => {
      danglingById.set(id, {
        id, holderKind, holderId, field, targetId, reason, sticky,
        ...(holderTitle !== undefined ? { holderTitle } : {}),
        ...(resolvedTargetId !== undefined ? { resolvedTargetId } : {}),
        ...(redirectChain !== undefined ? { redirectChain } : {}),
        ...(hasUserAuthoredContent ? { hasUserAuthoredContent: true } : {}),
      });
    };
    if (isRevoked(targetId)) { record('revoked'); return; }
    const targetEntity = entityById.get(targetId);
    if (targetEntity !== undefined && entityRedirectTarget(targetEntity) !== null) {
      const { resolved, anyRevoked, allAuthorized } = resolveAuthorizedRedirect(targetId);
      if (allAuthorized && resolved.finalId !== null) record('redirected_entity', resolved.finalId, resolved.redirectChain);
      else record(anyRevoked ? 'revoked' : 'missing');
      return;
    }
    if (!liveIds.has(targetId)) record('missing');
  };
  const inspectList = (
    kind: 'textbook_page' | 'question', id: FactId, title: string, field: 'referencedIds' | 'conceptIds',
    targets: readonly FactId[] | undefined, sticky: boolean, userAuthored = false,
  ) => {
    for (const targetId of targets ?? []) inspectReference(kind, id, title, field, targetId, sticky, userAuthored);
  };

  const conceptQuestionIds = new Map<FactId, Set<FactId>>();
  const recordConceptQuestion = (conceptId: FactId, questionId: FactId) => {
    const target = entityById.get(conceptId);
    if (target?.kind === 'concept' && !isRevoked(conceptId) && entityRedirectTarget(target) === null) {
      addSetValue(conceptQuestionIds, conceptId, questionId);
    }
  };
  for (const edge of edgeById.values()) {
    if (isRevoked(edge.id) || !purposeAllowed(edge.purpose, requiredPurpose)) { excludedCount += 1; continue; }
    const title = `${edge.kind} (${edge.id})`;
    inspectReference('edge', edge.id, title, 'fromId', edge.fromId, edge.sticky === true);
    inspectReference('edge', edge.id, title, 'toId', edge.toId, edge.sticky === true);
    if (edge.kind === 'targets_concept' && !isRevoked(edge.fromId)) {
      const fromQuestion = questionById.get(edge.fromId);
      if (fromQuestion === undefined || purposeAllowed(fromQuestion.purpose, requiredPurpose)) {
        recordConceptQuestion(edge.toId, edge.fromId);
      }
    }
  }
  for (const page of pageById.values()) {
    if (isRevoked(page.id) || !purposeAllowed(page.purpose, requiredPurpose)) { excludedCount += 1; continue; }
    if (page.status === 'archived') continue;
    const userAuthored = (page.userAuthoredBlockIds?.length ?? 0) > 0;
    inspectList('textbook_page', page.id, page.title, 'referencedIds', page.referencedIds, page.sticky === true, userAuthored);
    inspectList('textbook_page', page.id, page.title, 'conceptIds', page.conceptIds, page.sticky === true, userAuthored);
  }
  for (const q of questionById.values()) {
    if (isRevoked(q.id) || !purposeAllowed(q.purpose, requiredPurpose)) { excludedCount += 1; continue; }
    inspectList('question', q.id, q.title, 'referencedIds', q.referencedIds, q.sticky === true);
    inspectList('question', q.id, q.title, 'conceptIds', q.conceptIds, q.sticky === true);
    for (const cId of q.conceptIds ?? []) recordConceptQuestion(cId, q.id);
  }
  const danglingReferences = [...danglingById.values()].sort((l, r) => compareText(l.id, r.id));

  const staleUnusedDrafts: KbStaleUnusedDraft[] = [];
  const collectDraft = (
    assetKind: 'textbook_page' | 'question', item: KbTextbookPageInput | KbQuestionInput,
    attemptCount: number, hasUserAuthoredContent: boolean,
  ) => {
    if (isRevoked(item.id) || !purposeAllowed(item.purpose, requiredPurpose) || item.status !== 'draft') return;
    if (Math.max(item.referenceCount ?? 0, incomingRefCount.get(item.id) ?? 0) > 0 || attemptCount > 0) return;
    const updatedMs = parseOptionalIsoMs(item.updatedAt);
    if (updatedMs === null || nowMs - updatedMs < staleDraftDays * MS_PER_DAY) return;
    staleUnusedDrafts.push({
      assetKind, assetId: item.id, title: item.title, ageDays: Math.floor((nowMs - updatedMs) / MS_PER_DAY),
      sticky: item.sticky === true, hasUserAuthoredContent,
      ...(item.rev !== undefined ? { rev: item.rev } : {}),
      ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
    });
  };
  for (const page of pageById.values()) collectDraft('textbook_page', page, 0, (page.userAuthoredBlockIds?.length ?? 0) > 0);
  for (const q of questionById.values()) collectDraft('question', q, q.attemptCount ?? 0, false);
  staleUnusedDrafts.sort((l, r) => r.ageDays - l.ageDays || compareText(l.assetKind, r.assetKind) || compareText(l.assetId, r.assetId));

  const notesByTarget = new Map<string, NoteGroup>();
  for (const note of indexLatestById(snapshot.mistakeNotes).values()) {
    if (isRevoked(note.id) || isRevoked(note.targetId) || !purposeAllowed(note.purpose, requiredPurpose)) {
      excludedCount += 1;
      continue;
    }
    let effectiveTargetId = note.targetId;
    if (note.targetKind === 'concept') {
      const targetEntity = entityById.get(note.targetId);
      if (targetEntity !== undefined && entityRedirectTarget(targetEntity) !== null) {
        const { resolved, allAuthorized } = resolveAuthorizedRedirect(note.targetId);
        if (!allAuthorized || resolved.finalId === null) { excludedCount += 1; continue; }
        effectiveTargetId = resolved.finalId;
      }
    }
    const groupKey = `${note.targetKind}:${effectiveTargetId}`;
    let group = notesByTarget.get(groupKey);
    if (!group) notesByTarget.set(groupKey, group = { targetKind: note.targetKind, targetId: effectiveTargetId, notes: [] });
    group.notes.push(note);
  }

  const compressionCandidates: KbCompressionCandidate[] = [];
  for (const [candidateKey, { targetKind, targetId, notes }] of notesByTarget) {
    if (notes.length < compressionMinNotes) continue;
    const sorted = [...notes].sort((l, r) => compareText(l.id, r.id));
    const targetPage = pageById.get(targetId);
    const targetEntity = entityById.get(targetId);
    const pageTitle = targetPage && !isRevoked(targetPage.id) && purposeAllowed(targetPage.purpose, requiredPurpose)
      ? targetPage.title : undefined;
    const entityTitle = targetEntity && !isRevoked(targetEntity.id) && purposeAllowed(targetEntity.purpose, requiredPurpose)
      ? targetEntity.canonicalName : undefined;
    const targetTitle = sorted[0]!.targetTitle?.trim() || pageTitle || entityTitle || targetId;
    const hasUserAuthoredPage = (targetPage?.userAuthoredBlockIds?.length ?? 0) > 0 || (targetKind === 'concept' &&
      [...pageById.values()].some(p => !isRevoked(p.id) && p.status !== 'archived' &&
        (p.conceptIds ?? []).includes(targetId) && (p.userAuthoredBlockIds?.length ?? 0) > 0));
    compressionCandidates.push({
      candidateKey, targetKind, targetId, targetTitle, noteCount: sorted.length,
      noteIds: sorted.map(n => n.id), noteSummaries: sorted.map(n => n.summary),
      recommendedArtifact: targetKind === 'concept' && sorted.length >= 5 ? 'decision_tree' : 'emergency_card',
      hasUserAuthoredPage,
      sticky: targetPage?.sticky === true || targetEntity?.sticky === true || sorted.some(n => n.sticky === true),
    });
  }
  compressionCandidates.sort((l, r) => r.noteCount - l.noteCount || compareText(l.candidateKey, r.candidateKey));

  const coarseConcepts: KbCoarseConceptCandidate[] = [];
  for (const [conceptId, linked] of conceptQuestionIds) {
    if (linked.size < coarseMin) continue;
    const concept = entityById.get(conceptId);
    if (!concept || !purposeAllowed(concept.purpose, requiredPurpose)) continue;
    coarseConcepts.push({ conceptId, title: concept.canonicalName, linkedQuestionCount: linked.size, sticky: concept.sticky === true });
  }
  coarseConcepts.sort((l, r) => r.linkedQuestionCount - l.linkedQuestionCount || compareText(l.conceptId, r.conceptId));

  return {
    scannedAt: snapshot.nowIso, duplicateConcepts, danglingReferences, staleUnusedDrafts,
    compressionCandidates, coarseConcepts, excludedCount,
    ...(revokedIds !== undefined && revokedIds.size > 0 ? { revokedIds: [...revokedIds].sort(compareText) } : {}),
  };
}

/** Build deterministic green/yellow/red autonomy gardening plan from snapshot with strict sticky & user-textbook guardrails. */
export function buildKbGardeningPlan(snapshot: KbGardeningSnapshot): GardeningInboxPlan {
  const radar = scanKbEntropyRadar(snapshot);
  const entityById = indexLatestById(snapshot.entities);
  const green: GardeningGreenAction[] = [];
  const yellow: GardeningYellowProposal[] = [];
  const red: GardeningRedGuard[] = [];

  const addRed = (
    guardId: string, rule: GardeningRedRule, assetKind: GardeningRedGuard['assetKind'],
    assetId: FactId, title: string, blockedAction: string, reason: string,
  ) => red.push({ guardId, tier: 'red', rule, blocked: true, assetKind, assetId, title, blockedAction, reason });
  const addYellow = (
    proposalId: string, proposalKind: GardeningYellowProposalKind, title: string, summary: string,
    suggestedCommand: GardeningYellowProposal['suggestedCommand'], targetIds: readonly FactId[],
    detail: GardeningYellowProposal['detail'], appendOnly?: boolean,
  ) => yellow.push({
    proposalId, tier: 'yellow', proposalKind, title, summary, requiresApproval: true,
    suggestedCommand, targetIds, detail, ...(appendOnly ? { appendOnly: true } : {}),
  });
  const addGreen = (
    actionId: string, actionKind: GardeningGreenActionKind, targetKind: GardeningGreenAction['targetKind'],
    targetId: FactId, title: string, reason: string, undoToken: string,
    preview: GardeningGreenAction['preview'], suggestedCommand: string,
  ) => green.push({
    actionId, tier: 'green', actionKind, targetKind, targetId, title, reason,
    reversible: true, undo_token: undoToken, preview, suggestedCommand,
  });

  for (const dup of radar.duplicateConcepts) {
    const mergeName = dup.recommendedMergeId === dup.leftId ? dup.leftName : dup.rightName;
    const keepName = dup.recommendedKeepId === dup.leftId ? dup.leftName : dup.rightName;
    if (entityById.get(dup.recommendedMergeId)?.sticky === true) {
      addRed(`red:sticky_merge:${dup.pairKey}`, 'sticky_protected', 'entity', dup.recommendedMergeId, mergeName,
        'merge_duplicate_concepts', `重复概念候选「${mergeName}」已设置 sticky 保护，严禁自动或批量合出`);
      continue;
    }
    const keepNote = entityById.get(dup.recommendedKeepId)?.sticky === true ? '（保留侧已置顶保护）' : '';
    const targetIds: KbGardeningDuplicateTargetIds = [dup.recommendedMergeId, dup.recommendedKeepId];
    addYellow(`yellow:merge:${dup.pairKey}`, 'merge_duplicate_concepts', `合并重复概念：「${mergeName}」→「${keepName}」`,
      `检测到跨源/同源重复${dup.kind}（相似度 ${dup.score.toFixed(3)}），建议将「${mergeName}」并入「${keepName}」${keepNote}`,
      evolveGraphCommand, targetIds, {
        keepEntityId: dup.recommendedKeepId, mergeEntityId: dup.recommendedMergeId,
        keepEntityName: keepName, mergeEntityName: mergeName,
        similarityScore: dup.score, crossSource: dup.crossSource, sources: dup.sources,
      });
  }

  for (const f of radar.danglingReferences) {
    const title = f.holderTitle ?? `${f.holderKind}:${f.holderId}`;
    const action = f.reason === 'redirected_entity' ? 'repoint_redirected_reference' : 'cleanup_dangling_reference';
    if (f.sticky) {
      addRed(`red:sticky_ref:${f.id}`, 'sticky_protected', f.holderKind, f.holderId, title, action,
        `来源对象「${title}」已设置 sticky 保护，严禁自动改写或清理其引用`);
    }
    if (f.hasUserAuthoredContent === true) {
      addRed(`red:user_textbook_ref:${f.id}`, 'user_authored_textbook_protected', f.holderKind, f.holderId,
        title, action, `教材页「${title}」包含用户原创正文块，严禁自动改写或清理其引用`);
    }
    if (f.sticky || f.hasUserAuthoredContent === true) continue;
    const refPath = `${f.holderKind} ${f.holderId}.${f.field}`;
    if (f.reason === 'redirected_entity' && f.resolvedTargetId !== undefined) {
      const tokenKey = `${f.holderKind}:${f.holderId}:${f.field}:${f.targetId}->${f.resolvedTargetId}`;
      const preview = {
        fromTargetId: f.targetId, toTargetId: f.resolvedTargetId,
        ...(f.redirectChain !== undefined ? { redirectChain: f.redirectChain } : {}),
      };
      addGreen(`green:repoint:${f.id}`, 'repoint_redirected_reference', f.holderKind, f.holderId, `改指已合并引用：${title}`,
        `${refPath} 指向已合并实体 ${f.targetId}，可安全可逆改指至 ${f.resolvedTargetId}`,
        `undo:kb-garden:repoint_redirected_reference:${tokenKey}`, preview, 'content.repointReference');
      continue;
    }
    addYellow(`yellow:dangling:${f.id}`, 'cleanup_dangling_reference', `清理悬空引用：${title}`,
      `${refPath} 指向${f.reason === 'revoked' ? '已撤权' : '不存在的'}目标 ${f.targetId}，待人工确认清理`,
      'content.cleanupReference', [f.holderId, f.targetId], { danglingReferenceId: f.id, danglingReason: f.reason });
  }

  for (const draft of radar.staleUnusedDrafts) {
    if (draft.sticky) {
      addRed(`red:sticky_draft:${draft.assetKind}:${draft.assetId}`, 'sticky_protected', draft.assetKind, draft.assetId,
        draft.title, 'archive_stale_unused_draft', `草稿「${draft.title}」已设置 sticky 保护，严禁自动归档`);
    }
    if (draft.hasUserAuthoredContent) {
      addRed(`red:user_textbook_draft:${draft.assetKind}:${draft.assetId}`, 'user_authored_textbook_protected',
        draft.assetKind, draft.assetId, draft.title, 'archive_stale_unused_draft',
        `草稿教材页「${draft.title}」包含用户原创正文块，严禁自动归档或覆写`);
    }
    if (!draft.sticky && !draft.hasUserAuthoredContent) {
      addGreen(`green:archive_draft:${draft.assetKind}:${draft.assetId}`, 'archive_stale_unused_draft', draft.assetKind,
        draft.assetId, `归档闲置草稿：${draft.title}`,
        `草稿「${draft.title}」已闲置 ${draft.ageDays} 天且零引用、零作答，可逆归档（非永久删除）`,
        `undo:kb-garden:archive_stale_unused_draft:${draft.assetKind}:${draft.assetId}:${draft.rev ?? 'draft'}`,
        { previousStatus: 'draft', nextStatus: 'archived' }, 'content.archiveDraft');
    }
  }

  for (const c of radar.compressionCandidates) {
    const artifactLabel = c.recommendedArtifact === 'decision_tree' ? '决策树' : '考前 3 分钟急救卡';
    addYellow(`yellow:emergency_card:${c.candidateKey}`, 'propose_emergency_card', `生成伴生${artifactLabel}：${c.targetTitle}`,
      `「${c.targetTitle}」已累计 ${c.noteCount} 条错题/避坑备注，建议追加伴生急救卡（仅追加，不覆写用户教材正文）`,
      'content.createTextbookPage', [c.targetId, ...c.noteIds], {
        compressionTargetKind: c.targetKind, compressionTargetId: c.targetId,
        noteIds: c.noteIds, noteCount: c.noteCount, recommendedArtifact: c.recommendedArtifact,
      }, true);
    const guardKind: GardeningRedGuard['assetKind'] = c.targetKind === 'chapter' ? 'chapter' : 'entity';
    if (c.hasUserAuthoredPage) {
      addRed(`red:user_textbook_compress:${c.candidateKey}`, 'user_authored_textbook_protected', guardKind, c.targetId,
        c.targetTitle, 'overwrite_user_authored_textbook',
        `「${c.targetTitle}」包含用户原创教材正文，严禁覆写原文，仅允许通过待审清单生成伴生急救卡`);
    }
    if (c.sticky) {
      addRed(`red:sticky_compress:${c.candidateKey}`, 'sticky_protected', guardKind, c.targetId, c.targetTitle,
        'overwrite_sticky_target', `「${c.targetTitle}」已设置 sticky 保护，严禁自动修改原文，仅允许人工审批伴生急救卡`);
    }
  }

  for (const coarse of radar.coarseConcepts) {
    if (coarse.sticky) {
      addRed(`red:sticky_coarse:${coarse.conceptId}`, 'sticky_protected', 'entity', coarse.conceptId, coarse.title,
        'propose_split_coarse_concept', `粗粒度概念「${coarse.title}」已设置 sticky 保护，严禁自动拆解`);
      continue;
    }
    addYellow(`yellow:split_concept:${coarse.conceptId}`, 'propose_split_coarse_concept', `拆分粗粒度概念：${coarse.title}`,
      `概念「${coarse.title}」已挂载 ${coarse.linkedQuestionCount} 道题目，建议拆分为更细粒度子概念`,
      evolveGraphCommand, [coarse.conceptId], { linkedQuestionCount: coarse.linkedQuestionCount });
  }

  return {
    generatedAt: snapshot.nowIso, radar, green, yellow, red,
    summary: {
      greenCount: green.length, yellowCount: yellow.length, redCount: red.length,
      duplicateConceptCount: radar.duplicateConcepts.length, danglingReferenceCount: radar.danglingReferences.length,
      staleUnusedDraftCount: radar.staleUnusedDrafts.length, compressionCandidateCount: radar.compressionCandidates.length,
    },
  };
}
