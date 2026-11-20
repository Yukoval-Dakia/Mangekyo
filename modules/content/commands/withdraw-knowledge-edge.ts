import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { knowledgeEdgeType, withdrawKnowledgeEdgeCommand } from '../knowledge-edge.ts';
import { fields, pageId, record, revision } from '../parse.ts';

export default defineCommand({
  type: withdrawKnowledgeEdgeCommand,
  destructive: true,
  schema: { parse(input: unknown) {
    const value = record(input);
    fields(value, 'id', 'expectedRev');
    return {id:pageId(value.id), expectedRev:revision(value.expectedRev)};
  } },
  async write(ctx, {id, expectedRev}): Promise<readonly FactWrite[]> {
    const current = await ctx.read.fact(id, {mode:'following'});
    if (current.ref.rev !== expectedRev || current.type !== knowledgeEdgeType) {
      throw new Error(`Fact revision conflict: ${id}`);
    }
    return [{kind:'retract', id, expectedRev}];
  },
});
