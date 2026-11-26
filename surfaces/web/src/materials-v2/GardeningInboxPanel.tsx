import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestId } from '../api';
import { Icon } from '../icons';
import type {
  GardeningActionDecision,
  GardeningGreenAction,
  GardeningInboxPanelProps,
  GardeningInboxPlan,
  GardeningRedGuard,
  GardeningYellowProposal,
  GardeningYellowProposalDetail,
  KbCompressionCandidate,
  KbDanglingReferenceCandidate,
  KbDuplicateConceptCandidate,
  KbEntropyRadarReport,
  NormalizedGardeningCategory,
  NormalizedGardeningGreenAction,
  NormalizedGardeningInbox,
  NormalizedGardeningProposal,
  NormalizedGardeningRedGuard,
} from './types';

const DEFAULT_GARDENING_ENDPOINT = '/api/kb/gardening';
const DEFAULT_ACTIONS_ENDPOINT = '/api/kb/gardening/actions';
const DEFAULT_UNDO_ENDPOINT = '/api/kb/gardening/undo';

const CATEGORY_META: Readonly<
  Record<NormalizedGardeningCategory, { readonly label: string; readonly tone: 'amber' | 'weak' | 'steady' | 'info' }>
> = {
  merge_duplicate_concepts: { label: '重复概念合并', tone: 'amber' },
  cleanup_dangling_reference: { label: '悬空引用修复', tone: 'weak' },
  stale_draft: { label: '过期未用草稿', tone: 'info' },
  propose_emergency_card: { label: '急救卡压缩草案', tone: 'steady' },
  propose_split_coarse_concept: { label: '过粗概念拆分', tone: 'amber' },
};

const DANGLING_REASON_LABELS: Readonly<Record<string, string>> = {
  missing: '目标节点已不存在',
  revoked: '目标已撤回或取消授权',
  redirected_entity: '目标实体已合并重定向',
};

const GREEN_ACTION_LABELS: Readonly<Record<string, string>> = {
  repoint_redirected_reference: '重定向改指',
  archive_stale_unused_draft: '过期草稿归档',
};

const RED_RULE_LABELS: Readonly<Record<string, string>> = {
  sticky_protected: 'Sticky 固定保护',
  user_authored_textbook_protected: '用户原稿保护',
  no_permanent_delete: '禁止永久删除',
};

const ASSET_KIND_LABELS: Readonly<Record<string, string>> = {
  textbook_page: '教材页',
  question: '题目',
  entity: '概念节点',
  edge: '知识连边',
  chapter: '章节',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeCategory(rawKind: string): NormalizedGardeningCategory {
  const kind = rawKind.trim().toLowerCase();
  if (kind === 'merge_duplicate_concepts' || kind === 'duplicate_merge' || kind === 'merge_duplicate') {
    return 'merge_duplicate_concepts';
  }
  if (
    kind === 'cleanup_dangling_reference' ||
    kind === 'dangling_ref' ||
    kind === 'broken_reference' ||
    kind === 'repair_dangling'
  ) {
    return 'cleanup_dangling_reference';
  }
  if (kind === 'stale_draft' || kind === 'expired_draft' || kind === 'prune_draft') {
    return 'stale_draft';
  }
  if (
    kind === 'propose_emergency_card' ||
    kind === 'compression_candidate' ||
    kind === 'emergency_card' ||
    kind === 'chapter_compression'
  ) {
    return 'propose_emergency_card';
  }
  if (kind === 'propose_split_coarse_concept' || kind === 'split_coarse_concept' || kind === 'coarse_concept') {
    return 'propose_split_coarse_concept';
  }
  return 'cleanup_dangling_reference';
}

function formatDateLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (match?.[1]) return match[1];
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const d = new Date(parsed);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatScorePercent(score: number | undefined): string | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const normalized = score <= 1 ? score * 100 : score;
  return `${Math.round(Math.max(0, Math.min(100, normalized)))}%`;
}

