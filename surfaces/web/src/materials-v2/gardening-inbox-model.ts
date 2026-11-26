import { formatIsoDate } from '../shared/format-time';
import { fetchOptionalJson, isRecord, readSafeInt, readTrimmed } from '../shared/safe-values';
import type {
  GardeningGreenAction,
  GardeningInboxPlan,
  GardeningRedGuard,
  GardeningYellowProposal,
  GardeningYellowProposalDetail,
  KbEntropyRadarReport,
  NormalizedGardeningCategory,
  NormalizedGardeningGreenAction,
  NormalizedGardeningInbox,
  NormalizedGardeningProposal,
  NormalizedGardeningRedGuard,
} from './types';

export const DEFAULT_GARDENING_ENDPOINT = '/api/kb/gardening';
export const DEFAULT_ACTIONS_ENDPOINT = '/api/kb/gardening/actions';
export const DEFAULT_UNDO_ENDPOINT = '/api/kb/gardening/undo';

export const CATEGORY_META: Readonly<
  Record<NormalizedGardeningCategory, { readonly label: string; readonly tone: 'amber' | 'weak' | 'steady' | 'info' }>
> = {
  merge_duplicate_concepts: { label: '重复概念合并', tone: 'amber' },
  cleanup_dangling_reference: { label: '悬空引用修复', tone: 'weak' },
  stale_draft: { label: '过期未用草稿', tone: 'info' },
  propose_emergency_card: { label: '急救卡压缩草案', tone: 'steady' },
  propose_split_coarse_concept: { label: '过粗概念拆分', tone: 'amber' },
  other: { label: '待审园艺建议', tone: 'info' },
};

export const DANGLING_REASON_LABELS: Readonly<Record<string, string>> = {
  missing: '目标节点已不存在',
  revoked: '目标已撤回或取消授权',
  redirected_entity: '目标实体已合并重定向',
};

export const GREEN_ACTION_LABELS: Readonly<Record<string, string>> = {
  repoint_redirected_reference: '重定向改指',
  archive_stale_unused_draft: '过期草稿归档',
};

export const RED_RULE_LABELS: Readonly<Record<string, string>> = {
  sticky_protected: 'Sticky 固定保护',
  user_authored_textbook_protected: '用户原稿保护',
  no_permanent_delete: '禁止永久删除',
};

export const ASSET_KIND_LABELS: Readonly<Record<string, string>> = {
  textbook_page: '教材页',
  question: '题目',
  entity: '概念节点',
  edge: '知识连边',
  chapter: '章节',
};

const CATEGORY_ALIASES: Readonly<Record<string, NormalizedGardeningCategory>> = {
  merge_duplicate_concepts: 'merge_duplicate_concepts',
  duplicate_merge: 'merge_duplicate_concepts',
  merge_duplicate: 'merge_duplicate_concepts',
  cleanup_dangling_reference: 'cleanup_dangling_reference',
  dangling_ref: 'cleanup_dangling_reference',
  broken_reference: 'cleanup_dangling_reference',
  repair_dangling: 'cleanup_dangling_reference',
  stale_draft: 'stale_draft',
  expired_draft: 'stale_draft',
  prune_draft: 'stale_draft',
  propose_emergency_card: 'propose_emergency_card',
  compression_candidate: 'propose_emergency_card',
  emergency_card: 'propose_emergency_card',
  chapter_compression: 'propose_emergency_card',
  propose_split_coarse_concept: 'propose_split_coarse_concept',
  split_coarse_concept: 'propose_split_coarse_concept',
  coarse_concept: 'propose_split_coarse_concept',
};

function normalizeCategory(rawKind: string): NormalizedGardeningCategory {
  return CATEGORY_ALIASES[rawKind.trim().toLowerCase()] ?? 'other';
}

export function formatScorePercent(score: number | undefined): string | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const normalized = score <= 1 ? score * 100 : score;
  return `${Math.round(Math.max(0, Math.min(100, normalized)))}%`;
}

export function formatGreenPreview(action: NormalizedGardeningGreenAction): string | null {
  const preview = action.preview;
  if (!preview) return null;
  if (preview.redirectChain && preview.redirectChain.length > 1) {
    return `引用链路已收束：${preview.redirectChain.join(' → ')}`;
  }
  if (preview.fromTargetId && preview.toTargetId) {
    return `引用已改指：${preview.fromTargetId} → ${preview.toTargetId}`;
  }
  if (preview.previousStatus && preview.nextStatus) {
    const prevLabel = preview.previousStatus === 'draft' ? '草稿' : preview.previousStatus;
    const nextLabel = preview.nextStatus === 'archived' ? '已归档' : preview.nextStatus;
    return `状态变更：${prevLabel} → ${nextLabel}`;
  }
  return null;
}

