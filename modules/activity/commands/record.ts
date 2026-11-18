import { defineCommand } from '@mangekyo/kernel';
import { creation, studyRecord } from '../values.ts';
export default defineCommand({
  type: 'activity.recordEvidence',
  destructive: false,
  schema: creation(studyRecord),
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: 'activity.studyRecord', data, purpose: ['teaching'] },
  ],
});
