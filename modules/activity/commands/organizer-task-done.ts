import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import {
  organizerTask,
  organizerTaskDoneInput,
  setOrganizerTaskDone,
} from '../organizer-values.ts';

export default defineCommand({
  type: setOrganizerTaskDone,
  destructive: true,
  schema: { parse: organizerTaskDoneInput },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    const data = organizerTask(current.value);
    return [
      {
        kind: 'correct',
        id: input.id,
        expectedRev: input.expectedRev,
        data: { ...data, done: input.done },
      },
    ];
  },
});
