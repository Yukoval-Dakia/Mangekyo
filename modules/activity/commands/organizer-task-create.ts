import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import {
  createOrganizerTask,
  organizerTaskDraft,
  organizerTaskType,
} from '../organizer-values.ts';

export default defineCommand({
  type: createOrganizerTask,
  destructive: false,
  schema: {
    parse(input: unknown) {
      if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string') {
        throw new Error('任务标识无效。');
      }
      if (!('data' in input)) throw new Error('任务内容无效。');
      return { id: factId(input.id), data: organizerTaskDraft(input.data) };
    },
  },
  write: (_ctx, { id, data }): readonly FactWrite[] => [
    {
      kind: 'create',
      id,
      factType: organizerTaskType,
      data,
      purpose: [storagePurpose],
    },
  ],
});
