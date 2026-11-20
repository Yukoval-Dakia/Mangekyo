import { defineFact } from '@mangekyo/kernel';
import { posttestSubmissionType } from '../retention-posttest.ts';
import { workbookAttempt } from '../workbook-values.ts';

export default defineFact({ type: posttestSubmissionType, schema: { parse: workbookAttempt } });
