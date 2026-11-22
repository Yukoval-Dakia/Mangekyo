import { instant, integer, object, oneOf, text } from './validation.ts';

export type ConceptMasteryState = 'solid' | 'fading' | 'weak' | 'unknown';
export type NodePracticeQuestionOutcome = 'correct' | 'incorrect' | 'partial' | 'unknown' | null;
export type NodePracticeHelpLevel = 'independent' | 'hinted' | 'unknown' | null;

export type ConceptNodeTarget = {
  readonly id: string;
  readonly title: string;
  readonly masteryState: ConceptMasteryState;
  readonly directPrerequisiteIds: readonly string[];
};

export type NodePracticeCandidate = {
  readonly questionRef: string;
  readonly conceptId?: string;
  readonly archetypeId?: string | null;
  readonly lastOutcome: NodePracticeQuestionOutcome;
  readonly helpLevel: NodePracticeHelpLevel;
  readonly lastAttemptedAt: string | null;
  readonly isRedPenError: boolean;
  readonly informationGain?: number;
  readonly evidenceRef?: string;
};

export type SelectNodePracticeInput = {
  readonly node: ConceptNodeTarget;
  readonly candidates: readonly NodePracticeCandidate[];
  readonly now?: string;
  readonly limit?: number;
};

export type NodePracticeReasonTag =
  | 'red-pen-error'
  | 'unmastered-wrong'
  | 'hinted-only-correct'
  | 'unverified-high-info'
  | 'stale-review';

export type NodePracticeBasisItem = {
  readonly questionRef: string;
  readonly conceptId: string;
  readonly scope: 'target' | 'prerequisite';
  readonly archetypeId: string | null;
  readonly priority: NodePracticeReasonTag;
  readonly evidenceRef: string;
};

export type NodePracticeSelection =
  | {
      readonly kind: 'empty';
      readonly suggestedAction: 'start_classroom';
      readonly reason: '该知识点尚未收录可自测题，建议先开 10 分钟微课或拍入相关练习。';
    }
  | {
      readonly kind: 'ready';
      readonly title: string;
      readonly questionRefs: readonly string[];
      readonly reason: string;
      readonly basis: readonly NodePracticeBasisItem[];
    };

const EMPTY_REASON = '该知识点尚未收录可自测题，建议先开 10 分钟微课或拍入相关练习。' as const;
const masteryStates = ['solid', 'fading', 'weak', 'unknown'] as const;
const outcomes = ['correct', 'incorrect', 'partial', 'unknown'] as const;
const helpLevels = ['independent', 'hinted', 'unknown'] as const;

const priorityRank: Readonly<Record<NodePracticeReasonTag, number>> = {
  'red-pen-error': 0,
  'unmastered-wrong': 1,
  'hinted-only-correct': 2,
  'unverified-high-info': 3,
  'stale-review': 4,
};

type NormalizedCandidate = {
  readonly questionRef: string;
  readonly conceptId: string;
  readonly scope: 'target' | 'prerequisite';
  readonly archetypeId: string | null;
  readonly priority: NodePracticeReasonTag;
  readonly outcomeRank: number;
  readonly attemptedMs: number | null;
  readonly informationGain: number;
  readonly evidenceRef: string;
};

function defaultLimit(state: ConceptMasteryState) {
  if (state === 'weak') return 5;
  if (state === 'solid') return 3;
  return 4;
}

function optionalText(value: unknown): string | null {
  return value === undefined || value === null ? null : text(value);
}

function optionalUnitInterval(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error('信息增益超出范围。');
  return value;
}

function parseNode(input: unknown): ConceptNodeTarget {
  const row = object(input);
  if (!Array.isArray(row.directPrerequisiteIds)) throw new Error('先修节点需要列表。');
  return {
    id: text(row.id),
    title: text(row.title),
    masteryState: oneOf(row.masteryState, masteryStates),
    directPrerequisiteIds: [...new Set(row.directPrerequisiteIds.map(text))],
  };
}

function classifyPriority(
  isRedPenError: boolean,
  lastOutcome: NodePracticeQuestionOutcome,
  helpLevel: NodePracticeHelpLevel,
): NodePracticeReasonTag {
  // S11: only an independently completed correct attempt counts as mastered.
  const independentMastered = lastOutcome === 'correct' && helpLevel === 'independent';
  if (isRedPenError && !independentMastered) return 'red-pen-error';
  if (lastOutcome === 'incorrect' || lastOutcome === 'partial') return 'unmastered-wrong';
  if (lastOutcome === 'correct' && helpLevel === 'hinted') return 'hinted-only-correct';
  if (!independentMastered) return 'unverified-high-info';
  return 'stale-review';
}

