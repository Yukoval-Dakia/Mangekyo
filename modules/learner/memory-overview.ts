import type { BusWitness, FactId, FactSnapshot, LearnerId, Revision, Tick } from '@mangekyo/kernel';
import { allows, evidenceTime, instant, text } from './memory-evidence.ts';

export type MemoryOverviewScope = {
  readonly learner: LearnerId;
  readonly purpose: string;
  readonly recipientId: string;
  readonly asOf: string;
  readonly clockWatermark: Tick;
};

type MemoryCalibrationCounts = {
  readonly classified?: number;
  readonly matched?: number;
  readonly eligible?: number;
  readonly contaminated?: number;
  readonly missingIndependent?: number;
};

export type MemoryRetentionCase = {
  readonly exposure: 'independent' | 'exposed' | 'unknown' | null;
  readonly observed: 'correct' | 'incorrect' | 'unknown' | null;
  readonly recorded: {
    readonly status: string;
    readonly estimate?: { readonly kind: string; expected?: 'correct' | 'incorrect'; probability?: number };
  };
};

type MemoryCalibrationSummary = MemoryCalibrationCounts & {
  readonly state?: 'empty' | 'awaiting-independent' | 'ready';
  readonly forecasts?: number;
  readonly recorded?: MemoryCalibrationCounts;
  readonly cases?: readonly MemoryRetentionCase[];
};

export type MemoryCalibrationSource = MemoryCalibrationSummary | readonly MemoryRetentionCase[];

type MemoryNodeState = 'solid' | 'fading' | 'weak' | 'unknown';

export type MemoryCognitionStatus =
  | MemoryNodeState
  | 'steady' | 'decaying' | 'fragile'
  | { readonly status: MemoryNodeState | 'steady' | 'decaying' | 'fragile' };

export type MemoryRecentChangeKind = 'correction' | 'independent-evidence' | 'revocation' | 'plan-adjustment';

export type MemoryRecentChange = {
  readonly occurredAt: string;
  readonly reasonKind: MemoryRecentChangeKind;
  readonly subjectLabel?: string;
  readonly witnesses: readonly BusWitness[];
};

export type MemoryAuthorizedRecentChange = {
  readonly occurredAt: string;
  readonly reasonKind: MemoryRecentChangeKind;
  readonly subjectLabel?: string;
  readonly evidenceRefs: readonly { readonly id: FactId; readonly rev: Revision }[];
};

export type MemoryExamForecast =
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'value'; readonly value: { readonly low: number; readonly high: number; readonly maximum: number } };

export type MemoryOverviewProjectionRequest = MemoryOverviewScope & {
  readonly calibration?: MemoryCalibrationSource;
  readonly cognition?: readonly MemoryCognitionStatus[];
  readonly recentChanges?: readonly MemoryAuthorizedRecentChange[];
  readonly examOutlook?: MemoryExamForecast;
};

export type MemoryOverviewRequest = Omit<MemoryOverviewProjectionRequest, 'recentChanges'> & {
  readonly recentChanges?: readonly MemoryRecentChange[];
};

export type MemoryOverviewSources = {
  readonly reopen: (scope: MemoryOverviewScope, ref: BusWitness) => Promise<FactSnapshot | undefined>;
};

export type MemoryOverviewView = {
  readonly asOf: string;
  readonly calibration: {
    readonly state: 'ready' | 'awaiting-evidence' | 'empty';
    readonly hitRatePercent: number | null;
    readonly matchedCount: number;
    readonly sampleCount: number;
    readonly awaitingIndependentCount: number;
    readonly headline: string;
  };
  readonly cognition: {
    readonly totalCount: number;
    readonly solidCount: number;
    readonly fadingCount: number;
    readonly weakCount: number;
    readonly unknownCount: number;
    readonly unknownLabel: '尚待核对';
    readonly headline: string;
  };
  readonly recentChanges: readonly {
    readonly occurredAt: string;
    readonly kind: MemoryRecentChangeKind;
    readonly summary: string;
    readonly evidenceRefs: readonly { readonly id: FactId; readonly rev: Revision }[];
  }[];
  readonly examOutlook?: { readonly state: 'ready' | 'unknown'; readonly headline: string };
};

function count(value: number | undefined, label: string) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`记忆概况${label}无效。`);
  return value;
}

