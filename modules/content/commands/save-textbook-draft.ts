import { defineCommand } from '@mangekyo/kernel';
import { parseTextbookDraft, saveTextbookDraft } from '../textbook-conflict.ts';

export default defineCommand({
  type: 'content.saveTextbookDraft',
  destructive: true,
  schema: { parse: parseTextbookDraft },
  write: saveTextbookDraft,
});
