import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import {
  createOrganizerNote,
  organizerNoteDraft,
  organizerNoteType,
  verifiedSource,
} from '../organizer-values.ts';

export default defineCommand({
  type: createOrganizerNote,
  destructive: false,
  schema: {
    parse(input: unknown) {
      if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') {
        throw new Error('笔记标识无效。');
      }
      return { id: factId(input.id), ...organizerNoteDraft(input) };
    },
  },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const source = await verifiedSource(ctx, input.materialId);
    return [
      {
        kind: 'create',
        id: input.id,
        factType: organizerNoteType,
        data: { title: input.title, markdown: input.markdown, source },
        purpose: [storagePurpose],
      },
    ];
  },
});
