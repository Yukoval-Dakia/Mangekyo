import { defineFact } from '@mangekyo/kernel';
import { knowledgeEdgeEvidenceType, parseEdgeEvidence } from '../knowledge-edge.ts';

export default defineFact({
  type: knowledgeEdgeEvidenceType,
  schema: { parse: parseEdgeEvidence },
});
