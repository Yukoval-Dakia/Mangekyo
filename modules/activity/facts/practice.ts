import { defineFact } from '@mangekyo/kernel';
import { practiceSubmission, ridingPracticeType } from '../practice-values.ts';

export default defineFact({ type: ridingPracticeType, schema: { parse: practiceSubmission } });
