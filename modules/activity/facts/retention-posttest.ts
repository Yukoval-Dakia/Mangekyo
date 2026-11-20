import { defineFact } from '@mangekyo/kernel';
import { posttestIssuance, posttestIssuanceType } from '../retention-posttest.ts';

export default defineFact({ type: posttestIssuanceType, schema: { parse: posttestIssuance } });
