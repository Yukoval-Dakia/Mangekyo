import { defineCommand } from '@mangekyo/kernel';
import { checkNotionAdmission, notionRefreshHasChanges, UnchangedNotionSourceError, notionSourceTarget, readNotionSourceTarget, refreshNotionSourceCommand } from '../notion-source.ts';
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
    await checkNotionAdmission(ctx, input.id, input.envelope, current.purpose);
    const write = reviseSourceWrite(current, input.expectedRev, input.envelope);
    // The kernel journals the raw request even for an empty write list. A no-change
    // result must leave this transaction before the command receipt is inserted.
    if (!notionRefreshHasChanges(source, input.envelope)) throw new UnchangedNotionSourceError();
    return [write];
  },
});
