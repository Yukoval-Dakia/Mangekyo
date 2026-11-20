import { defineCommand } from '@mangekyo/kernel';
import { creation, studyTurn, turnResearchPurpose } from '../values.ts';
import { storagePurpose } from '../library-values.ts';
export default defineCommand({
  type: 'activity.submitTurn',
  destructive: true,
  schema: creation(studyTurn),
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: 'activity.studyTurn', data,
      purpose: data.allowBackgroundUnderstanding ? [storagePurpose, 'teaching', turnResearchPurpose] : ['teaching'] },
  ],
});
