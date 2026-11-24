import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import {
  organizerNote,
  organizerNoteSaveInput,
  saveOrganizerNote,
  verifiedSource,
} from '../organizer-values.ts';

export default defineCommand({
  type: saveOrganizerNote, destructive: true, schema: { parse: organizerNoteSaveInput },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    organizerNote(current.value);
    const source = await verifiedSource(ctx, input.materialId);
    return [
      {
        kind: 'correct', id: input.id, expectedRev: input.expectedRev,
        data: { title: input.title, markdown: input.markdown, source },
      },
    ];
  },
});
