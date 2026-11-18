import { defineCommand } from '@mangekyo/kernel';
import { creation, studyTurn } from '../values.ts';
export default defineCommand({
  type: 'activity.submitTurn',
  destructive: false,
  schema: creation(studyTurn),
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: 'activity.studyTurn', data, purpose: ['teaching'] },
  ],
});
