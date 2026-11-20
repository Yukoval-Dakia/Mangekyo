import { defineCommand } from '@mangekyo/kernel';
import { collectPaperInput, collectPaperWrites } from '../paper.ts';

export default defineCommand({
  type: 'capture.collectPaper',
  destructive: true,
  schema: { parse: collectPaperInput },
  write: (ctx, input) => collectPaperWrites(ctx.read, input),
});