function synthesizeYellowFromRadar(radar: KbEntropyRadarReport): NormalizedGardeningProposal[] {
  const items: NormalizedGardeningProposal[] = [];

  for (const dup of radar.duplicateConcepts ?? []) {
    if (!dup || typeof dup.pairKey !== 'string') continue;
    const keepIsLeft = dup.recommendedKeepId === dup.leftId;
    const keepEntityName = keepIsLeft ? dup.leftName : dup.rightName;
    const mergeEntityName = keepIsLeft ? dup.rightName : dup.leftName;
    const reasons = Array.isArray(dup.reasons) ? dup.reasons : [];
    const detail: GardeningYellowProposalDetail = {
      keepEntityId: dup.recommendedKeepId,
      mergeEntityId: dup.recommendedMergeId,
      keepEntityName,
      mergeEntityName,
      ...(typeof dup.score === 'number' ? { similarityScore: dup.score } : {}),
      ...(typeof dup.crossSource === 'boolean' ? { crossSource: dup.crossSource } : {}),
      ...(Array.isArray(dup.sources) ? { sources: dup.sources } : {}),
      ...(reasons.length > 0 ? { reasons } : {}),
    };
    items.push({
      proposalId: `radar:dup:${dup.pairKey}`,
      rawKind: 'merge_duplicate_concepts',
      category: 'merge_duplicate_concepts',
      title: `合并重复概念「${mergeEntityName}」→「${keepEntityName}」`,
      summary: reasons[0] ?? '检测到高度重合的概念节点，建议合并并建立永久 301 重定向。',
      appendOnly: false,
      suggestedCommand: 'content.evolveGraph',
      targetIds: [dup.recommendedKeepId, dup.recommendedMergeId].filter(Boolean),
      detail,
    });
  }

  for (const ref of radar.danglingReferences ?? []) {
    if (!ref || typeof ref.id !== 'string' || ref.sticky === true) continue;
    const reasonText = DANGLING_REASON_LABELS[ref.reason] ?? ref.reason;
    const holderLabel = cleanText(ref.holderTitle) ?? ref.holderId;
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
    if (!draft || typeof draft.assetId !== 'string' || draft.sticky === true) continue;
    const kindLabel = ASSET_KIND_LABELS[draft.assetKind] ?? '草稿';
    items.push({
      proposalId: `radar:stale:${draft.assetId}`,
      rawKind: 'stale_draft',
      category: 'stale_draft',
      title: `清理过期未用${kindLabel}：${draft.title}`,
      summary: `该草稿已连续 ${draft.ageDays} 天未被引用或继续编辑，可归档收纳以保持题库与教材清爽。`,
      appendOnly: false,
      targetIds: [draft.assetId],
      detail: {
        ageDays: draft.ageDays,
        assetKind: draft.assetKind,
      },
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
      detail: {
        linkedQuestionCount: coarse.linkedQuestionCount,
      },
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
    const matched: KbDuplicateConceptCandidate | undefined = (radar.duplicateConcepts ?? []).find(
      item =>
        (base.keepEntityId && item.recommendedKeepId === base.keepEntityId && item.recommendedMergeId === base.mergeEntityId) ||
        (base.mergeEntityName && (item.leftName === base.mergeEntityName || item.rightName === base.mergeEntityName)),
    );
    if (matched) {
      return {
        ...base,
        ...(base.reasons ? {} : matched.reasons?.length ? { reasons: matched.reasons } : {}),
        ...(base.sources ? {} : matched.sources?.length ? { sources: matched.sources } : {}),
        ...(base.similarityScore === undefined && typeof matched.score === 'number'
          ? { similarityScore: matched.score }
          : {}),
        ...(base.crossSource === undefined && typeof matched.crossSource === 'boolean'
          ? { crossSource: matched.crossSource }
          : {}),
      };
    }
  }

  if (category === 'cleanup_dangling_reference') {
    const matched: KbDanglingReferenceCandidate | undefined = (radar.danglingReferences ?? []).find(
      item =>
        (base.danglingReferenceId && item.id === base.danglingReferenceId) ||
        (proposal.targetIds?.includes(item.holderId) ?? false),
    );
    if (matched) {
      return {
        ...base,
        ...(base.holderTitle ? {} : matched.holderTitle ? { holderTitle: matched.holderTitle } : {}),
        ...(base.field ? {} : matched.field ? { field: matched.field } : {}),
        ...(base.targetId ? {} : { targetId: matched.targetId }),
        ...(base.resolvedTargetId ? {} : matched.resolvedTargetId ? { resolvedTargetId: matched.resolvedTargetId } : {}),
        ...(base.redirectChain ? {} : matched.redirectChain?.length ? { redirectChain: matched.redirectChain } : {}),
      };
    }
  }

  if (category === 'propose_emergency_card') {
    const matched: KbCompressionCandidate | undefined = (radar.compressionCandidates ?? []).find(
      item =>
        (base.compressionTargetId && item.targetId === base.compressionTargetId) ||
        (proposal.targetIds?.includes(item.targetId) ?? false),
    );
    if (matched) {
      return {
        ...base,
        ...(base.noteSummaries ? {} : matched.noteSummaries?.length ? { noteSummaries: matched.noteSummaries } : {}),
        ...(base.noteCount === undefined ? { noteCount: matched.noteCount } : {}),
        ...(base.recommendedArtifact ? {} : { recommendedArtifact: matched.recommendedArtifact }),
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
  const generatedAt = formatDateLabel(plan?.generatedAt ?? effectiveRadar?.scannedAt);

  const yellow: NormalizedGardeningProposal[] = [];
  if (Array.isArray(plan?.yellow)) {
    for (const raw of plan.yellow) {
      if (!raw || typeof raw.proposalId !== 'string' || !raw.proposalId.trim()) continue;
      const category = normalizeCategory(raw.proposalKind ?? '');
      const detail = enrichProposalDetail(raw, category, effectiveRadar);
      yellow.push({
        proposalId: raw.proposalId.trim(),
        rawKind: raw.proposalKind ?? category,
        category,
        title: cleanText(raw.title) ?? CATEGORY_META[category].label,
        summary: cleanText(raw.summary) ?? '',
        appendOnly: raw.appendOnly === true || category === 'propose_emergency_card',
        ...(raw.suggestedCommand ? { suggestedCommand: raw.suggestedCommand } : {}),
        targetIds: Array.isArray(raw.targetIds)
          ? raw.targetIds.filter((id: unknown): id is string => typeof id === 'string')
          : [],
        detail,
      });
    }
  } else if (effectiveRadar) {
    yellow.push(...synthesizeYellowFromRadar(effectiveRadar));
  }

  const green: NormalizedGardeningGreenAction[] = [];
  if (Array.isArray(plan?.green)) {
    for (const raw of plan.green as readonly GardeningGreenAction[]) {
      if (!raw || typeof raw.actionId !== 'string' || !raw.actionId.trim()) continue;
      green.push({
        actionId: raw.actionId.trim(),
        actionKind: raw.actionKind ?? 'repoint_redirected_reference',
        ...(raw.targetKind ? { targetKind: raw.targetKind } : {}),
        targetId: typeof raw.targetId === 'string' ? raw.targetId : '',
        title: cleanText(raw.title) ?? '自动维护记录',
        reason: cleanText(raw.reason) ?? '',
        undoToken: typeof raw.undo_token === 'string' ? raw.undo_token : '',
        ...(raw.preview ? { preview: raw.preview } : {}),
        ...(raw.suggestedCommand ? { suggestedCommand: raw.suggestedCommand } : {}),
      });
    }
  }

  const red: NormalizedGardeningRedGuard[] = [];
  if (Array.isArray(plan?.red)) {
    for (const raw of plan.red as readonly GardeningRedGuard[]) {
      if (!raw || typeof raw.guardId !== 'string' || !raw.guardId.trim()) continue;
      red.push({
        guardId: raw.guardId.trim(),
        rule: raw.rule ?? 'sticky_protected',
        ...(raw.assetKind ? { assetKind: raw.assetKind } : {}),
        assetId: typeof raw.assetId === 'string' ? raw.assetId : '',
        title: cleanText(raw.title) ?? '受保护记录',
        blockedAction: cleanText(raw.blockedAction) ?? '自动修改',
        reason: cleanText(raw.reason) ?? '命中红灯守护策略，已跳过自动处理。',
      });
    }
  }

  const excludedCount =
    typeof effectiveRadar?.excludedCount === 'number' && Number.isSafeInteger(effectiveRadar.excludedCount) && effectiveRadar.excludedCount > 0
      ? effectiveRadar.excludedCount
      : 0;

  return { generatedAt, yellow, green, red, excludedCount };
}

function GardenSparkIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3m0 12v3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M3 12h3m12 0h3M4.9 19.1 7 17m10-10 2.1-2.1" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Z" />
      <path d="M9.5 12.2 11.3 14l3.5-3.8" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function ProposalDetailPreview({ proposal }: { readonly proposal: NormalizedGardeningProposal }) {
  const { category, detail, appendOnly } = proposal;

  if (category === 'merge_duplicate_concepts') {
    const fromLabel = cleanText(detail.mergeEntityName) ?? cleanText(detail.fromTitle) ?? cleanText(detail.mergeEntityId) ?? '来源概念';
    const toLabel = cleanText(detail.keepEntityName) ?? cleanText(detail.toTitle) ?? cleanText(detail.keepEntityId) ?? '目标概念';
    const scoreText = formatScorePercent(detail.similarityScore);
    const reasons = detail.reasons?.filter(Boolean) ?? [];
    const sources = detail.sources?.filter(Boolean) ?? [];

    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-redirect">
          <span className="mv2-garden-node mv2-garden-node-from">{fromLabel}</span>
          <span className="mv2-garden-arrow" aria-hidden="true">→</span>
          <span className="mv2-garden-node mv2-garden-node-to">{toLabel}</span>
          <span className="mv2-pill mv2-pill-steady">301 永久重定向</span>
        </div>
        <div className="mv2-garden-meta-row">
          {scoreText && <span className="mv2-origin-chip">重合度 {scoreText}</span>}
          {detail.crossSource && <span className="mv2-pill mv2-pill-due">跨来源对齐</span>}
          {sources.map(src => (
            <span key={src} className="mv2-origin-chip">来源：{src}</span>
          ))}
        </div>
        {reasons.length > 0 && (
          <ul className="mv2-garden-bullets">
            {reasons.slice(0, 3).map(reason => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <p className="mv2-garden-assurance">旧引用自动 301 重定向不丢失，既有笔记、错题与母题连边将自动指向保留概念。</p>
      </div>
    );
  }

  if (category === 'cleanup_dangling_reference') {
    const reasonLabel = detail.danglingReason
      ? DANGLING_REASON_LABELS[detail.danglingReason] ?? detail.danglingReason
      : '引用断链';
    const chain = detail.redirectChain?.filter(Boolean) ?? [];
    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-meta-row">
          <span className="mv2-pill mv2-pill-weak">{reasonLabel}</span>
          {detail.holderTitle && <span className="mv2-origin-chip">所在节点：{detail.holderTitle}</span>}
          {detail.field && <span className="mv2-origin-chip">字段：{detail.field}</span>}
          {detail.resolvedTargetId && <span className="mv2-pill mv2-pill-steady">可改指至有效目标</span>}
        </div>
        {chain.length > 1 && (
          <p className="mv2-garden-assurance">重定向链：{chain.join(' → ')}</p>
        )}
        {!detail.resolvedTargetId && (
          <p className="mv2-garden-assurance">采纳后将安全清理失效断链标记，不会删除承载正文内容。</p>
        )}
      </div>
    );
  }

  if (category === 'stale_draft') {
    const kindLabel = detail.assetKind ? ASSET_KIND_LABELS[detail.assetKind] ?? detail.assetKind : '草稿';
    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-meta-row">
          <span className="mv2-origin-chip">{kindLabel}</span>
          {typeof detail.ageDays === 'number' && Number.isFinite(detail.ageDays) && (
            <span className="mv2-pill mv2-pill-due">已静置 {detail.ageDays} 天未使用</span>
          )}
        </div>
        <p className="mv2-garden-assurance">仅归档收纳未发布草稿，绝不执行永久删除，后续随时可恢复。</p>
      </div>
    );
  }

  if (category === 'propose_emergency_card') {
    const artifactLabel = detail.recommendedArtifact === 'decision_tree' ? '题型决策树' : '考前 3 分钟急救卡';
    const summaries = detail.noteSummaries?.filter(Boolean) ?? [];
    const targetKindLabel = detail.compressionTargetKind
      ? ASSET_KIND_LABELS[detail.compressionTargetKind] ?? detail.compressionTargetKind
      : '章节';
    return (
      <div className="mv2-garden-preview">
        <div className="mv2-garden-meta-row">
          <span className="mv2-pill mv2-pill-steady">拟生成：{artifactLabel}</span>
          <span className="mv2-origin-chip">范围：{targetKindLabel}</span>
          {typeof detail.noteCount === 'number' && detail.noteCount > 0 && (
            <span className="mv2-pill mv2-pill-due">累计 {detail.noteCount} 条错因/碎笔记</span>
          )}
          {appendOnly && <span className="mv2-pill mv2-pill-rep">仅追加 · 不覆盖原稿</span>}
        </div>
        {summaries.length > 0 && (
          <ul className="mv2-garden-bullets">
            {summaries.slice(0, 4).map(point => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        )}
        <p className="mv2-garden-assurance">
          {appendOnly
            ? '以追加草案方式生成急救卡，严格保留你的原始手写笔记与教材页面。'
            : '将高频错因与碎笔记压缩为考前速查要点，便于考前 3 分钟快速复盘。'}
        </p>
      </div>
    );
  }

  // propose_split_coarse_concept
  return (
    <div className="mv2-garden-preview">
      <div className="mv2-garden-meta-row">
        {typeof detail.linkedQuestionCount === 'number' && (
          <span className="mv2-pill mv2-pill-due">已关联 {detail.linkedQuestionCount} 道题</span>
        )}
        <span className="mv2-origin-chip">建议拆分为细粒度子概念</span>
      </div>
      <p className="mv2-garden-assurance">拆分后既有题目的概念映射会自动细分，提升薄弱点定位与母题聚合精度。</p>
    </div>
  );
}

function formatGreenPreview(action: NormalizedGardeningGreenAction): string | null {
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

async function fetchOptionalGardeningPlan(
  endpoint: string,
  signal: AbortSignal,
): Promise<{ readonly available: true; readonly data: GardeningInboxPlan } | { readonly available: false }> {
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return { available: false };
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('json')) {
      return { available: false };
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!isRecord(parsed)) return { available: false };
    // Allow either GardeningInboxPlan directly or { plan: ... } wrapper or raw radar report
    if (isRecord(parsed.plan)) {
      return { available: true, data: parsed.plan as GardeningInboxPlan };
    }
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
  } catch {
    return { available: false };
  }
}

async function postJsonAction(endpoint: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const payload: unknown = await response.json().catch(() => null);
    const serverError = isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : null;
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return { ok: false, message: serverError ?? '后端园艺执行接口尚未上线，本次操作未写入。' };
    }
    return { ok: false, message: serverError ?? `操作未能完成（HTTP ${response.status}），请稍后重试。` };
  } catch {
    return { ok: false, message: '网络连接中断，本次园艺操作未写入，请稍后重试。' };
  }
}

export function GardeningInboxPanel({
  plan: providedPlan,
  radar: providedRadar,
  endpoint = DEFAULT_GARDENING_ENDPOINT,
  actionsEndpoint = DEFAULT_ACTIONS_ENDPOINT,
  undoEndpoint = DEFAULT_UNDO_ENDPOINT,
  compactWhenEmpty = false,
  defaultExpanded,
  onDecision,
  onBatchDecision,
  onUndo,
}: GardeningInboxPanelProps) {
  const hasInjectedData = providedPlan !== undefined || providedRadar !== undefined;
  const [fetchedPlan, setFetchedPlan] = useState<GardeningInboxPlan | null>(null);
  const [endpointAvailable, setEndpointAvailable] = useState<boolean>(hasInjectedData);
  const [loading, setLoading] = useState<boolean>(false);
  const [resolvedDecisions, setResolvedDecisions] = useState<Record<string, 'accept' | 'dismiss'>>({});
  const [undoneActions, setUndoneActions] = useState<Record<string, true>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ readonly tone: 'soft' | 'error'; readonly text: string } | null>(null);
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded ?? true);
  const abortRef = useRef<AbortController | null>(null);

  const loadFromEndpoint = useCallback(async () => {
    if (hasInjectedData || !endpoint) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const result = await fetchOptionalGardeningPlan(endpoint, controller.signal);
      if (controller.signal.aborted) return;
      if (result.available) {
        setEndpointAvailable(true);
        setFetchedPlan(result.data);
      } else {
        setEndpointAvailable(false);
        setFetchedPlan(null);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [endpoint, hasInjectedData]);

  useEffect(() => {
    if (hasInjectedData) {
      setEndpointAvailable(true);
      return;
    }
    void loadFromEndpoint();
    return () => abortRef.current?.abort();
  }, [hasInjectedData, loadFromEndpoint]);

  const normalized = useMemo(
    () => normalizeGardeningInbox(hasInjectedData ? providedPlan : fetchedPlan, providedRadar),
    [fetchedPlan, hasInjectedData, providedPlan, providedRadar],
  );

  const pendingYellow = useMemo(
    () => normalized.yellow.filter(item => resolvedDecisions[item.proposalId] === undefined),
    [normalized.yellow, resolvedDecisions],
  );

  const activeGreenCount = useMemo(
    () => normalized.green.filter(item => !undoneActions[item.actionId]).length,
    [normalized.green, undoneActions],
  );

  const handleSingleDecision = useCallback(
    async (proposal: NormalizedGardeningProposal, action: 'accept' | 'dismiss') => {
      if (busyKey !== null) return;
      const key = `${action}:${proposal.proposalId}`;
      setBusyKey(key);
      setFeedback(null);
      const decision: GardeningActionDecision = {
        proposalId: proposal.proposalId,
        proposalKind: proposal.rawKind,
        category: proposal.category,
        action,
        ...(proposal.suggestedCommand ? { suggestedCommand: proposal.suggestedCommand } : {}),
        targetIds: proposal.targetIds,
      };
      try {
        if (onDecision) {
          await onDecision(decision);
        } else {
          const result = await postJsonAction(actionsEndpoint, {
            requestId: requestId(),
            action,
            proposalId: decision.proposalId,
            proposalKind: decision.proposalKind,
            suggestedCommand: decision.suggestedCommand,
            targetIds: decision.targetIds,
          });
          if (!result.ok) {
            setFeedback({ tone: 'error', text: result.message });
            return;
          }
        }
        setResolvedDecisions(prev => ({ ...prev, [proposal.proposalId]: action }));
        setFeedback({
          tone: 'soft',
          text: action === 'accept' ? `已采纳提案：${proposal.title}` : `已忽略提案：${proposal.title}`,
        });
      } catch (failure) {
        setFeedback({
          tone: 'error',
          text: failure instanceof Error ? failure.message : '操作未能完成，请稍后重试。',
        });
      } finally {
        setBusyKey(null);
      }
    },
    [actionsEndpoint, busyKey, onDecision],
  );

  const handleBatchDecision = useCallback(
    async (action: 'accept' | 'dismiss') => {
      if (busyKey !== null || pendingYellow.length === 0) return;
      setBusyKey(`batch:${action}`);
      setFeedback(null);
      const decisions: GardeningActionDecision[] = pendingYellow.map(proposal => ({
        proposalId: proposal.proposalId,
        proposalKind: proposal.rawKind,
        category: proposal.category,
        action,
        ...(proposal.suggestedCommand ? { suggestedCommand: proposal.suggestedCommand } : {}),
        targetIds: proposal.targetIds,
      }));
      try {
        if (onBatchDecision) {
          await onBatchDecision(decisions);
        } else if (onDecision) {
          for (const decision of decisions) {
            await onDecision(decision);
          }
        } else {
          const result = await postJsonAction(actionsEndpoint, {
            requestId: requestId(),
            batch: true,
            action,
            proposals: decisions.map(d => ({
              proposalId: d.proposalId,
              proposalKind: d.proposalKind,
              suggestedCommand: d.suggestedCommand,
              targetIds: d.targetIds,
            })),
          });
          if (!result.ok) {
            setFeedback({ tone: 'error', text: result.message });
            return;
          }
        }
        setResolvedDecisions(prev => {
          const next = { ...prev };
          for (const decision of decisions) next[decision.proposalId] = action;
          return next;
        });
        setFeedback({
          tone: 'soft',
          text:
            action === 'accept'
              ? `已全部采纳 ${decisions.length} 条黄灯园艺提案。`
              : `已清空忽略 ${decisions.length} 条黄灯园艺提案。`,
        });
      } catch (failure) {
        setFeedback({
          tone: 'error',
          text: failure instanceof Error ? failure.message : '批量操作未能完成，请稍后重试。',
        });
      } finally {
        setBusyKey(null);
      }
    },
    [actionsEndpoint, busyKey, onBatchDecision, onDecision, pendingYellow],
  );

  const handleUndo = useCallback(
    async (action: NormalizedGardeningGreenAction) => {
      if (busyKey !== null || undoneActions[action.actionId]) return;
      setBusyKey(`undo:${action.actionId}`);
      setFeedback(null);
      try {
        if (onUndo) {
          await onUndo(action);
        } else {
          const result = await postJsonAction(undoEndpoint, {
            requestId: requestId(),
            actionId: action.actionId,
            undo_token: action.undoToken,
          });
          if (!result.ok) {
            setFeedback({ tone: 'error', text: result.message });
            return;
          }
        }
        setUndoneActions(prev => ({ ...prev, [action.actionId]: true }));
        setFeedback({ tone: 'soft', text: `已撤回自动处理：${action.title}` });
      } catch (failure) {
        setFeedback({
          tone: 'error',
          text: failure instanceof Error ? failure.message : '未能撤回该条自动处理，请稍后重试。',
        });
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, onUndo, undoEndpoint, undoneActions],
  );

  const hasAnyItems = pendingYellow.length > 0 || normalized.green.length > 0 || normalized.red.length > 0;

  if (compactWhenEmpty) {
    if (!hasInjectedData && !endpointAvailable && !loading) {
      return null;
    }
    if (!hasAnyItems && !feedback) {
      if (loading) return null;
      return (
        <div className="mv2-garden-compact" role="region" aria-label="知识园艺状态">
          <span className="mv2-garden-compact-copy">
            <GardenSparkIcon />
            <span>知识园艺 · 当前无待审黄灯提案</span>
          </span>
          {!hasInjectedData && endpoint && (
            <button
              type="button"
              className="mv2-inline-link"
              onClick={() => void loadFromEndpoint()}
            >
              重新扫描
            </button>
          )}
        </div>
      );
    }
  }

  return (
    <section className="mv2-garden" aria-label="知识园艺待审箱">
      <header className="mv2-garden-head">
        <div className="mv2-garden-title-group">
          <div className="mv2-garden-badges">
            <span className="mv2-garden-lamp mv2-garden-lamp-yellow">
              <GardenSparkIcon />
              <span>黄灯园艺待审箱</span>
            </span>
            {pendingYellow.length > 0 && (
              <span className="mv2-pill mv2-pill-due">{pendingYellow.length} 项待确认</span>
            )}
            {normalized.green.length > 0 && (
              <span className="mv2-pill mv2-pill-steady">绿灯自动处理 {activeGreenCount}</span>
            )}
            {normalized.red.length > 0 && (
              <span className="mv2-pill mv2-pill-weak">红灯守护 {normalized.red.length}</span>
            )}
            {normalized.generatedAt && (
              <span className="mv2-anchor-date">巡检 {normalized.generatedAt}</span>
            )}
          </div>
          <p className="mv2-garden-subtitle">
            系统自动巡检重复概念、断链引用与碎笔记沉淀；绿灯动作可随时撤回，黄灯变更须你确认后才落地。
          </p>
        </div>

        <div className="mv2-garden-head-actions">
          {pendingYellow.length > 0 && expanded && (
            <>
              <button
                type="button"
                className="mv2-btn mv2-btn-primary mv2-btn-sm"
                disabled={busyKey !== null}
                onClick={() => void handleBatchDecision('accept')}
              >
                {busyKey === 'batch:accept' ? '正在采纳…' : `全部采纳 (${pendingYellow.length})`}
              </button>
              <button
                type="button"
                className="mv2-btn mv2-btn-ghost mv2-btn-sm"
                disabled={busyKey !== null}
                onClick={() => void handleBatchDecision('dismiss')}
              >
                {busyKey === 'batch:dismiss' ? '正在忽略…' : '清空忽略'}
              </button>
            </>
          )}
          <button
            type="button"
            className="mv2-btn mv2-btn-ghost mv2-btn-sm"
            aria-expanded={expanded}
            onClick={() => setExpanded(prev => !prev)}
          >
            <span>{expanded ? '收起待审箱' : '展开待审箱'}</span>
            <span className="mv2-garden-chevron" data-open={expanded ? 'true' : 'false'}>
              <Icon name="chevron" />
            </span>
          </button>
        </div>
      </header>

      {feedback && (
        <div
          className={`mv2-notice ${feedback.tone === 'error' ? 'mv2-notice-error' : 'mv2-notice-soft'}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{feedback.text}</span>
        </div>
      )}

      {expanded && (
        <div className="mv2-garden-body">
          {loading && !hasAnyItems ? (
            <div className="mv2-garden-empty" role="status">
              <p className="mv2-muted">正在巡检知识库健康度…</p>
            </div>
          ) : pendingYellow.length > 0 ? (
            <ul className="mv2-garden-list">
              {pendingYellow.map(proposal => {
                const meta = CATEGORY_META[proposal.category];
                const acceptKey = `accept:${proposal.proposalId}`;
                const dismissKey = `dismiss:${proposal.proposalId}`;
                return (
                  <li key={proposal.proposalId} className="mv2-garden-card">
                    <div className="mv2-garden-card-top">
                      <span
                        className={`mv2-pill ${
                          meta.tone === 'amber'
                            ? 'mv2-pill-due'
                            : meta.tone === 'weak'
                              ? 'mv2-pill-weak'
                              : meta.tone === 'steady'
                                ? 'mv2-pill-steady'
                                : 'mv2-pill-unknown'
                        }`}
                      >
                        {meta.label}
                      </span>
                      {proposal.appendOnly && (
                        <span className="mv2-pill mv2-pill-rep">Append-Only</span>
                      )}
                    </div>

                    <h3 className="mv2-garden-card-title">{proposal.title}</h3>
                    {proposal.summary && <p className="mv2-garden-card-summary">{proposal.summary}</p>}

                    <ProposalDetailPreview proposal={proposal} />

                    <div className="mv2-item-actions">
                      <button
                        type="button"
                        className="mv2-btn mv2-btn-primary mv2-btn-sm"
                        disabled={busyKey !== null}
                        onClick={() => void handleSingleDecision(proposal, 'accept')}
                      >
                        {busyKey === acceptKey ? '正在采纳…' : '采纳'}
                      </button>
                      <button
                        type="button"
                        className="mv2-btn mv2-btn-ghost mv2-btn-sm"
                        disabled={busyKey !== null}
                        onClick={() => void handleSingleDecision(proposal, 'dismiss')}
                      >
                        {busyKey === dismissKey ? '正在忽略…' : '忽略'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mv2-garden-empty">
              <p className="mv2-muted">
                {!hasInjectedData && !endpointAvailable
                  ? '知识园艺巡检服务暂未连接，当前无待审项。'
                  : normalized.yellow.length > 0
                    ? '本轮黄灯待审提案已全部处理完毕。'
                    : '知识矿山状态清爽，当前没有需要人工确认的黄灯提案。'}
              </p>
              {!hasInjectedData && endpoint && (
                <button
                  type="button"
                  className="mv2-inline-link"
                  onClick={() => void loadFromEndpoint()}
                >
                  重新巡检
                </button>
              )}
            </div>
          )}

          {normalized.green.length > 0 && (
            <details className="mv2-garden-details">
              <summary>
                <span className="mv2-pill mv2-pill-steady">绿灯</span>
                <span>绿灯已自动处理记录（{normalized.green.length}）</span>
              </summary>
              <ul className="mv2-garden-log-list">
                {normalized.green.map(action => {
                  const undone = Boolean(undoneActions[action.actionId]);
                  const undoKey = `undo:${action.actionId}`;
                  const actionLabel = GREEN_ACTION_LABELS[action.actionKind] ?? '自动维护';
                  const previewLine = formatGreenPreview(action);
                  return (
                    <li key={action.actionId} className="mv2-garden-log-item" data-undone={undone ? 'true' : 'false'}>
                      <div className="mv2-garden-log-copy">
                        <div className="mv2-card-meta">
                          <span className="mv2-pill mv2-pill-steady">{actionLabel}</span>
                          {action.targetKind && (
                            <span className="mv2-origin-chip">
                              {ASSET_KIND_LABELS[action.targetKind] ?? action.targetKind}
                            </span>
                          )}
                          {undone && <span className="mv2-pill mv2-pill-unknown">已撤回</span>}
                        </div>
                        <p className="mv2-garden-log-title">{action.title}</p>
                        {action.reason && <p className="mv2-garden-log-reason">{action.reason}</p>}
                        {previewLine && <p className="mv2-garden-log-preview">{previewLine}</p>}
                      </div>
                      <button
                        type="button"
                        className="mv2-btn mv2-btn-ghost mv2-btn-sm"
                        disabled={undone || busyKey !== null || !action.undoToken}
                        data-undo-token={action.undoToken}
                        onClick={() => void handleUndo(action)}
                      >
                        <UndoIcon />
                        <span>{undone ? '已撤回' : busyKey === undoKey ? '撤回中…' : '撤回'}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {normalized.red.length > 0 && (
            <details className="mv2-garden-details mv2-garden-red-details">
              <summary>
                <span className="mv2-pill mv2-pill-weak">
                  <ShieldIcon />
                  <span>红灯守护</span>
                </span>
                <span>红灯保护已拦截记录（{normalized.red.length}）</span>
              </summary>
              <ul className="mv2-garden-log-list">
                {normalized.red.map(guard => (
                  <li key={guard.guardId} className="mv2-garden-log-item">
                    <div className="mv2-garden-log-copy">
                      <div className="mv2-card-meta">
                        <span className="mv2-pill mv2-pill-weak">
                          {RED_RULE_LABELS[guard.rule] ?? guard.rule}
                        </span>
                        {guard.assetKind && (
                          <span className="mv2-origin-chip">
                            {ASSET_KIND_LABELS[guard.assetKind] ?? guard.assetKind}
                          </span>
                        )}
                        <span className="mv2-origin-chip">已拦截：{guard.blockedAction}</span>
                      </div>
                      <p className="mv2-garden-log-title">{guard.title}</p>
                      <p className="mv2-garden-log-reason">{guard.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {normalized.excludedCount > 0 && (
            <p className="mv2-garden-footnote">
              本次巡检已依隐私授权自动排除 {normalized.excludedCount} 条已撤回或未授权记录。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
