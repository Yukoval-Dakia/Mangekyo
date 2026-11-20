import { FactNotFoundError, defineCommand } from '@mangekyo/kernel';
import { paperIssuance, paperIssuanceId, paperIssuanceType, projectIssuedPaper } from '../paper.ts';

export default defineCommand({
  type: 'capture.issuePaper',
  destructive: false,
  schema: { parse: paperIssuance },
  async write(ctx, data) {
    await projectIssuedPaper(ctx.read, data);
    const id = await paperIssuanceId(data);
    try {
      const existing = await ctx.read.fact(id, { mode: 'following' });
      if (existing.type !== paperIssuanceType) throw new Error('发卷标识已被使用。');
      return [];
    } catch (error) {
      if (!(error instanceof FactNotFoundError)) throw error;
    }
    return [{ kind: 'create', id, factType: paperIssuanceType, data, purpose: ['storage'] }];
  },
});
