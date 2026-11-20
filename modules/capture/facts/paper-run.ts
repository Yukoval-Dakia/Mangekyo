import { defineFact } from '@mangekyo/kernel';
import { paperRun, paperRunType } from '../paper.ts';

export default defineFact({ type: paperRunType, schema: { parse: paperRun } });
