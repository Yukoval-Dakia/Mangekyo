import { defineCommand } from '@mangekyo/kernel';
import { parseTextbookRevision, writeTextbookRevision } from '../textbook-edits.ts';

export default defineCommand({
  type: 'content.reviseTextbookPage',
  destructive: true,
  schema: { parse: parseTextbookRevision },
  write: (ctx, input) => writeTextbookRevision(ctx, input, 'correct'),
});
