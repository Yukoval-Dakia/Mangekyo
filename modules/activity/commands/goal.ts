import { defineCommand } from '@mangekyo/kernel';
import { goalType, setStudyGoal, storagePurpose, studyGoal } from '../library-values.ts';
import { creation } from '../values.ts';

export default defineCommand({
  type: setStudyGoal,
  destructive: true,
  schema: creation(studyGoal),
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: goalType, data, purpose: [storagePurpose] },
  ],
});
