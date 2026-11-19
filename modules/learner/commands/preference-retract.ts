import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import {
  learnerPreferenceType,
  preferenceRetractInput,
  retractPreferenceCommand,
} from '../preference-values.ts';

export default defineCommand({
  type: retractPreferenceCommand,
  destructive: true,
  schema: { parse: preferenceRetractInput },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    if (current.type !== learnerPreferenceType) throw new Error('目标不是学习偏好。');
    return [
      {
        kind: 'retract',
        id: input.id,
        expectedRev: input.expectedRev,
      },
    ];
  },
});