function synthesizeYellowFromRadar(radar: KbEntropyRadarReport): NormalizedGardeningProposal[] {
  const items: NormalizedGardeningProposal[] = [];

  for (const dup of radar.duplicateConcepts ?? []) {
    if (!dup || typeof dup.pairKey !== 'string' || dup.sticky === true) continue;
    const keepIsLeft = dup.recommendedKeepId === dup.leftId;
    const keepEntityName = keepIsLeft ? dup.leftName : dup.rightName;
    const mergeEntityName = keepIsLeft ? dup.rightName : dup.leftName;
    const reasons = Array.isArray(dup.reasons) ? dup.reasons : [];
    items.push({
      proposalId: `radar:dup:${dup.pairKey}`,
      rawKind: 'merge_duplicate_concepts',
      category: 'merge_duplicate_concepts',
      title: `合并重复概念「${mergeEntityName}」→「${keepEntityName}」`,
      summary: reasons[0] ?? '检测到高度重合的概念节点，建议合并并建立永久 301 重定向。',
      appendOnly: false,
      suggestedCommand: 'content.evolveGraph',
      targetIds: [dup.recommendedMergeId, dup.recommendedKeepId].filter(Boolean),
      detail: {
        keepEntityId: dup.recommendedKeepId,
        mergeEntityId: dup.recommendedMergeId,
        keepEntityName,
        mergeEntityName,
        ...(typeof dup.score === 'number' ? { similarityScore: dup.score } : {}),
        ...(typeof dup.crossSource === 'boolean' ? { crossSource: dup.crossSource } : {}),
        ...(Array.isArray(dup.sources) ? { sources: dup.sources } : {}),
        ...(reasons.length > 0 ? { reasons } : {}),
      },
    });
  }

  for (const ref of radar.danglingReferences ?? []) {
    if (!ref || typeof ref.id !== 'string' || ref.sticky === true) continue;
    const reasonText = DANGLING_REASON_LABELS[ref.reason] ?? ref.reason;
    const holderLabel = readTrimmed(ref.holderTitle) ?? ref.holderId;
    items.push({
      proposalId: `radar:dangling:${ref.id}`,
      rawKind: 'cleanup_dangling_reference',
      category: 'cleanup_dangling_reference',
      title: `修复悬空引用：${holderLabel}`,
      summary: `节点「${holderLabel}」引用出现断链（${reasonText}），建议清理或改指有效目标。`,
      appendOnly: false,
      suggestedCommand: 'content.cleanupReference',
      targetIds: [ref.holderId, ref.targetId].filter(Boolean),
      detail: {
        danglingReferenceId: ref.id,
        danglingReason: ref.reason,
        ...(ref.holderTitle ? { holderTitle: ref.holderTitle } : {}),
        ...(ref.field ? { field: ref.field } : {}),
        targetId: ref.targetId,
        ...(ref.resolvedTargetId ? { resolvedTargetId: ref.resolvedTargetId } : {}),
        ...(Array.isArray(ref.redirectChain) ? { redirectChain: ref.redirectChain } : {}),
      },
    });
  }

  for (const draft of radar.staleUnusedDrafts ?? []) {
    if (!draft || typeof draft.assetId !== 'string' || draft.sticky === true || draft.hasUserAuthoredContent === true) {
      continue;
    }
    const kindLabel = ASSET_KIND_LABELS[draft.assetKind] ?? '草稿';
    items.push({
      proposalId: `radar:stale:${draft.assetId}`,
      rawKind: 'stale_draft',
      category: 'stale_draft',
      title: `清理过期未用${kindLabel}：${draft.title}`,
      summary: `该草稿已连续 ${draft.ageDays} 天未被引用或继续编辑，可归档收纳以保持题库与教材清爽。`,
      appendOnly: false,
      targetIds: [draft.assetId],
      detail: { ageDays: draft.ageDays, assetKind: draft.assetKind },
    });
  }

  for (const comp of radar.compressionCandidates ?? []) {
    if (!comp || typeof comp.candidateKey !== 'string') continue;
    const artifactLabel = comp.recommendedArtifact === 'decision_tree' ? '题型决策树' : '考前 3 分钟急救卡';
    items.push({
      proposalId: `radar:comp:${comp.candidateKey}`,
      rawKind: 'propose_emergency_card',
      category: 'propose_emergency_card',
      title: `生成「${comp.targetTitle}」${artifactLabel}`,
      summary: `该主题已沉淀 ${comp.noteCount} 条错因与碎笔记，建议追加蒸馏为结构化复习卡。`,
      appendOnly: true,
      suggestedCommand: 'content.createTextbookPage',
      targetIds: [comp.targetId].filter(Boolean),
      detail: {
        compressionTargetKind: comp.targetKind,
        compressionTargetId: comp.targetId,
        noteCount: comp.noteCount,
        ...(Array.isArray(comp.noteIds) ? { noteIds: comp.noteIds } : {}),
        ...(Array.isArray(comp.noteSummaries) ? { noteSummaries: comp.noteSummaries } : {}),
        recommendedArtifact: comp.recommendedArtifact,
      },
    });
  }

  for (const coarse of radar.coarseConcepts ?? []) {
    if (!coarse || typeof coarse.conceptId !== 'string' || coarse.sticky === true) continue;
    items.push({
      proposalId: `radar:coarse:${coarse.conceptId}`,
      rawKind: 'propose_split_coarse_concept',
      category: 'propose_split_coarse_concept',
      title: `建议拆分过粗概念「${coarse.title}」`,
      summary: `该概念已挂载 ${coarse.linkedQuestionCount} 道题目，拆分为子概念可提升母题定位与复习精度。`,
      appendOnly: false,
      suggestedCommand: 'content.evolveGraph',
      targetIds: [coarse.conceptId],
      detail: { linkedQuestionCount: coarse.linkedQuestionCount },
    });
  }

  return items;
}

