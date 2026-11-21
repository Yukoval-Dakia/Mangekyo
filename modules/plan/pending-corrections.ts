import type { PlanCandidate } from './today.ts';
import { instant, integer, object, text } from './validation.ts';

// One pending-correction work item on a submitted paper. `source` records which
// grading lane marked it: the attempt's deterministic feedback, a rubric
// assessment, or a formal release assessment.
export type PendingCorrectionItem = {
  itemId: string;
  outcome: 'incorrect' | 'partial';
  source: 'attempt' | 'rubric' | 'formal';
  corrected: boolean;
  evidenceRef: string;
};

// Projection of one submitted attempt on a frozen paper, supplied by the
// activity/organizer side that owns attempt, rubric and correction facts.
export type PendingCorrectionSource = {
  paperId: string;
  paperRev: number;
  attemptId: string;
  attemptRev: number;
  title: string;
  topic?: string;
  submittedAt: string;
  goalId?: string;
  items: readonly PendingCorrectionItem[];
};

export type PendingCorrectionSummary = {
  incorrectCount: number;
  partialCount: number;
  itemIds: readonly string[];
  attemptId: string;
  attemptRev: number;
};

function pendingCorrectionItem(input: unknown): PendingCorrectionItem {
  const row = object(input);
  const outcome = row.outcome;
  if (outcome !== 'incorrect' && outcome !== 'partial') throw new Error('订正题项结果无效。');
  const source = row.source;
  if (source !== 'attempt' && source !== 'rubric' && source !== 'formal')
    throw new Error('订正题项来源无效。');
  if (typeof row.corrected !== 'boolean') throw new Error('订正闭环标记无效。');
  return {
    itemId: text(row.itemId),
    outcome,
    source,
    corrected: row.corrected,
    evidenceRef: text(row.evidenceRef),
  };
}

function pendingCorrectionSource(input: unknown): PendingCorrectionSource {
  const row = object(input);
  if (!Array.isArray(row.items)) throw new Error('订正题项需要列表。');
  return {
    paperId: text(row.paperId),
    paperRev: integer(row.paperRev, 1, Number.MAX_SAFE_INTEGER),
    attemptId: text(row.attemptId),
    attemptRev: integer(row.attemptRev, 1, Number.MAX_SAFE_INTEGER),
    title: text(row.title),
    ...(row.topic === undefined ? {} : { topic: text(row.topic) }),
    submittedAt: instant(row.submittedAt),
    ...(row.goalId === undefined ? {} : { goalId: text(row.goalId) }),
    items: row.items.map(pendingCorrectionItem),
  };
}

export function pendingCorrectionSummary(input: unknown): PendingCorrectionSummary {
  const row = object(input);
  const incorrectCount = integer(row.incorrectCount, 0, Number.MAX_SAFE_INTEGER);
  const partialCount = integer(row.partialCount, 0, Number.MAX_SAFE_INTEGER);
  if (incorrectCount + partialCount < 1) throw new Error('订正汇总为空。');
  if (!Array.isArray(row.itemIds) || !row.itemIds.length) throw new Error('订正题项需要列表。');
  const itemIds = row.itemIds.map(text);
  if (new Set(itemIds).size !== itemIds.length || incorrectCount + partialCount !== itemIds.length)
    throw new Error('订正题项数量与汇总不一致。');
  return {
    incorrectCount,
    partialCount,
    itemIds,
    attemptId: text(row.attemptId),
    attemptRev: integer(row.attemptRev, 1, Number.MAX_SAFE_INTEGER),
  };
}

// The latest submitted attempt wins; ties resolve deterministically so the
// same snapshot always yields one candidate per paper.
function latestAttempt(a: PendingCorrectionSource, b: PendingCorrectionSource) {
  const at = Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
  if (at !== 0) return at > 0 ? a : b;
  if (a.attemptRev !== b.attemptRev) return a.attemptRev > b.attemptRev ? a : b;
  return a.attemptId > b.attemptId ? a : b;
}

function pendingReason(incorrectCount: number, partialCount: number) {
  if (incorrectCount > 0 && partialCount > 0)
    return `上次作答有 ${incorrectCount} 道错题与 ${partialCount} 道部分正确待订正。`;
  if (incorrectCount > 0) return `上次作答有 ${incorrectCount} 道错题待订正。`;
  return `上次作答有 ${partialCount} 道部分正确待订正。`;
}

export function projectPendingCorrectionCandidates(
  sources: readonly PendingCorrectionSource[],
): PlanCandidate[] {
  const latest = new Map<string, PendingCorrectionSource>();
  for (const source of sources.map(pendingCorrectionSource)) {
    const held = latest.get(source.paperId);
    latest.set(source.paperId, held ? latestAttempt(held, source) : source);
  }
  const candidates: PlanCandidate[] = [];
  for (const source of [...latest.values()].sort((a, b) => a.paperId.localeCompare(b.paperId))) {
    const pending = new Map<string, { outcome: PendingCorrectionItem['outcome']; evidenceRefs: Set<string> }>();
    for (const item of source.items) {
      if (item.corrected) continue;
      const held = pending.get(item.itemId);
      if (held) {
        // A deterministic 'incorrect' is never softened by a later 'partial'.
        if (item.outcome === 'incorrect') held.outcome = 'incorrect';
        held.evidenceRefs.add(item.evidenceRef);
      } else {
        pending.set(item.itemId, { outcome: item.outcome, evidenceRefs: new Set([item.evidenceRef]) });
      }
    }
    const itemIds = [...pending.keys()].sort((a, b) => a.localeCompare(b));
    if (!itemIds.length) continue;
    const items = itemIds.map(itemId => pending.get(itemId)!);
    const incorrectCount = items.filter(item => item.outcome === 'incorrect').length;
    const partialCount = itemIds.length - incorrectCount;
    const title = source.title.includes('订正') ? source.title : source.title + ' · 错题订正';
    candidates.push({
      id: `correction:${source.paperId}@${source.paperRev}`,
      title,
      topic: source.topic?.trim() || source.title.trim(),
      kind: 'review',
      // Cap at 15 min so large mistake sets still fit Today's default 15-min assumed budget.
      minutes: Math.min(15, Math.max(3, itemIds.length * 3)),
      durationBasis: itemIds.length > 5
        ? `共 ${itemIds.length} 题待订正，本轮先安排 15 分钟优先订正。`
        : `按待订正 ${itemIds.length} 题、每题约 3 分钟估算。`,
      input: 'write',
      open: { kind: 'activity', id: source.paperId, rev: source.paperRev },
      reason: pendingReason(incorrectCount, partialCount),
      evidence: [...new Set([`${source.attemptId}@${source.attemptRev}`, ...items.flatMap(item => [...item.evidenceRefs])])],
      delayImpact: '推迟后，已暴露的错题与部分正确失分点会继续悬空，容易在下次同类题重犯。',
      ...(source.goalId === undefined ? {} : { goalId: source.goalId }),
      pendingCorrection: {
        incorrectCount,
        partialCount,
        itemIds,
        attemptId: source.attemptId,
        attemptRev: source.attemptRev,
      },
    });
  }
  return candidates;
}
