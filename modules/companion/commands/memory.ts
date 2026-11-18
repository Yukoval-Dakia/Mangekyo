import { defineCommand, factId, type Revision, type FactWrite } from '@mangekyo/kernel';
import { memoryValue } from '../memory.ts';
export default defineCommand({
  type: 'companion.saveMemory',
  destructive: true,
  schema: { parse(value: unknown) {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
        !('revision' in value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) ||
        value.revision < 0 || !('data' in value)) throw new Error('备忘版本无效。');
    return { id: factId(value.id), revision: value.revision as Revision, data: memoryValue(value.data) };
  } },
  write: (_ctx, { id, revision, data }): readonly FactWrite[] => [
    revision ? { kind: 'correct', id, expectedRev: revision, data }
      : { kind: 'create', id, factType: 'companion.memory', purpose: ['teaching'], data },
  ],
});
