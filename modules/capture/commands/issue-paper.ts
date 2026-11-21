import { defineCommand } from '@mangekyo/kernel';
import { issuePaperWrites, newPaperIssuance } from '../paper.ts';

export default defineCommand({
  type: 'capture.issuePaper',
  destructive: false,
  schema: { parse: newPaperIssuance },
  write: (ctx, data) => issuePaperWrites(ctx.read, data),
});
