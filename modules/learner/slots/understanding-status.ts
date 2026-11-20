import { defineSlot } from '@mangekyo/kernel';
import { liftType, playbookType, understandingStatusType } from '../playbook.ts';

export default defineSlot({
  type: understandingStatusType, key: (key: {playbookId: string}) => key.playbookId,
  policy: 'eager', triggers: [{kind: 'fact', factType: playbookType}, {kind: 'slot', slotType: liftType}],
});
