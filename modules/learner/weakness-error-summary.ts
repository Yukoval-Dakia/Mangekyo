import type { EvidenceEventV1 } from '@mangekyo/kernel';
import { evidenceTime, instant } from './memory-evidence.ts';

export type ErrorStage = NonNullable<EvidenceEventV1['error_stage']>;
export type WeaknessNextAction = 'quick_paper' | 'start_classroom' | 'review_mistake';

export type WeaknessEvidenceRef = {
  readonly id: string;
  readonly rev: number;
  readonly itemId?: string;
  readonly href?: string;
};

export type WeaknessErrorSample = {
  readonly evidenceRef: WeaknessEvidenceRef;
  readonly occurredAt: string;
  readonly outcome: 'incorrect' | 'partial' | 'correct' | 'unknown';
  readonly helpLevel: 'independent' | 'hinted' | 'hint_l1' | 'hint_l2' | 'solution_seen' | 'unknown';
  readonly errorStage?: ErrorStage | null | undefined;
  readonly conceptId?: string | undefined;
  readonly corrected?: boolean | undefined;
};

export type WeaknessConceptInput = {
  readonly conceptId: string;
  readonly title: string;
  readonly status: 'solid' | 'steady' | 'fading' | 'decaying' | 'weak' | 'fragile' | 'unknown';
  readonly retrievability: number | null;
  readonly independentAttempts: number;
  readonly uncorrectedErrorCount?: number;
  readonly hasPracticeQuestions?: boolean;
  readonly evidenceRefs?: readonly WeaknessEvidenceRef[];
};

export type WeaknessAndErrorSummaryInput = {
  readonly asOf: string;
  readonly minSamples?: number;
  readonly recentWindowDays?: number;
  readonly errorSamples: readonly WeaknessErrorSample[];
  readonly concepts: readonly WeaknessConceptInput[];
};

export type TopErrorStageSummary = {
  readonly stage: ErrorStage;
  readonly label: string;
  readonly count: number;
  readonly recentWeight: number;
  readonly advice: string;
  readonly evidenceRefs: readonly WeaknessEvidenceRef[];
};

export type PriorityConceptSummary = {
  readonly conceptId: string;
  readonly title: string;
  readonly status: 'weak' | 'fading';
  readonly retrievability: number | null;
  readonly uncorrectedErrorCount: number;
  readonly nextAction: WeaknessNextAction;
  readonly reason: string;
  readonly evidenceRefs: readonly WeaknessEvidenceRef[];
};

export type WeaknessAndErrorSummaryView =
  | {
      readonly asOf: string;
      readonly status: 'insufficient_evidence';
      readonly sampleCount: number;
      readonly neededCount: number;
      readonly topErrorStages: readonly [];
      readonly priorityConcepts: readonly [];
      readonly summary: string;
    }
  | {
      readonly asOf: string;
      readonly status: 'ready';
      readonly sampleCount: number;
      readonly neededCount: number;
      readonly topErrorStages: readonly TopErrorStageSummary[];
      readonly priorityConcepts: readonly PriorityConceptSummary[];
      readonly summary: string;
    };

const dayMs = 86_400_000;
const defaultMinSamples = 2;
const defaultRecentWindowDays = 30;
const stageOrder: readonly ErrorStage[] = ['reading', 'modeling', 'strategy', 'execution', 'expression'];

const stageCopy: Readonly<Record<ErrorStage, { readonly label: string; readonly hint: string }>> = {
  reading: {
    label: '审题与条件读取',
    hint: '交卷前先逐条圈出已知条件与限定范围，再动笔推导。',
  },
  modeling: {
    label: '概念与建模',
    hint: '先用自己的话写出核心关系式并核对适用条件，再代入数值。',
  },
  strategy: {
    label: '思路与策略选择',
    hint: '卡壳时先列两种可能切入路径，挑步骤更短的一条验证。',
  },
  execution: {
    label: '计算与过程执行',
    hint: '关键变形多写一步中间量，交卷前用特殊值或量纲反检。',
  },
  expression: {
    label: '规范表达与作答',
    hint: '最后核对单位、正负号、区间开闭与结论是否完整回应题问。',
  },
};

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 240 && trimmed.isWellFormed() && !trimmed.includes('\0') ? trimmed : undefined;
}

function validRef(ref: WeaknessEvidenceRef | undefined): WeaknessEvidenceRef | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const id = cleanText(ref.id);
  if (!id || !Number.isSafeInteger(ref.rev) || ref.rev < 1) return undefined;
  const itemId = ref.itemId === undefined ? undefined : cleanText(ref.itemId);
  if (ref.itemId !== undefined && !itemId) return undefined;
  const href = ref.href === undefined ? undefined : cleanText(ref.href);
  if (ref.href !== undefined && (!href || !/^\/(?!\/)[^\\\s]*$/u.test(href))) return undefined;
  return {
    id,
    rev: ref.rev,
    ...(itemId === undefined ? {} : { itemId }),
    ...(href === undefined ? {} : { href }),
  };
}

