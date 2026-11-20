import { defineCommand } from '@mangekyo/kernel';
import { parseSplitTextbookPage, splitTextbookPage } from '../textbook-structure.ts';

export default defineCommand({
  type: 'content.splitTextbookPage',
  destructive: true,
  schema: { parse: parseSplitTextbookPage },
  write: splitTextbookPage,
});
