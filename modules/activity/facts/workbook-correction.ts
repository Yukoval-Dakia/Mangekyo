import { defineFact } from '@mangekyo/kernel';
import { workbookCorrection, workbookCorrectionType } from '../workbook-correction.ts';

export default defineFact({ type: workbookCorrectionType, schema: { parse: workbookCorrection } });