function refKey(ref: WeaknessEvidenceRef): string {
  return JSON.stringify([ref.id, ref.itemId ?? '']);
}

function uniqueRefs(refs: readonly WeaknessEvidenceRef[], limit = 5): readonly WeaknessEvidenceRef[] {
  const seen = new Set<string>();
  const result: WeaknessEvidenceRef[] = [];
  for (const raw of refs) {
    const ref = validRef(raw);
    if (!ref) continue;
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeConceptStatus(status: WeaknessConceptInput['status']): 'weak' | 'fading' | null {
  if (status === 'weak' || status === 'fragile') return 'weak';
  if (status === 'fading' || status === 'decaying') return 'fading';
  return null;
}

function conceptAction(concept: {
  readonly uncorrectedErrorCount: number;
  readonly hasPracticeQuestions?: boolean;
}): WeaknessNextAction {
  if (concept.uncorrectedErrorCount > 0) return 'review_mistake';
  if (concept.hasPracticeQuestions === false) return 'start_classroom';
  return 'quick_paper';
}

function conceptReason(
  status: 'weak' | 'fading',
  uncorrectedErrorCount: number,
  retrievability: number | null,
  nextAction: WeaknessNextAction,
): string {
  const parts: string[] = [];
  if (uncorrectedErrorCount > 0) parts.push(`还有 ${uncorrectedErrorCount} 道未订正错题`);
  parts.push(status === 'weak' ? '独立掌握度偏薄弱' : '近期记忆有回落趋势');
  if (retrievability !== null) parts.push(`当前可提取度约 ${Math.round(retrievability * 100)}%`);
  const actionText = nextAction === 'review_mistake'
    ? '建议先补完原卷订正'
    : nextAction === 'start_classroom'
      ? '题库尚缺自测题，建议先开 10 分钟微课'
      : '建议抽 3–5 题做独立自测巩固';
  return `${parts.join('，')}，${actionText}。`;
}

export function projectWeaknessAndErrorSummary(input: WeaknessAndErrorSummaryInput): WeaknessAndErrorSummaryView {
  const asOf = instant(input.asOf);
  const asOfMs = evidenceTime(asOf);
  const neededCount = input.minSamples === undefined ? defaultMinSamples : input.minSamples;
  const windowDays = input.recentWindowDays === undefined ? defaultRecentWindowDays : input.recentWindowDays;
  if (!Number.isSafeInteger(neededCount) || neededCount < 2) throw new Error('最小样本门槛至少为 2。');
  if (!Number.isSafeInteger(windowDays) || windowDays < 7 || windowDays > 180) throw new Error('近期统计窗口超出范围。');

  const halfLifeDays = Math.max(7, windowDays / 2);
  const validStageSet = new Set<string>(stageOrder);

  // S11: only independent incorrect/partial samples with valid refs count.
  // One wrong question linked to multiple concepts is deduplicated by (submissionId, itemId)
  // while still recording every linked conceptId so none are double-counted below.
  const sampledConceptIds = new Set<string>();
  const independentErrorKeys = new Set<string>();
  const dedupedSamples = new Map<string, {
    readonly stage: ErrorStage;
    readonly occurredMs: number;
    readonly weight: number;
    readonly ref: WeaknessEvidenceRef;
  }>();
  for (const sample of input.errorSamples) {
    if (sample.helpLevel !== 'independent') continue;
    if (sample.outcome !== 'incorrect' && sample.outcome !== 'partial') continue;
    const ref = validRef(sample.evidenceRef);
    const occurredMs = evidenceTime(sample.occurredAt);
    if (!ref || !Number.isFinite(occurredMs) || occurredMs > asOfMs) continue;
    const key = refKey(ref);
    independentErrorKeys.add(key);
    const conceptId = cleanText(sample.conceptId);
    if (conceptId !== undefined) sampledConceptIds.add(conceptId);
    if (!sample.errorStage || !validStageSet.has(sample.errorStage)) continue;
    if (dedupedSamples.has(key)) continue;
    const ageDays = Math.max(0, (asOfMs - occurredMs) / dayMs);
    const weight = Math.pow(0.5, ageDays / halfLifeDays);
    dedupedSamples.set(key, {
      stage: sample.errorStage,
      occurredMs,
      weight,
      ref,
    });
  }

  const samples = [...dedupedSamples.values()];

  // Aggregate priority concepts (weak / fading with independent evidence or uncorrected errors).
  const byConcept = new Map<string, {
    readonly conceptId: string;
    readonly title: string;
    readonly status: 'weak' | 'fading';
    readonly retrievability: number | null;
    readonly independentAttempts: number;
    readonly uncorrectedErrorCount: number;
    readonly hasPracticeQuestions?: boolean;
    readonly evidenceRefs: readonly WeaknessEvidenceRef[];
  }>();
  for (const row of input.concepts) {
    const conceptId = cleanText(row.conceptId);
    const title = cleanText(row.title);
    const status = normalizeConceptStatus(row.status);
    if (!conceptId || !title || !status) continue;
    const attempts = Number.isSafeInteger(row.independentAttempts) && row.independentAttempts >= 0 ? row.independentAttempts : 0;
    const uncorrected = row.uncorrectedErrorCount !== undefined && Number.isSafeInteger(row.uncorrectedErrorCount) && row.uncorrectedErrorCount >= 0
      ? row.uncorrectedErrorCount : 0;
    if (attempts < 1 && uncorrected < 1) continue;
    const retrievability = row.retrievability !== null && Number.isFinite(row.retrievability) && row.retrievability >= 0 && row.retrievability <= 1
      ? row.retrievability : null;
    const refs = uniqueRefs(row.evidenceRefs ?? []);
    const prior = byConcept.get(conceptId);
    if (!prior || (status === 'weak' && prior.status !== 'weak') || uncorrected > prior.uncorrectedErrorCount) {
      byConcept.set(conceptId, {
        conceptId,
        title,
        status: prior?.status === 'weak' ? 'weak' : status,
        retrievability,
        independentAttempts: Math.max(attempts, prior?.independentAttempts ?? 0),
        uncorrectedErrorCount: Math.max(uncorrected, prior?.uncorrectedErrorCount ?? 0),
        ...(row.hasPracticeQuestions === undefined ? {} : { hasPracticeQuestions: row.hasPracticeQuestions }),
        evidenceRefs: refs.length ? refs : (prior?.evidenceRefs ?? []),
      });
    }
  }

  // Never double-count one independent attempt across multiple linked concepts.
  const extraWeakConceptSamples = [...byConcept.values()].filter(
    concept => concept.independentAttempts >= 1 && !sampledConceptIds.has(concept.conceptId),
  ).length;
  const sampleCount = independentErrorKeys.size + extraWeakConceptSamples;

  if (sampleCount < neededCount) {
    const missing = neededCount - sampleCount;
    return {
      asOf,
      status: 'insufficient_evidence',
      sampleCount,
      neededCount,
      topErrorStages: [],
      priorityConcepts: [],
      summary: `还差 ${missing} 条独立错题或复盘记录，积累后这里会总结你最常卡住的环节。`,
    };
  }

  const byStage = new Map<ErrorStage, typeof samples>();
  for (const sample of samples) {
    const group = byStage.get(sample.stage);
    if (group) group.push(sample);
    else byStage.set(sample.stage, [sample]);
  }
  const topErrorStages: TopErrorStageSummary[] = [...byStage.entries()]
    .map(([stage, rows]) => {
      const ordered = [...rows].sort((a, b) => b.occurredMs - a.occurredMs || refKey(a.ref).localeCompare(refKey(b.ref)));
      const weight = Number(ordered.reduce((sum, row) => sum + row.weight, 0).toFixed(2));
      const { label, hint } = stageCopy[stage];
      return {
        stage,
        label,
        count: ordered.length,
        recentWeight: weight,
        advice: `近期 ${ordered.length} 次独立错题集中在${label}环节，${hint}`,
        evidenceRefs: uniqueRefs(ordered.map(row => row.ref)),
      };
    })
    .sort((a, b) => b.count - a.count || b.recentWeight - a.recentWeight ||
      stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage));

  const priorityConcepts: PriorityConceptSummary[] = [...byConcept.values()]
    .sort((a, b) => {
      const byStatus = (a.status === 'weak' ? 0 : 1) - (b.status === 'weak' ? 0 : 1);
      if (byStatus !== 0) return byStatus;
      if (b.uncorrectedErrorCount !== a.uncorrectedErrorCount) return b.uncorrectedErrorCount - a.uncorrectedErrorCount;
      const aRet = a.retrievability ?? 0.5;
      const bRet = b.retrievability ?? 0.5;
      if (aRet !== bRet) return aRet - bRet;
      return a.conceptId.localeCompare(b.conceptId);
    })
    .slice(0, 5)
    .map(concept => {
      const nextAction = conceptAction(concept);
      return {
        conceptId: concept.conceptId,
        title: concept.title,
        status: concept.status,
        retrievability: concept.retrievability,
        uncorrectedErrorCount: concept.uncorrectedErrorCount,
        nextAction,
        reason: conceptReason(concept.status, concept.uncorrectedErrorCount, concept.retrievability, nextAction),
        evidenceRefs: concept.evidenceRefs,
      };
    });

  const leadStage = topErrorStages[0];
  const leadConcept = priorityConcepts[0];
  const summaryParts: string[] = [];
  if (leadStage) summaryParts.push(`近期最常卡在「${leadStage.label}」（${leadStage.count} 次独立错题）`);
  if (leadConcept) summaryParts.push(`优先巩固「${leadConcept.title}」`);
  const summary = summaryParts.length
    ? `${summaryParts.join('，')}。`
    : `已积累 ${sampleCount} 条独立学习证据，当前暂无集中薄弱环节。`;

  return {
    asOf,
    status: 'ready',
    sampleCount,
    neededCount,
    topErrorStages,
    priorityConcepts,
    summary,
  };
}
