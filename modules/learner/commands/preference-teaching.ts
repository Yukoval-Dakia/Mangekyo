import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { allows } from '../memory-evidence.ts';
import { learnerPreferenceType, preferenceTeachingInput, setPreferenceTeachingCommand, storagePurpose } from '../preference-values.ts';

export default defineCommand({
  type: setPreferenceTeachingCommand,
  destructive: true,
  schema: { parse: preferenceTeachingInput },
  async write(ctx, { id, expectedRev, enabled }): Promise<readonly FactWrite[]> {
    const current = await ctx.read.fact(id, { mode: 'following' });
    if (current.type !== learnerPreferenceType || current.ref.rev !== expectedRev)
      throw new Error('偏好类型或版本已变更。');
    if (enabled ? current.purpose.includes('teaching') : !allows(current.purpose, 'teaching')) return [];
    return [{ kind: 'set_purpose', id, expectedRev,
      purpose: enabled ? [storagePurpose, 'teaching'] : [storagePurpose] }];
  },
});
