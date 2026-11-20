import { defineFact } from '@mangekyo/kernel';
import { retentionPaper, retentionPaperType } from '../retention-posttest.ts';

export default defineFact({ type: retentionPaperType, schema: { parse: retentionPaper } });
