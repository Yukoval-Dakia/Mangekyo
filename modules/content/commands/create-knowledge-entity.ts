import { defineCommand } from '@mangekyo/kernel';
import { createKnowledgeEntity, parseCreateKnowledgeEntity } from '../knowledge-entity-writes.ts';

export default defineCommand({
  type: 'content.createKnowledgeEntity',
  destructive: true,
  schema: { parse: parseCreateKnowledgeEntity },
  write: createKnowledgeEntity,
});
