import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { fields, record } from '../parse.ts';
import {
  edgePurposes, knowledgeEdgeEvidenceType, knowledgeEdgeType, parseEdgeEvidence,
  parseEdgeWrite, readKnowledgeUse, sourceUse, verifyKnowledgeEdge,
} from '../knowledge-edge.ts';

export default defineCommand({
  type: 'content.createVerifiedKnowledgeEdge',
  destructive: false,
  schema: {
    parse(input: unknown) {
      const value = record(input);
      fields(value, 'id', 'purpose', 'edge', 'verification');
      return { ...parseEdgeWrite(value), verification: sourceUse(value.verification) };
    },
  },
  async write(ctx, input): Promise<readonly FactWrite[]> {
    const proof = await readKnowledgeUse(ctx, input.verification);
    if (proof.type !== knowledgeEdgeEvidenceType ||
        JSON.stringify(parseEdgeEvidence(proof.value).edge) !== JSON.stringify(input.edge)) {
      throw new Error('核验证明与待确认的有向边不符。');
    }
    const sources = await verifyKnowledgeEdge(ctx, input.edge);
    return [{
      kind: 'create', id: input.id, factType: knowledgeEdgeType,
      data: { ...input.edge, verification: input.verification },
      purpose: edgePurposes(input.purpose, [...sources, proof]),
    }];
  },
});
