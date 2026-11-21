import { defineCommand } from '@mangekyo/kernel';
import { checkNotionAdmission, notionSourceTarget, readNotionSourceTarget, refreshNotionSourceCommand } from '../notion-source.ts';
import { compareNotionObservation, observationInput } from '../notion-observation.ts';
import { stampNotionBlockRevisions } from '../notion-diff.ts';
import { notionRecord, verifyNotionBlockHashes } from '../notion-values.ts';
import { reviseSourceWrite, sourceEnvelope } from '../source.ts';

export default defineCommand({
  type: refreshNotionSourceCommand,
  destructive: false,
  schema: {
    parse(input: unknown) {
      const target = notionSourceTarget(input);
      const row = notionRecord(input);
      if (row.observation !== undefined) return { ...target, ...observationInput(row) };
      const envelope = sourceEnvelope(row.envelope);
      if (envelope.notionBlockRevisions !== undefined) throw new Error('刷新输入不能指定 Notion 块版本。');
      return { ...target, envelope };
    },
  },
  async write(ctx, input) {
    const { current, source } = await readNotionSourceTarget(ctx, input);
    await checkNotionAdmission(ctx, input.id, 'envelope' in input ? input.envelope : source, current.purpose);
    const observationWrites = await compareNotionObservation(ctx.read, input.id, source, input);
    if ('envelope' in input) {
      const revision = reviseSourceWrite(current, input.expectedRev, input.envelope);
      await verifyNotionBlockHashes(revision.data);
      return [{ ...revision, data: { ...revision.data,
        notionBlockRevisions: stampNotionBlockRevisions(source, revision.data, current.ref.rev),
      } }];
    }
    return observationWrites;
  },
});
