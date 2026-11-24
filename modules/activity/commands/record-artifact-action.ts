import { defineCommand } from '@mangekyo/kernel';
import { creation } from '../values.ts';
import { artifactActionRecord } from '../artifact-action.ts';

export default defineCommand({
  type: 'activity.recordArtifactAction', destructive: false, schema: creation(artifactActionRecord),
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: 'activity.artifactAction', data, purpose: ['teaching'] },
  ],
});
