import type { PlanRule } from './rules.ts';
import { instant } from './validation.ts';

type Exam = Extract<PlanRule, { kind: 'exam' }>;
type RevisionRef = { id: string; rev: number };

// Only a previously frozen, applicable assessment may be displayed.
// The assessment/learner owner supplies its calibration, scale and read witnesses.
export type FrozenExamForecast = {
  exam: Exam;
  frozenAt: string;
  low: number;
  high: number;
  maximum: number;
  assessment: RevisionRef;
  calibration: RevisionRef;
  methodVersion: string;
  absoluteError: number;
};
export function examForecast(exam: Exam | undefined, frozen: FrozenExamForecast | undefined, now: string) {
  const unknown = (reason: string) => ({ kind: 'unknown' as const, reason });
  if (
    !exam?.scope.length ||
    !exam.weights.length ||
    exam.weights.reduce((sum, w) => sum + w.weight, 0) !== 100 ||
    exam.scope.some((topic) => !exam.weights.some((w) => w.topic === topic))
  )
    return unknown('缺少完整考试范围或题型权重。');
  if (!frozen) return unknown('缺少适用评估或事前冻结的标定区间。');
  const references = [frozen.assessment, frozen.calibration];
  if (
    references.some((r) => !r?.id || !Number.isSafeInteger(r.rev) || r.rev < 1) ||
    !frozen.methodVersion ||
    ![frozen.low, frozen.high, frozen.maximum, frozen.absoluteError].every(Number.isFinite) ||
    frozen.maximum <= 0 ||
    frozen.low < 0 ||
    frozen.high < frozen.low ||
    frozen.high > frozen.maximum ||
    frozen.absoluteError < 0
  )
    return unknown('评估证据、方法标定或分数范围不完整。');
  if (
    exam.date !== frozen.exam.date ||
    exam.scope.length !== frozen.exam.scope.length ||
    exam.weights.length !== frozen.exam.weights.length ||
    exam.scope.some((t) => !frozen.exam.scope.includes(t)) ||
    exam.weights.some(
      (w) => !frozen.exam.weights.some((other) => other.topic === w.topic && other.weight === w.weight),
    ) ||
    Date.parse(instant(frozen.frozenAt)) > Date.parse(instant(now))
  )
    return unknown('考试范围或预测时点不匹配。');
  return { kind: 'value' as const, value: frozen };
}
