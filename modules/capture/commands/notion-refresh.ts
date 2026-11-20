import { defineCommand } from '@mangekyo/kernel';
import { checkNotionAdmission, notionSourceTarget, readNotionSourceTarget, refreshNotionSourceCommand } from '../notion-source.ts';
import { compareNotionObservation, observationInput } from '../notion-observation.ts';
import { notionRecord } from '../notion-values.ts';
import { reviseSourceWrite, sourceEnvelope } from '../source.ts';

export default defineCommand({
  type: refreshNotionSourceCommand,
  destructive: false,
  schema: {
    parse(input: unknown) {
      const target = notionSourceTarget(input);
      const row = notionRecord(input);
      if (row.observation !== undefined) return { ...target, ...observationInput(row) };
      return { ...target, envelope: sourceEnvelope(row.envelope) };
    },
  },
  async write(ctx, input) {
    const { current, source } = await readNotionSourceTarget(ctx, input);
    await checkNotionAdmission(ctx, input.id, 'envelope' in input ? input.envelope : source, current.purpose);
    const observationWrites = await compareNotionObservation(ctx.read, input.id, source, input);
    if ('envelope' in input) return [reviseSourceWrite(current, input.expectedRev, input.envelope)];
    return observationWrites;
  },
});
