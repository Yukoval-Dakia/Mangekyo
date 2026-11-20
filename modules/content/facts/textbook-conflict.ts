import { defineFact } from '@mangekyo/kernel';
import { parseTextbookConflict, textbookConflictType } from '../textbook-conflict.ts';

export default defineFact({
  type: textbookConflictType,
  schema: { parse: parseTextbookConflict },
});
