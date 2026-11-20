import { defineCommand } from '@mangekyo/kernel';
import { mergeTextbookPages, parseMergeTextbookPages } from '../textbook-structure.ts';

export default defineCommand({
  type: 'content.mergeTextbookPages',
  destructive: true,
  schema: { parse: parseMergeTextbookPages },
  write: mergeTextbookPages,
});
