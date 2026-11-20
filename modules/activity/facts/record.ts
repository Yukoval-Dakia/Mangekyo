import { defineFact } from '@mangekyo/kernel';
import { studyRecordFact, studyRecordType } from '../values.ts';
export default defineFact({ type: studyRecordType, schema: { parse: studyRecordFact } });
