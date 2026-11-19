import { defineFact } from '@mangekyo/kernel';
import { claimType, claimValue } from '../claim.ts';

export default defineFact({ type: claimType, schema: { parse: claimValue } });
