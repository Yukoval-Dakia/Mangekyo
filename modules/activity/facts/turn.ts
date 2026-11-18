import { defineFact } from '@mangekyo/kernel';
import { studyTurn } from '../values.ts';
export default defineFact({ type: 'activity.studyTurn', schema: { parse: studyTurn } });
