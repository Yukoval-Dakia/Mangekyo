import { defineFact } from '@mangekyo/kernel';
import { recallSubmission, recallSubmissionType } from '../recall-values.ts';

export default defineFact({ type: recallSubmissionType, schema: { parse: recallSubmission } });
