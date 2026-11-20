import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { assetType, parseAsset } from '../asset.ts';
import { fields, list, pageId, record, revision, text } from '../parse.ts';

export default defineCommand({
  type: 'content.saveDisciplineContext',
  destructive: true,
  schema: {
    parse(input: unknown) {
      const value = record(input);
      fields(value, 'id', 'expectedRev', 'purpose', 'title', 'discipline_context');
      const id = pageId(value.id);
      const asset = parseAsset({ kind: 'discipline', title: value.title, blocks: [], discipline_context: value.discipline_context });
      if (asset.kind !== 'discipline' || !asset.discipline_context) throw new Error('请提供完整学科语境。');
      const discipline = { ...asset, discipline_context: asset.discipline_context };
      if (value.expectedRev !== undefined) {
        if (value.purpose !== undefined) throw new Error('学科语境修订应沿用当前用途。');
        return { id, expectedRev: revision(value.expectedRev), asset: discipline };
      }
      const purpose = value.purpose === undefined ? ['storage'] : list(value.purpose).map(item => text(item, '用途'));
      if (!purpose.length || new Set(purpose).size !== purpose.length) throw new Error('学科语境用途无效。');
      return { id, purpose, asset: discipline };
    },
  },
  async write(ctx, input): Promise<readonly FactWrite[]> {
    if (input.expectedRev === undefined) {
      return [{ kind: 'create', id: input.id, factType: assetType, purpose: input.purpose, data: input.asset }];
    }
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    if (current.type !== assetType) throw new Error('目标事实不是学科语境。');
    const asset = parseAsset(current.value);
    if (asset.kind !== 'discipline') throw new Error('目标事实不是学科语境。');
    if (current.ref.rev !== input.expectedRev) throw new Error(`Fact revision conflict: ${input.id}`);
    return [{
      kind: 'correct', id: input.id, expectedRev: input.expectedRev,
      data: { ...asset, title: input.asset.title, discipline_context: input.asset.discipline_context },
    }];
  },
});
