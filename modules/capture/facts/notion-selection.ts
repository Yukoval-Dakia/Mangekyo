import { defineFact } from '@mangekyo/kernel';
import { notionSelectionType, selectionValue } from '../notion-selection.ts';

export default defineFact({ type: notionSelectionType, schema: { parse: selectionValue } });
