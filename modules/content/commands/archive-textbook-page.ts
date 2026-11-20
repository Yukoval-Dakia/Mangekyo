import { defineCommand } from '@mangekyo/kernel';
import { archiveTextbookPage, parseTextbookHead } from '../textbook-structure.ts';

export default defineCommand({
  type: 'content.archiveTextbookPage',
  destructive: true,
  schema: { parse: parseTextbookHead },
  write: archiveTextbookPage,
});
