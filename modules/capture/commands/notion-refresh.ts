import { defineCommand } from '@mangekyo/kernel';
import { notionRevisionDiff, notionSourceTarget, readNotionSourceTarget, refreshNotionSourceCommand } from '../notion-source.ts';
import { notionRecord } from '../notion-values.ts';
import { reviseSourceWrite, sourceEnvelope } from '../source.ts';

export default defineCommand({
  type: refreshNotionSourceCommand,
  destructive: false,
  schema: {
    parse(input: unknown) {
      return { ...notionSourceTarget(input), envelope: sourceEnvelope(notionRecord(input).envelope) };
    },
  },
  async write(ctx, input) {
    const { current, source } = await readNotionSourceTarget(ctx, input);
    const write = reviseSourceWrite(current, input.expectedRev, input.envelope);
    const diff = notionRevisionDiff(source, input.envelope);
    if (source.occurredAt === input.envelope.occurredAt && source.unit.title === input.envelope.unit.title &&
        Object.values(diff).every(ids => ids.length === 0)) return [];
    return [write];
  },
});
