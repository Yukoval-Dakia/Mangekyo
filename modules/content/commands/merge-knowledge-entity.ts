import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { assetType, parseAsset } from '../asset.ts';
import { openKnowledgeEntity } from '../knowledge-entity.ts';
import { fields, pageId, record, revision } from '../parse.ts';

export default defineCommand({
  type: 'content.mergeKnowledgeEntity',
  destructive: true,
  schema: { parse(input: unknown) {
    const value = record(input);
    fields(value, 'id', 'expectedRev', 'into', 'targetRev');
    const id = pageId(value.id);
    const into = pageId(value.into);
    if (id === into) throw new Error('规范实体不能合并到自身。');
    return { id, expectedRev: revision(value.expectedRev), into, targetRev: revision(value.targetRev) };
  } },
  async write(ctx, { id, expectedRev, into, targetRev }): Promise<readonly FactWrite[]> {
    const source = await ctx.read.fact(id, { mode: 'following' });
    const target = await openKnowledgeEntity(ctx.read, into);
    if (source.type !== assetType || source.ref.rev !== expectedRev ||
        target.snapshot.ref.rev !== targetRev || target.redirects.length) {
      throw new Error('合并需要两个当前的规范实体修订。');
    }
    const { entity } = await openKnowledgeEntity(ctx.read, id, expectedRev);
    if (entity.mergedInto !== null || entity.kind !== target.entity.kind) {
      throw new Error('仅能合并尚未重定向且类别相同的实体。');
    }
    if (!source.purpose.every(purpose => target.snapshot.purpose.includes('all') || target.snapshot.purpose.includes(purpose))) {
      throw new Error('合并目标没有覆盖来源实体的允许用途。');
    }
    return [{ kind: 'correct', id, expectedRev, data: { ...parseAsset(source.value), mergedInto: into } }];
  },
});
