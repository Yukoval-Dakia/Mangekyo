import { defineFact } from '@mangekyo/kernel';
import { memoryAssertion, memoryAssertionType } from '../memory-assertion.ts';

export default defineFact({ type: memoryAssertionType, schema: { parse: memoryAssertion } });
