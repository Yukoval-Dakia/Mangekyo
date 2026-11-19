import { defineFact } from '@mangekyo/kernel';
import { researchWorksheet, researchWorksheetType } from '../research.ts';

export default defineFact({ type: researchWorksheetType, schema: { parse: researchWorksheet } });
