import { defineCommand } from '@mangekyo/kernel';
import { correctQuestionCommand, parseQuestionWrite, writeQuestion } from '../question-writes.ts';

export default defineCommand({
  type: correctQuestionCommand, destructive: true, schema: { parse: parseQuestionWrite },
  write: (ctx, input) => writeQuestion(ctx, input, 'correct'),
});
