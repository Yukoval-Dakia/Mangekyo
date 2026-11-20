import { defineCommand } from '@mangekyo/kernel';
import { extractionInput, extractionRevision } from '../extraction.ts';

// Companion callers submit a proposal. Only actual learner confirmation can
// append a correction, and the existing learner text remains authoritative.
export default defineCommand({
  type: 'capture.proposeExtraction',
  destructive: true,
  schema: { parse: extractionInput },
  async write(ctx, input) {
    const revision = await extractionRevision(ctx.read, input);
    return revision ? [{ kind: 'correct', ...revision }] : [];
  },
});
