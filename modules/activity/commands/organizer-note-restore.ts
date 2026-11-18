import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import {
  organizerNote,
  organizerNoteRestoreInput,
  restoreOrganizerNote,
  verifiedSource,
} from '../organizer-values.ts';

export default defineCommand({
  type: restoreOrganizerNote,
  destructive: true,
  schema: { parse: organizerNoteRestoreInput },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    organizerNote(current.value);
    const historical = await ctx.read.fact(input.id, {
      mode: 'pinned',
      rev: input.restoreRev,
    });
    const data = organizerNote(historical.value);
    const source = data.source === null ? null : await verifiedSource(ctx, data.source.id);
    return [
      {
        kind: 'correct',
        id: input.id,
        expectedRev: input.expectedRev,
        data: { ...data, source },
      },
    ];
  },
});
