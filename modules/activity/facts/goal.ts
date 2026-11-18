import { defineFact } from '@mangekyo/kernel';
import { goalType, studyGoal } from '../library-values.ts';

export default defineFact({ type: goalType, schema: { parse: studyGoal } });