function enrichProposalDetail(
  proposal: GardeningYellowProposal,
  category: NormalizedGardeningCategory,
  radar: KbEntropyRadarReport | undefined,
): GardeningYellowProposalDetail {
  const base: GardeningYellowProposalDetail = proposal.detail ? { ...proposal.detail } : {};
  if (!radar) return base;

  if (category === 'merge_duplicate_concepts') {
    const matched = (radar.duplicateConcepts ?? []).find(
      (item) =>
        (base.keepEntityId && item.recommendedKeepId === base.keepEntityId && item.recommendedMergeId === base.mergeEntityId) ||
        (base.mergeEntityName && (item.leftName === base.mergeEntityName || item.rightName === base.mergeEntityName)),
    );
    if (matched) {
      return {
        ...base,
        ...(!base.reasons && matched.reasons?.length ? { reasons: matched.reasons } : {}),
        ...(!base.sources && matched.sources?.length ? { sources: matched.sources } : {}),
        ...(base.similarityScore === undefined && typeof matched.score === 'number' ? { similarityScore: matched.score } : {}),
        ...(base.crossSource === undefined && typeof matched.crossSource === 'boolean' ? { crossSource: matched.crossSource } : {}),
      };
    }
  } else if (category === 'cleanup_dangling_reference') {
    const matched = (radar.danglingReferences ?? []).find(
      (item) =>
        (base.danglingReferenceId && item.id === base.danglingReferenceId) ||
        (proposal.targetIds?.includes(item.holderId) ?? false),
    );
    if (matched) {
      return {
        ...base,
        ...(!base.holderTitle && matched.holderTitle ? { holderTitle: matched.holderTitle } : {}),
        ...(!base.field && matched.field ? { field: matched.field } : {}),
        ...(!base.targetId ? { targetId: matched.targetId } : {}),
        ...(!base.resolvedTargetId && matched.resolvedTargetId ? { resolvedTargetId: matched.resolvedTargetId } : {}),
        ...(!base.redirectChain && matched.redirectChain?.length ? { redirectChain: matched.redirectChain } : {}),
      };
    }
  } else if (category === 'propose_emergency_card') {
    const matched = (radar.compressionCandidates ?? []).find(
      (item) =>
        (base.compressionTargetId && item.targetId === base.compressionTargetId) ||
        (proposal.targetIds?.includes(item.targetId) ?? false),
    );
    if (matched) {
      return {
        ...base,
        ...(!base.noteSummaries && matched.noteSummaries?.length ? { noteSummaries: matched.noteSummaries } : {}),
        ...(base.noteCount === undefined ? { noteCount: matched.noteCount } : {}),
        ...(!base.recommendedArtifact ? { recommendedArtifact: matched.recommendedArtifact } : {}),
      };
    }
  }
  return base;
}

