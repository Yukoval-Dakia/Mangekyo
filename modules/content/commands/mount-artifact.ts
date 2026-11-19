import { defineCommand, factId } from '@mangekyo/kernel';
import { artifactMount } from '../artifact.ts';

export default defineCommand({
  type: 'content.mountArtifact',
  destructive: false,
  schema: {
    parse(input: unknown) {
      if (
        !input ||
        typeof input !== 'object' ||
        !('id' in input) ||
        typeof input.id !== 'string' ||
        !('data' in input)
      )
        throw new Error('缺少作品版本。');
      return { id: factId(input.id), data: artifactMount(input.data) };
    },
  },
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: 'content.mountedArtifact', data, purpose: ['teaching'] },
  ],
});
