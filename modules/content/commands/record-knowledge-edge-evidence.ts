import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { fields, record } from '../parse.ts';
import { edgePurposes, knowledgeEdgeEvidenceType, parseEdgeEvidence, parseEdgeWrite, verifyKnowledgeEdge } from '../knowledge-edge.ts';

export default defineCommand({
  type: 'content.recordKnowledgeEdgeEvidence',
  destructive: true,
  schema: {
    parse(input: unknown) {
      const value = record(input);
      fields(value, 'id', 'purpose', 'edge', 'method');
      const { id, purpose, edge } = parseEdgeWrite(value);
      return { id, purpose, evidence: parseEdgeEvidence({ method: value.method, edge }) };
    },
  },
  async write(ctx, input): Promise<readonly FactWrite[]> {
    const sources = await verifyKnowledgeEdge(ctx, input.evidence.edge);
    return [{
      kind: 'create', id: input.id, factType: knowledgeEdgeEvidenceType,
      data: input.evidence, purpose: edgePurposes(input.purpose, sources),
    }];
  },
});
