import { defineFact } from '@mangekyo/kernel';
import { captureSourceType, sourceEnvelope } from '../source.ts';

export default defineFact({ type: captureSourceType, schema: { parse: sourceEnvelope } });
