import { defineFact } from '@mangekyo/kernel';
import { memoryValue } from '../memory.ts';
export default defineFact({ type: 'companion.memory', schema: { parse: memoryValue } });
