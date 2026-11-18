import { defineFact } from '@mangekyo/kernel';
import { studyRecord } from '../values.ts';
export default defineFact({ type: 'activity.studyRecord', schema: { parse: studyRecord } });
