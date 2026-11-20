import { defineFact } from '@mangekyo/kernel';
import { notionPageObservation, notionPageObservationType } from '../notion-observation.ts';

export default defineFact({ type: notionPageObservationType, schema: { parse: notionPageObservation } });
