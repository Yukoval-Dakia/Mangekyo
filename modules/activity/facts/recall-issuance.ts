import { defineFact } from '@mangekyo/kernel';
import { recallIssuance, recallIssuanceType } from '../recall-values.ts';

export default defineFact({ type: recallIssuanceType, schema: { parse: recallIssuance } });
