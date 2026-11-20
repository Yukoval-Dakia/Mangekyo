import { defineFact } from '@mangekyo/kernel';
import { workbookPresentation, workbookPresentationType } from '../workbook-presentation.ts';

export default defineFact({ type: workbookPresentationType, schema: { parse: workbookPresentation } });
