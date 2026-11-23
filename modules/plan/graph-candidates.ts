import type { PlanRule } from './rules.ts';
import type { PlanCandidate } from './today.ts';

export type GraphConceptCandidateSource = {
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly subject?: string;
  readonly semesterTag?: string;
  readonly masteryLevel: 'unknown' | 'fragile' | 'developing' | 'solid';
  readonly retrievability: number | null;
  readonly errorStageCount: number;
  readonly linkedQuestionCount: number;
  readonly linkedAttemptCount: number;
  readonly goalId?: string;
};

type ExamScopeInfo = {
  readonly scopeTerms: readonly string[];
  readonly weightByTerm: ReadonlyMap<string, number>;
  readonly currentTopics: ReadonlySet<string>;
  readonly recovery: boolean;
};

function norm(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

function extractRuleSignals(rules: readonly PlanRule[]): ExamScopeInfo {
  const scopeSet = new Set<string>();
  const weightByTerm = new Map<string, number>();
  const currentTopics = new Set<string>();
  let recovery = false;

  for (const rule of rules) {
    if (rule.kind === 'exam') {
      for (const topic of rule.scope) {
        const key = norm(topic);
        if (key) scopeSet.add(key);
      }
      for (const w of rule.weights) {
        const key = norm(w.topic);
        if (key) weightByTerm.set(key, Math.max(weightByTerm.get(key) ?? 0, w.weight));
      }
    } else if (rule.kind === 'progress' && rule.stage === 'current') {
      const key = norm(rule.topic);
      if (key) currentTopics.add(key);
    } else if (rule.kind === 'campaign') {
      recovery = rule.campaign === 'recovery';
    }
  }
  return { scopeTerms: [...scopeSet], weightByTerm, currentTopics, recovery };
}

function matchExamWeight(source: GraphConceptCandidateSource, info: ExamScopeInfo): { inExam: boolean; weight: number; inProgress: boolean } {
  const haystacks = [source.title, source.subject ?? ''].map(norm).filter(Boolean);
  let inExam = false;
  let weight = 0;
  for (const term of info.scopeTerms) {
    if (haystacks.some((h) => h.includes(term) || term.includes(h))) {
      inExam = true;
      weight = Math.max(weight, info.weightByTerm.get(term) ?? 10);
    }
  }
  const inProgress = [...info.currentTopics].some((term) => haystacks.some((h) => h.includes(term) || term.includes(h)));
  return { inExam, weight, inProgress };
}

function priorityScore(source: GraphConceptCandidateSource, inExam: boolean, examWeight: number, inProgress: boolean): number {
  let score = 0;
  if (source.masteryLevel === 'fragile') score += 90;
  else if (source.masteryLevel === 'unknown') score += 65;
  else if (source.masteryLevel === 'developing') score += 45;
  else score += 10;
  score += Math.min(40, source.errorStageCount * 20);
  if (inExam) score += 25 + Math.min(35, examWeight);
  if (inProgress) score += 18;
  if (source.linkedQuestionCount > 0) score += 15;
  if (source.retrievability !== null && source.retrievability < 0.65) {
    score += Math.round((0.65 - source.retrievability) * 40);
  }
  return score;
}

/**
 * Project knowledge-graph concepts, linked bank questions, mastery/error signals,
 * and exam scope rules into real `/today` `PlanCandidate` entries.
 */
export function projectGraphAndBankCandidates(
  sources: readonly GraphConceptCandidateSource[],
  rules: readonly PlanRule[],
  options?: { readonly limit?: number },
): PlanCandidate[] {
  const limit = options?.limit ?? 6;
  const info = extractRuleSignals(rules);

  const ranked = sources
    .filter((s) => s.title.trim().length > 0)
    .map((source) => {
      const { inExam, weight, inProgress } = matchExamWeight(source, info);
      const needsAttention =
        source.masteryLevel !== 'solid' || source.errorStageCount > 0 || inExam || inProgress;
      return {
        source,
        inExam,
        weight,
        inProgress,
        needsAttention,
        priority: priorityScore(source, inExam, weight, inProgress),
      };
    })
    .filter((entry) => entry.needsAttention)
    .sort((a, b) => b.priority - a.priority || a.source.id.localeCompare(b.source.id))
    .slice(0, limit);

  return ranked.map(({ source, inExam, weight, inProgress }) => {
    const isWeak = source.masteryLevel === 'fragile' || source.errorStageCount > 0;
    const isUnknown = source.masteryLevel === 'unknown';
    const kind: PlanCandidate['kind'] = info.recovery
      ? 'recovery'
      : isWeak
        ? 'review'
        : isUnknown
          ? 'probe'
          : 'review';
    const minutes = info.recovery
      ? 5
      : source.linkedQuestionCount > 0
        ? Math.min(12, Math.max(6, source.linkedQuestionCount * 3))
        : 6;

    const title = isWeak
      ? `巩固薄弱概念：${source.title}`
      : isUnknown
        ? source.linkedQuestionCount > 0
          ? `摸底自测：${source.title}（${source.linkedQuestionCount} 题）`
          : `冷启动摸底：${source.title}`
        : `进阶巩固：${source.title}`;

    const reasonBits: string[] = [];
    if (source.errorStageCount > 0) reasonBits.push(`存在 ${source.errorStageCount} 条未闭环错因`);
    else if (source.masteryLevel === 'fragile') reasonBits.push('当前掌握度薄弱');
    else if (isUnknown) reasonBits.push('尚未形成独立作答掌握证据');
    if (inExam) reasonBits.push(weight > 0 ? `位于考试范围内（权重约 ${weight}%）` : '位于考试范围内');
    if (inProgress) reasonBits.push('属于当前推进主题');
    if (source.linkedQuestionCount > 0) reasonBits.push(`题库已关联 ${source.linkedQuestionCount} 道题可直接开练`);

    const ref = `concept:${source.id}@${source.rev}`;
    const retention =
      source.retrievability !== null
        ? source.retrievability
        : isWeak
          ? 0.35
          : source.masteryLevel === 'developing'
            ? 0.65
            : undefined;
    const information = isUnknown ? (source.linkedQuestionCount > 0 ? 0.82 : 0.72) : undefined;

    return {
      id: ref,
      title,
      topic: source.subject ? `${source.subject} · ${source.title}` : source.title,
      kind,
      minutes,
      durationBasis:
        source.linkedQuestionCount > 0
          ? `关联 ${source.linkedQuestionCount} 道题，按 ${minutes} 分钟集中摸底/巩固估算。`
          : `按 ${minutes} 分钟单概念快速梳理与摸底估算。`,
      input: 'tap',
      open: { kind: 'activity', id: source.id, rev: source.rev },
      reason: reasonBits.join('，') || '来自知识图谱与学习档案的待巩固概念。',
      evidence: [ref],
      delayImpact: isWeak
        ? '推迟后该薄弱概念的错因会继续影响后续关联题型与综合卷表现。'
        : '推迟后该概念仍缺少独立作答证据，后续计划难以精准分配复习权重。',
      ...(source.goalId ? { goalId: source.goalId } : {}),
      ...(retention !== undefined ? { retention } : {}),
      ...(information !== undefined ? { information } : {}),
    };
  });
}
