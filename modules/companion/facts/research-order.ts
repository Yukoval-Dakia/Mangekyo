import { defineFact } from '@mangekyo/kernel';
import { researchOrder, researchOrderType } from '../research.ts';

export default defineFact({ type: researchOrderType, schema: { parse: researchOrder } });
