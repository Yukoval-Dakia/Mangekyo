import type { PlanCandidate } from './today.ts';
import { instant, integer, object, text } from './validation.ts';

const dayMs = 86_400_000;
export const freshMaterialWindowDays = 14;

// Authorized, teaching-eligible material summary supplied by the organizer/content
// side so newly captured learner materials surface on Today before any activity
// has been derived from them.
export type FreshMaterialSource = {
  id: string;
  rev: number;
  title: string;
  topic?: string;
  savedAt: string;
  hasDerivedActivity: boolean;
  questionCount?: number;
  redPenErrorCount?: number;
  goalId?: string;
};

export type FreshMaterialSummary = {
  savedAt: string;
  questionCount?: number;
  redPenErrorCount?: number;
};

function freshMaterialSource(input: unknown): FreshMaterialSource {
  const row = object(input);
  if (typeof row.hasDerivedActivity !== 'boolean') throw new Error('材料衍生状态无效。');
  return {
    id: text(row.id),
    rev: integer(row.rev, 1, Number.MAX_SAFE_INTEGER),
    title: text(row.title),
    ...(row.topic === undefined ? {} : { topic: text(row.topic) }),
    savedAt: instant(row.savedAt),
    hasDerivedActivity: row.hasDerivedActivity,
    ...(row.questionCount === undefined ? {} : { questionCount: integer(row.questionCount, 0, Number.MAX_SAFE_INTEGER) }),
    ...(row.redPenErrorCount === undefined ? {} : { redPenErrorCount: integer(row.redPenErrorCount, 0, Number.MAX_SAFE_INTEGER) }),
    ...(row.goalId === undefined ? {} : { goalId: text(row.goalId) }),
  };
}

export function freshMaterialSummary(input: unknown): FreshMaterialSummary {
  const row = object(input);
  return {
    savedAt: instant(row.savedAt),
    ...(row.questionCount === undefined ? {} : { questionCount: integer(row.questionCount, 0, Number.MAX_SAFE_INTEGER) }),
    ...(row.redPenErrorCount === undefined ? {} : { redPenErrorCount: integer(row.redPenErrorCount, 0, Number.MAX_SAFE_INTEGER) }),
  };
}

function latestMaterial(a: FreshMaterialSource, b: FreshMaterialSource) {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  return Date.parse(a.savedAt) >= Date.parse(b.savedAt) ? a : b;
}

function estimateMinutes(source: FreshMaterialSource): { minutes: number; durationBasis: string } {
  if (source.redPenErrorCount && source.redPenErrorCount > 0) {
    const minutes = Math.min(10, Math.max(5, 4 + source.redPenErrorCount * 2));
    return {
      minutes,
      durationBasis: `原件标出 ${source.redPenErrorCount} 处错题，先安排 ${minutes} 分钟小步复盘。`,
    };
  }
  if (source.questionCount && source.questionCount > 0) {
    const minutes = Math.min(10, Math.max(5, Math.ceil(source.questionCount / 2) + 4));
    return {
      minutes,
      durationBasis: `原件约含 ${source.questionCount} 题，先安排 ${minutes} 分钟梳理并选切入点。`,
    };
  }
  return {
    minutes: 6,
    durationBasis: '刚交入原件尚无作答估时，暂按 6 分钟快速梳理估算。',
  };
}

function freshTitle(source: FreshMaterialSource) {
  if (source.redPenErrorCount && source.redPenErrorCount > 0)
    return `复盘刚拍《${source.title}》里的 ${source.redPenErrorCount} 道错题`;
  return `梳理刚交入的《${source.title}》`;
}

function freshReason(source: FreshMaterialSource) {
  if (source.redPenErrorCount && source.redPenErrorCount > 0)
    return `刚交入的材料标出 ${source.redPenErrorCount} 处错题且尚未生成练习或对话，直接从原件切入复盘。`;
  if (source.questionCount && source.questionCount > 0)
    return `刚交入这份含 ${source.questionCount} 题的原件且尚未生成练习或课堂，先快速梳理再决定下一步。`;
  return '刚交入的新材料尚未生成练习、课堂或对话，先从这份原件接着学。';
}

export function projectFreshMaterialCandidates(
  sources: readonly FreshMaterialSource[],
  now: string,
  options?: { windowDays?: number },
): PlanCandidate[] {
  const nowMs = Date.parse(instant(now));
  const windowDays = options?.windowDays === undefined
    ? freshMaterialWindowDays
    : integer(options.windowDays, 1, 90);
  const maxAgeMs = windowDays * dayMs;
  const latest = new Map<string, FreshMaterialSource>();
  for (const source of sources.map(freshMaterialSource)) {
    const held = latest.get(source.id);
    latest.set(source.id, held ? latestMaterial(held, source) : source);
  }
  const ordered = [...latest.values()].sort((a, b) => {
    const byTime = Date.parse(b.savedAt) - Date.parse(a.savedAt);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
  const candidates: PlanCandidate[] = [];
  for (const source of ordered) {
    if (source.hasDerivedActivity) continue;
    const ageMs = nowMs - Date.parse(source.savedAt);
    if (ageMs < 0 || ageMs > maxAgeMs) continue;
    const { minutes, durationBasis } = estimateMinutes(source);
    const ref = `material:${source.id}@${source.rev}`;
    candidates.push({
      id: ref,
      title: freshTitle(source),
      topic: source.topic ?? source.title,
      kind: 'review',
      minutes,
      durationBasis,
      input: 'tap',
      open: { kind: 'material', id: source.id, rev: source.rev },
      reason: freshReason(source),
      evidence: [ref],
      delayImpact: '推迟后，刚交入的原件会沉淀在材料库里，容易错过趁热梳理与切入练习的窗口。',
      ...(source.goalId === undefined ? {} : { goalId: source.goalId }),
      freshMaterial: {
        savedAt: source.savedAt,
        ...(source.questionCount === undefined ? {} : { questionCount: source.questionCount }),
        ...(source.redPenErrorCount === undefined ? {} : { redPenErrorCount: source.redPenErrorCount }),
      },
    });
  }
  return candidates;
}
