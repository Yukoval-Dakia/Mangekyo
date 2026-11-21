import { defineFact } from '@mangekyo/kernel';
import { storedPaperDefinition, paperIssuanceType } from '../paper.ts';

export default defineFact({ type: paperIssuanceType, schema: { parse: storedPaperDefinition } });
