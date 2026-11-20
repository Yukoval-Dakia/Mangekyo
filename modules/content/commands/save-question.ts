import { defineCommand } from '@mangekyo/kernel';
import { parseQuestionWrite, saveQuestionCommand, writeQuestion } from '../question-writes.ts';

export default defineCommand({
  type: saveQuestionCommand, destructive: false, schema: { parse: parseQuestionWrite },
  write: (ctx, input) => writeQuestion(ctx, input, 'revise'),
});
