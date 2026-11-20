import { defineFact } from '@mangekyo/kernel';
import { paperIssuance, paperIssuanceType } from '../paper.ts';

export default defineFact({ type: paperIssuanceType, schema: { parse: paperIssuance } });
