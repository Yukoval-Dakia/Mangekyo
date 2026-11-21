import { defineSlot } from '@mangekyo/kernel';
import { interventionLiftKey, interventionLiftType } from '../intervention-lift.ts';
import { isWeeklyLiftCutoff } from '../weekly-lift.ts';

export default defineSlot({
  type: interventionLiftType,
  key: (input: { playbookId: string; version: number }) => interventionLiftKey(input.playbookId, input.version),
  policy: 'lazy',
  triggers: [{ kind: 'slot', slotType: 'predict.reconciliation' }],
  accept(_ctx, candidate) {
    if (candidate.kind === 'unknown') return {ok: true};
    const value = candidate.value;
    if (value && typeof value === 'object' && 'asOf' in value && isWeeklyLiftCutoff(value.asOf))
      return {ok: true};
    return {ok: false, reason: 'Lift 缺少有效周截止时刻。'};
  },
});