function caseCounts(cases: readonly MemoryRetentionCase[]) {
  const totals = { eligible: 0, classified: 0, matched: 0, contaminated: 0, missingIndependent: 0 };
  for (const row of cases) {
    const independent = row.recorded.status === 'matched' || row.recorded.status === 'missed' ||
      row.recorded.status === 'observed';
    if (!independent || row.exposure !== 'independent' || (row.observed !== 'correct' && row.observed !== 'incorrect')) {
      if (row.recorded.status === 'contaminated') totals.contaminated++;
      else totals.missingIndependent++;
      continue;
    }
    totals.eligible++;
    const estimate = row.recorded.estimate;
    const probability = estimate?.probability;
    const expected = estimate?.kind === 'categorical' ? estimate.expected
      : estimate?.kind === 'probabilistic' && probability !== undefined && Number.isFinite(probability) &&
        probability >= 0 && probability <= 1
        ? (probability >= 0.5 ? 'correct' as const : 'incorrect' as const) : undefined;
    if (!expected) continue;
    totals.classified++;
    if (expected === row.observed) totals.matched++;
  }
  return totals;
}

function calibration(request: MemoryOverviewProjectionRequest): MemoryOverviewView['calibration'] {
  const source = request.calibration ?? [];
  const summary: MemoryCalibrationSummary | undefined = Array.isArray(source) ? undefined : source as MemoryCalibrationSummary;
  const hasSummaryCounts = summary !== undefined && (summary.recorded !== undefined ||
    summary.classified !== undefined || summary.matched !== undefined || summary.eligible !== undefined ||
    summary.contaminated !== undefined || summary.missingIndependent !== undefined);
  const raw: MemoryCalibrationCounts = hasSummaryCounts ? { ...summary, ...summary.recorded }
    : caseCounts(Array.isArray(source) ? source : (summary?.cases ?? []));
  const eligible = count(raw.eligible, '可核对数');
  const sampleCount = count(raw.classified, '核对样本数');
  const matchedCount = count(raw.matched, '命中数');
  const contaminated = count(raw.contaminated, '受污染样本数');
  const missingIndependent = count(raw.missingIndependent, '缺独立样本数');
  const awaitingIndependentCount = contaminated + missingIndependent;
  if (matchedCount > sampleCount) throw new Error('记忆概况命中数超过核对样本数。');
  const pendingCount = awaitingIndependentCount || eligible || count(summary?.forecasts, '预测数');
  const nonempty = sampleCount + pendingCount > 0;
  const state = sampleCount > 0 ? 'ready' as const : nonempty ? 'awaiting-evidence' as const : 'empty' as const;
  const percent = sampleCount ? Math.round((matchedCount / sampleCount) * 1000) / 10 : null;
  const headline = state === 'ready'
    ? `最近核对：${sampleCount} 次学习判断中，${matchedCount} 次与独立作答一致，命中率 ${percent}%。`
    : state === 'awaiting-evidence'
      ? `已有 ${pendingCount} 项记录，尚待更多独立作答后核对。`
      : '还没有可核对的学习判断。';
  return { state, hitRatePercent: percent, matchedCount, sampleCount, awaitingIndependentCount, headline };
}

function cognition(rows: readonly MemoryCognitionStatus[]): MemoryOverviewView['cognition'] {
  let solidCount = 0, fadingCount = 0, weakCount = 0, unknownCount = 0;
  for (const row of rows) {
    const status = typeof row === 'string' ? row : row.status;
    const state = status === 'steady' ? 'solid' : status === 'decaying' ? 'fading'
      : status === 'fragile' ? 'weak' : status;
    if (state === 'solid') solidCount++;
    else if (state === 'fading') fadingCount++;
    else if (state === 'weak') weakCount++;
    else if (state === 'unknown') unknownCount++;
    else throw new Error('认知节点状态无效。');
  }
  return { totalCount: rows.length, solidCount, fadingCount, weakCount, unknownCount, unknownLabel: '尚待核对' as const,
    headline: rows.length
      ? `已核实 ${rows.length - unknownCount} 个节点：稳固 ${solidCount}、正在减弱 ${fadingCount}、较弱 ${weakCount}；另有 ${unknownCount} 个尚待核对。`
      : '还没有可汇总的认知节点。' };
}

function summary(change: MemoryAuthorizedRecentChange) {
  const subject = change.subjectLabel === undefined ? '' : text(change.subjectLabel, 80).trim();
  const target = subject ? `「${subject}」` : undefined;
  const texts = {
    correction: `已根据更正重新计算${target ?? '相关内容'}。`,
    'independent-evidence': `新的独立作答更新了${target ?? '学习记录'}。`,
    revocation: `相关授权已撤销，${target ?? '这部分内容'}不再展示。`,
    'plan-adjustment': `学习目标或计划已调整${target ? `，涉及${target}。` : '。'}`,
  } as const;
  return texts[change.reasonKind];
}

