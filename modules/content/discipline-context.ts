import { fields, list, record, text } from './parse.ts';

export type DisciplineContext = {
  readonly learningScope: string;
  readonly mastery: string;
  readonly assessment: readonly string[];
  readonly boundaries: readonly string[];
};

export function parseDisciplineContext(input: unknown): DisciplineContext {
  const value = record(input);
  fields(value, 'learningScope', 'mastery', 'assessment', 'boundaries');
  const assessment = list(value.assessment).map(rule => text(rule, '评估方式'));
  const boundaries = list(value.boundaries).map(rule => text(rule, '评估边界'));
  if (!assessment.length || !boundaries.length) throw new Error('请说明学科评估方式与客观边界。');
  return {
    learningScope: text(value.learningScope, '学习范围'),
    mastery: text(value.mastery, '掌握标准'),
    assessment,
    boundaries,
  };
}
