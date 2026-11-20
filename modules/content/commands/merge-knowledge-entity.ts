import { defineCommand } from '@mangekyo/kernel';
import { mergeKnowledgeEntity, parseMergeKnowledgeEntity } from '../knowledge-entity-writes.ts';

export default defineCommand({
  type: 'content.mergeKnowledgeEntity',
  destructive: true,
  schema: { parse: parseMergeKnowledgeEntity },
  write: mergeKnowledgeEntity,
});
