import { defineFact } from '@mangekyo/kernel';
import { ownWordsClaimType, ownWordsTakeawayValue } from '../takeaway-values.ts';

export default defineFact({ type: ownWordsClaimType, schema: { parse: ownWordsTakeawayValue } });
