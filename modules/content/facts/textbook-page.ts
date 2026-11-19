import { defineFact } from '@mangekyo/kernel';
import { parseTextbookPage, textbookPageType } from '../textbook-page.ts';

export default defineFact({
  type: textbookPageType,
  schema: { parse: parseTextbookPage },
});