function orderedChanges(rows: readonly MemoryAuthorizedRecentChange[]) {
  return rows
    .filter(change => Number.isFinite(evidenceTime(change.occurredAt)))
    .toSorted((a, b) => evidenceTime(b.occurredAt) - evidenceTime(a.occurredAt) ||
      a.reasonKind.localeCompare(b.reasonKind))
    .slice(0, 5)
    .map(change => ({ occurredAt: change.occurredAt, kind: change.reasonKind, summary: summary(change),
      evidenceRefs: change.evidenceRefs }));
}

function exam(forecast: MemoryExamForecast): NonNullable<MemoryOverviewView['examOutlook']> {
  if (forecast.kind === 'unknown')
    return { state: 'unknown', headline: '考试展望还缺少足够证据，暂不预测分数。' };
  const { low, high, maximum } = forecast.value;
  if (![low, high, maximum].every(Number.isFinite) || maximum <= 0 || low < 0 || high < low || high > maximum)
    throw new Error('考试概况证据无效。');
  return { state: 'ready', headline: `根据当前证据，预计得分约 ${low}–${high} 分（满分 ${maximum} 分）。这只是估计，不是承诺。` };
}

export function projectMemoryOverview(request: MemoryOverviewProjectionRequest): MemoryOverviewView {
  instant(request.asOf);
  if (!request.purpose.trim() || !request.recipientId.trim()) throw new Error('记忆概况读取范围无效。');
  const examOutlook = request.examOutlook === undefined ? undefined : exam(request.examOutlook);
  return { asOf: request.asOf, calibration: calibration(request), cognition: cognition(request.cognition ?? []),
    recentChanges: orderedChanges(request.recentChanges ?? []),
    ...(examOutlook === undefined ? {} : { examOutlook }) };
}

const decimalTick = /^(0|[1-9][0-9]*)$/;

function local(ref: BusWitness, scope: MemoryOverviewScope) {
  return ref.learner === scope.learner && (ref.mode === 'following' || ref.mode === 'pinned') &&
    decimalTick.test(ref.accessEpoch) && decimalTick.test(scope.clockWatermark) &&
    BigInt(ref.accessEpoch) <= BigInt(scope.clockWatermark);
}

async function reopenChange(scope: MemoryOverviewScope, change: MemoryRecentChange, sources: MemoryOverviewSources):
  Promise<MemoryAuthorizedRecentChange | undefined> {
  if (!Number.isFinite(evidenceTime(change.occurredAt)) || evidenceTime(change.occurredAt) > Date.parse(scope.asOf) ||
      !change.witnesses.length || !change.witnesses.every(ref => local(ref, scope))) return undefined;
  const opened = await Promise.all(change.witnesses.map(ref => sources.reopen(scope, ref).catch(() => undefined)));
  const exact = opened.every((fact, index) => {
    const ref = change.witnesses[index]!;
    return fact !== undefined && fact.ref.learner === scope.learner && fact.ref.id === ref.id && fact.ref.rev === ref.rev &&
      fact.type === ref.type && fact.accessEpoch === ref.accessEpoch && allows(fact.purpose, scope.purpose);
  });
  if (!exact) return undefined;
  const refs = new Map(change.witnesses.map(({id, rev}) => [`${id}@${rev}`, {id, rev}]));
  return { occurredAt: change.occurredAt, reasonKind: change.reasonKind,
    ...(change.subjectLabel === undefined ? {} : { subjectLabel: change.subjectLabel }),
    evidenceRefs: [...refs.values()] };
}

export async function readMemoryOverview(request: MemoryOverviewRequest, sources: MemoryOverviewSources):
  Promise<MemoryOverviewView> {
  instant(request.asOf);
  if (!decimalTick.test(request.clockWatermark)) throw new Error('记忆概况水位无效。');
  const { recentChanges, ...projection } = request;
  const opened = await Promise.all((recentChanges ?? []).map(change => reopenChange(request, change, sources)));
  const authorized = opened.filter((change): change is MemoryAuthorizedRecentChange => change !== undefined);
  return projectMemoryOverview({ ...projection, ...(authorized.length ? { recentChanges: authorized } : {}) });
}
