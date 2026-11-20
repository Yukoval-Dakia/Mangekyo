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

// The reader must verify the actual and prediction refer to the same frozen
// exam, with independent formal assessment. Reference the scope and releases
// in the same authorized gather manifest as the forecast.
export type ExamScoreObservation = {
  submission: RevisionRef;
  forecastAssessment: RevisionRef;
  submittedAt: string;
  score: { earned: number; maximum: number };
};

function revisionRef(ref: RevisionRef) {
  return !!ref?.id && Number.isSafeInteger(ref.rev) && ref.rev >= 1;
}

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
    !references.every(revisionRef) ||
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

export function reviewExamScore(
  exam: Exam | undefined,
  forecast: ReturnType<typeof examForecast>,
  actual: ExamScoreObservation | undefined,
  now: string,
) {
  const unknown = (reason: string) => ({ kind: 'unknown' as const, reason });
  if (!exam) return unknown('缺少可复盘的考试。');
  if (forecast.kind === 'unknown') return forecast;
  if (!actual) return unknown('缺少同一冻结考试的独立正式得分。');
  const { assessment, low, high, maximum, frozenAt } = forecast.value;
  const submitted = Date.parse(actual.submittedAt);
  if (!revisionRef(actual.submission) || actual.forecastAssessment?.id !== assessment.id ||
      actual.forecastAssessment.rev !== assessment.rev ||
      !Number.isFinite(submitted) || submitted <= Date.parse(frozenAt) || submitted > Date.parse(now) ||
      actual.score.maximum !== maximum || !Number.isFinite(actual.score.earned) ||
      actual.score.earned < 0 || actual.score.earned > maximum) {
    return unknown('提交、预测时点或得分标尺与冻结考试不匹配。');
  }
  const { earned } = actual.score;
  const status = earned < low ? 'below-expected-range' : earned > high ? 'above-expected-range' : 'within-expected-range';
  return { kind: 'value' as const, status, score: { earned, maximum }, submission: actual.submission };
}
