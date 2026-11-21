import { defineCommand } from '@mangekyo/kernel';
import { paperAnswerInput, paperAnswerWrites } from '../paper-answers.ts';
import { captureObject, captureText } from '../parse.ts';

export default defineCommand({
  type: 'capture.correctPaperAnswer',
  destructive: true,
  schema: { parse(input: unknown) {
    return { answer: paperAnswerInput(input), text: captureText(captureObject(input).text, '更正文字', 2_000_000, true) };
  } },
  write: (ctx, { answer, text }) => paperAnswerWrites(ctx.read, answer, text),
});
