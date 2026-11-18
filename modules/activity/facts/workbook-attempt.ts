import { defineFact } from '@mangekyo/kernel';
import { workbookAttempt, workbookAttemptType } from '../workbook-values.ts';

export default defineFact({ type: workbookAttemptType, schema: { parse: workbookAttempt } });
