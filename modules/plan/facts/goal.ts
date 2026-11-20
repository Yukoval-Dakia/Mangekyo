import { defineFact } from '@mangekyo/kernel';
import { goalType, studyGoal } from '../goal-values.ts';

export default defineFact({
  type: goalType,
  schema: { parse: studyGoal },
  correctableFields: () => ['/status'],
});
