import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { prepareResearch, readResearchBasis, researchOrder, researchOrderType, researchPurpose } from '../research.ts';

export default defineCommand({
  type: prepareResearch,
  destructive: false,
  schema: { parse(value: unknown) {
    const input = value as Record<string, unknown>;
    return { id: factId(String(input.id)), data: researchOrder(input.data) };
  } },
  async write(ctx, { id, data }): Promise<readonly FactWrite[]> {
    await readResearchBasis(ctx.read, data);
    return [{ kind: 'create', id, factType: researchOrderType, purpose: [researchPurpose], data }];
  },
});
