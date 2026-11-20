import { defineCommand } from '@mangekyo/kernel';
import { issuePaperWrites, paperIssuance } from '../paper.ts';

export default defineCommand({
  type: 'capture.issuePaper',
  destructive: false,
  schema: { parse: paperIssuance },
  write: (ctx, data) => issuePaperWrites(ctx.read, data),
});