function parseCandidate(
  input: unknown,
  nodeId: string,
  prerequisites: ReadonlySet<string>,
): NormalizedCandidate | null {
  const row = object(input);
  if (typeof row.isRedPenError !== 'boolean') throw new Error('红笔错题标记无效。');
  const questionRef = text(row.questionRef);
  const conceptId = row.conceptId === undefined ? nodeId : text(row.conceptId);
  const lastOutcome: NodePracticeQuestionOutcome =
    row.lastOutcome === null ? null : oneOf(row.lastOutcome, outcomes);
  const helpLevel: NodePracticeHelpLevel =
    row.helpLevel === null ? null : oneOf(row.helpLevel, helpLevels);
  const lastAttemptedAt = row.lastAttemptedAt === null ? null : instant(row.lastAttemptedAt);
  const archetypeId = optionalText(row.archetypeId);
  const informationGain = optionalUnitInterval(row.informationGain);
  const evidenceRef = row.evidenceRef === undefined ? questionRef : text(row.evidenceRef);

  const scope = conceptId === nodeId ? 'target' : prerequisites.has(conceptId) ? 'prerequisite' : null;
  if (!scope) return null;

  return {
    questionRef,
    conceptId,
    scope,
    archetypeId,
    priority: classifyPriority(row.isRedPenError, lastOutcome, helpLevel),
    outcomeRank: lastOutcome === 'incorrect' ? 0 : lastOutcome === 'partial' ? 1 : 2,
    attemptedMs: lastAttemptedAt === null ? null : Date.parse(lastAttemptedAt),
    informationGain: informationGain ?? (lastOutcome === null || lastOutcome === 'unknown' ? 0.5 : 0),
    evidenceRef,
  };
}

function compareCandidates(a: NormalizedCandidate, b: NormalizedCandidate): number {
  const byPriority = priorityRank[a.priority] - priorityRank[b.priority];
  if (byPriority !== 0) return byPriority;
  if (a.outcomeRank !== b.outcomeRank) return a.outcomeRank - b.outcomeRank;
  const byScope = (a.scope === 'target' ? 0 : 1) - (b.scope === 'target' ? 0 : 1);
  if (byScope !== 0) return byScope;
  if (a.priority === 'unverified-high-info') {
    const byInfo = b.informationGain - a.informationGain;
    if (byInfo !== 0) return byInfo;
  }
  const aTime = a.attemptedMs ?? Number.NEGATIVE_INFINITY;
  const bTime = b.attemptedMs ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  const byInfo = b.informationGain - a.informationGain;
  if (byInfo !== 0) return byInfo;
  return a.questionRef.localeCompare(b.questionRef);
}

function buildReason(selected: readonly NormalizedCandidate[], foldedCount: number): string {
  const parts: string[] = [];
  const redPen = selected.filter(item => item.priority === 'red-pen-error').length;
  const wrong = selected.filter(item => item.priority === 'unmastered-wrong').length;
  const hinted = selected.filter(item => item.priority === 'hinted-only-correct').length;
  const unverified = selected.filter(item => item.priority === 'unverified-high-info').length;
  const stale = selected.filter(item => item.priority === 'stale-review').length;
  const hasPrereq = selected.some(item => item.scope === 'prerequisite');
  if (redPen > 0) parts.push(`优先纳入 ${redPen} 道红笔错题`);
  if (wrong > 0) parts.push(`${redPen > 0 ? '' : '优先纳入 '}${wrong} 道未独立做对题`);
  if (hinted > 0) parts.push(`${hinted} 道曾受助做对题需独立复核`);
  if (unverified > 0) parts.push(`${unverified} 道尚待核对题补足辨别证据`);
  if (stale > 0) parts.push(`${stale} 道距今较久题间隔复测`);
  if (hasPrereq) parts.push('并衔接直接先修薄弱点');
  if (foldedCount > 0) parts.push(`已按母题原型折叠跳过 ${foldedCount} 道同型变式`);
  const lead = hasPrereq
    ? `已选取 ${selected.length} 道练习题`
    : `已选取该知识点下的 ${selected.length} 道练习题`;
  return `${lead}：${parts.join('，')}。`;
}

export function selectQuestionsForConceptNode(input: SelectNodePracticeInput): NodePracticeSelection {
  const row = object(input);
  const node = parseNode(row.node);
  if (!Array.isArray(row.candidates)) throw new Error('候选题目需要列表。');
  if (row.now !== undefined) instant(row.now);
  const limit = row.limit === undefined ? defaultLimit(node.masteryState) : integer(row.limit, 1, 5);
  const prerequisites = new Set(node.directPrerequisiteIds.filter(id => id !== node.id));

  // Deduplicate identical questionRef deterministically by keeping the highest-priority view.
  const byRef = new Map<string, NormalizedCandidate>();
  for (const raw of row.candidates) {
    const parsed = parseCandidate(raw, node.id, prerequisites);
    if (!parsed) continue;
    const held = byRef.get(parsed.questionRef);
    if (!held || compareCandidates(parsed, held) < 0) byRef.set(parsed.questionRef, parsed);
  }

  const ordered = [...byRef.values()].sort(compareCandidates);
  const seenArchetypes = new Set<string>();
  const selected: NormalizedCandidate[] = [];
  let foldedCount = 0;

  for (const candidate of ordered) {
    if (candidate.archetypeId !== null) {
      if (seenArchetypes.has(candidate.archetypeId)) {
        foldedCount += 1;
        continue;
      }
      seenArchetypes.add(candidate.archetypeId);
    }
    selected.push(candidate);
    if (selected.length >= limit) break;
  }

  if (!selected.length) {
    return { kind: 'empty', suggestedAction: 'start_classroom', reason: EMPTY_REASON };
  }

  const title = node.title.endsWith('自测') ? node.title : `${node.title} · 节点自测`;
  return {
    kind: 'ready',
    title,
    questionRefs: selected.map(item => item.questionRef),
    reason: buildReason(selected, foldedCount),
    basis: selected.map(item => ({
      questionRef: item.questionRef,
      conceptId: item.conceptId,
      scope: item.scope,
      archetypeId: item.archetypeId,
      priority: item.priority,
      evidenceRef: item.evidenceRef,
    })),
  };
}
