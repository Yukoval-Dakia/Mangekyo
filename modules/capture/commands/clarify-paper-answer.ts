import { defineCommand } from '@mangekyo/kernel';
import { paperAnswerInput, paperAnswerWrites } from '../paper-answers.ts';

export default defineCommand({
  type: 'capture.clarifyPaperAnswer',
  destructive: true,
  schema: { parse: paperAnswerInput },
  write: (ctx, input) => paperAnswerWrites(ctx.read, input),
});
