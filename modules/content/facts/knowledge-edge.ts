import { defineFact } from '@mangekyo/kernel';
import { knowledgeEdgeType, parseKnowledgeEdge } from '../knowledge-edge.ts';

export default defineFact({
  type: knowledgeEdgeType,
  schema: { parse: parseKnowledgeEdge },
});
