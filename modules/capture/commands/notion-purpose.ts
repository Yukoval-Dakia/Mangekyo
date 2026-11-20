import { defineCommand } from '@mangekyo/kernel';
import { notionRetainedPurposes, notionSourceTarget, readNotionSourceTarget, setNotionPurposeCommand } from '../notion-source.ts';
import { notionRecord } from '../notion-values.ts';

export default defineCommand({
  type: setNotionPurposeCommand,
  destructive: true,
  schema: {
    parse(input: unknown) {
      const { preset } = notionRecord(input);
      if (preset !== 'learning' && preset !== 'storage') throw new Error('该 Notion 用途不能保存为长期原件。');
      return { ...notionSourceTarget(input), purpose: notionRetainedPurposes(preset) };
    },
  },
  async write(ctx, target) {
    const { current } = await readNotionSourceTarget(ctx, target);
    if (current.purpose.length === target.purpose.length && target.purpose.every(use => current.purpose.includes(use))) return [];
    return [{ kind: 'set_purpose', id: current.ref.id, expectedRev: current.ref.rev, purpose: target.purpose }];
  },
});
