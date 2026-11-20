import { defineCommand } from '@mangekyo/kernel';
import { extractionInput, extractionRevision } from '../extraction.ts';

export default defineCommand({
  type: 'capture.applyExtraction',
  destructive: false,
  schema: { parse: extractionInput },
  async write(ctx, input) {
    const revision = await extractionRevision(ctx.read, input);
    return revision ? [{ kind: 'revise', ...revision }] : [];
  },
});
