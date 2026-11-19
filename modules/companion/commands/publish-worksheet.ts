import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { publishWorksheet, readResearchBasis, researchOrder, researchPurpose,
  researchWorksheetType, worksheetDraft } from '../research.ts';

export default defineCommand({
  type: publishWorksheet,
  destructive: false,
  schema: { parse(value: unknown) {
    const input = value as Record<string, unknown>;
    const { method } = input;
    if (method !== 'deterministic-v1' && method !== 'local-agent') throw new Error('复习单方法无效。');
    return { id: factId(String(input.id)), orderId: factId(String(input.orderId)), draft: worksheetDraft(input.draft), method };
  } },
  async write(ctx, { id, ...result }): Promise<readonly FactWrite[]> {
    const order = await ctx.read.fact(result.orderId, { mode: 'following' });
    await readResearchBasis(ctx.read, researchOrder(order.value));
    return [{ kind: 'create', id, factType: researchWorksheetType, purpose: [researchPurpose],
      data: { ...result, deliveredAt: new Date().toISOString() } }];
  },
});
