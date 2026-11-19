import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import {
  learnerPreference,
  learnerPreferenceType,
  preferenceReviseInput,
  revisePreferenceCommand,
} from '../preference-values.ts';

export default defineCommand({
  type: revisePreferenceCommand,
  destructive: true,
  schema: { parse: preferenceReviseInput },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    if (current.type !== learnerPreferenceType) throw new Error('目标不是学习偏好。');
    learnerPreference(current.value);
    return [
      {
        kind: 'correct',
        id: input.id,
        expectedRev: input.expectedRev,
        data: input.data,
      },
    ];
  },
});
