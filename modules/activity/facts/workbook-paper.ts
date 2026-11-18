import { defineFact } from '@mangekyo/kernel';
import { workbookPaper, workbookPaperType } from '../workbook-values.ts';

export default defineFact({ type: workbookPaperType, schema: { parse: workbookPaper } });
