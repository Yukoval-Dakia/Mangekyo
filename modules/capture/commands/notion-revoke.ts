import { defineCommand } from '@mangekyo/kernel';
import { notionSourceTarget, readNotionSourceTarget, revokeNotionSourceCommand } from '../notion-source.ts';

export default defineCommand({
  type: revokeNotionSourceCommand,
  destructive: true,
  schema: { parse: notionSourceTarget },
  async write(ctx, target) {
    const { current } = await readNotionSourceTarget(ctx, target);
    return [{ kind: 'retract', id: current.ref.id, expectedRev: current.ref.rev }];
  },
});
