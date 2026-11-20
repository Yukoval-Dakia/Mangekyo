import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { fields, pageId, record, revision } from '../parse.ts';
import { textbookPageFrom } from '../textbook-page.ts';

export default defineCommand({
  type: 'content.undoTextbookWrite',
  destructive: true,
  schema: { parse(input: unknown) {
    const value = record(input);
    fields(value, 'id', 'expectedRev', 'priorRev', 'accepted');
    if (typeof value.accepted !== 'boolean') throw new Error('教材撤回来源无效。');
    return { id:pageId(value.id), expectedRev:revision(value.expectedRev),
      priorRev:value.priorRev === null ? null : revision(value.priorRev), accepted:value.accepted };
  } },
  async write(ctx, {id, expectedRev, priorRev, accepted}): Promise<readonly FactWrite[]> {
    const current = await ctx.read.fact(id, {mode:'following'});
    if (current.ref.rev !== expectedRev) throw new Error(`Fact revision conflict: ${id}`);
    textbookPageFrom(current);
    if (priorRev === null && expectedRev === 1) return [{kind:'retract', id, expectedRev}];
    if (priorRev === null || priorRev !== expectedRev - 1) throw new Error('教材撤回版本无效。');
    const previous = await ctx.read.fact(id, {mode:'pinned', rev:priorRev});
    return [{kind:accepted ? 'correct' : 'revise', id, expectedRev, data:textbookPageFrom(previous)}];
  },
});