export function normalizeGardeningInbox(
  plan: GardeningInboxPlan | null | undefined,
  radarProp?: KbEntropyRadarReport | null | undefined,
): NormalizedGardeningInbox {
  const effectiveRadar = plan?.radar ?? radarProp ?? undefined;
  const generatedAt = formatIsoDate(plan?.generatedAt ?? effectiveRadar?.scannedAt);

  const yellow: NormalizedGardeningProposal[] = [];
  if (Array.isArray(plan?.yellow)) {
    for (const raw of plan.yellow) {
      const proposalId = readTrimmed(raw?.proposalId);
      if (!proposalId) continue;
      const category = normalizeCategory(raw.proposalKind ?? '');
      yellow.push({
        proposalId,
        rawKind: raw.proposalKind ?? category,
        category,
        title: readTrimmed(raw.title) ?? CATEGORY_META[category].label,
        summary: readTrimmed(raw.summary) ?? '',
        appendOnly: raw.appendOnly === true || category === 'propose_emergency_card',
        ...(raw.suggestedCommand ? { suggestedCommand: raw.suggestedCommand } : {}),
        targetIds: Array.isArray(raw.targetIds)
          ? raw.targetIds.filter((id: unknown): id is string => typeof id === 'string')
          : [],
        detail: enrichProposalDetail(raw, category, effectiveRadar),
      });
    }
  } else if (effectiveRadar) {
    yellow.push(...synthesizeYellowFromRadar(effectiveRadar));
  }

  const green: NormalizedGardeningGreenAction[] = [];
  for (const raw of (Array.isArray(plan?.green) ? plan.green : []) as readonly GardeningGreenAction[]) {
    const actionId = readTrimmed(raw?.actionId);
    if (!actionId) continue;
    green.push({
      actionId,
      actionKind: raw.actionKind ?? 'repoint_redirected_reference',
      ...(raw.targetKind ? { targetKind: raw.targetKind } : {}),
      targetId: typeof raw.targetId === 'string' ? raw.targetId : '',
      title: readTrimmed(raw.title) ?? '自动维护记录',
      reason: readTrimmed(raw.reason) ?? '',
      undoToken: typeof raw.undo_token === 'string' ? raw.undo_token : '',
      ...(raw.preview ? { preview: raw.preview } : {}),
      ...(raw.suggestedCommand ? { suggestedCommand: raw.suggestedCommand } : {}),
    });
  }

  const red: NormalizedGardeningRedGuard[] = [];
  for (const raw of (Array.isArray(plan?.red) ? plan.red : []) as readonly GardeningRedGuard[]) {
    const guardId = readTrimmed(raw?.guardId);
    if (!guardId) continue;
    red.push({
      guardId,
      rule: raw.rule ?? 'sticky_protected',
      ...(raw.assetKind ? { assetKind: raw.assetKind } : {}),
      assetId: typeof raw.assetId === 'string' ? raw.assetId : '',
      title: readTrimmed(raw.title) ?? '受保护记录',
      blockedAction: readTrimmed(raw.blockedAction) ?? '自动修改',
      reason: readTrimmed(raw.reason) ?? '命中红灯守护策略，已跳过自动处理。',
    });
  }

  return {
    generatedAt,
    yellow,
    green,
    red,
    excludedCount: readSafeInt(effectiveRadar?.excludedCount, 1) ?? 0,
  };
}

export async function fetchOptionalGardeningPlan(
  endpoint: string,
  signal: AbortSignal,
): Promise<{ readonly available: true; readonly data: GardeningInboxPlan } | { readonly available: false }> {
  const parsed = await fetchOptionalJson(endpoint, signal);
  if (!isRecord(parsed)) return { available: false };
  if (isRecord(parsed.plan)) return { available: true, data: parsed.plan as GardeningInboxPlan };
  if (
    Array.isArray(parsed.yellow) ||
    Array.isArray(parsed.green) ||
    Array.isArray(parsed.red) ||
    isRecord(parsed.radar)
  ) {
    return { available: true, data: parsed as GardeningInboxPlan };
  }
  if (
    Array.isArray(parsed.duplicateConcepts) ||
    Array.isArray(parsed.danglingReferences) ||
    Array.isArray(parsed.staleUnusedDrafts) ||
    Array.isArray(parsed.compressionCandidates) ||
    Array.isArray(parsed.coarseConcepts)
  ) {
    return { available: true, data: { radar: parsed as KbEntropyRadarReport } };
  }
  return { available: true, data: {} };
}

export async function postGardeningJsonAction(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const payload: unknown = await response.json().catch(() => null);
    const serverError = isRecord(payload) ? readTrimmed(payload.error) : undefined;
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return { ok: false, message: serverError ?? '后端园艺执行接口尚未上线，本次操作未写入。' };
    }
    return { ok: false, message: serverError ?? `操作未能完成（HTTP ${response.status}），请稍后重试。` };
  } catch {
    return { ok: false, message: '网络连接中断，本次园艺操作未写入，请稍后重试。' };
  }
}
