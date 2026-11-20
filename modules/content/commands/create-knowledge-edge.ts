import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { fields, record } from '../parse.ts';
import {
  createKnowledgeEdgeCommand,
  knowledgeEdgeType,
  edgePurposes,
  parseEdgeWrite,
  verifyKnowledgeEdge,
} from '../knowledge-edge.ts';

function parse(input: unknown) {
  const value = record(input);
  fields(value, 'id', 'purpose', 'edge');
  return parseEdgeWrite(value);
}

export default defineCommand({
  type: createKnowledgeEdgeCommand,
  destructive: true,
  schema: { parse },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const sources = await verifyKnowledgeEdge(ctx, input.edge);
    return [{
      kind: 'create',
      id: input.id,
      factType: knowledgeEdgeType,
      data: input.edge,
      purpose: edgePurposes(input.purpose, sources),
    }];
  },
});
