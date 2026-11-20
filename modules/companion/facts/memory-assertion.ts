import { defineFact } from '@mangekyo/kernel';
import { memoryAssertion, memoryAssertionType } from '../memory-assertion.ts';

import { extractedUnderstanding, isExtractedUnderstanding } from '../understanding.ts';

export default defineFact({ type: memoryAssertionType, schema: { parse: (value: unknown) => isExtractedUnderstanding(value) ? extractedUnderstanding(value) : memoryAssertion(value) } });
