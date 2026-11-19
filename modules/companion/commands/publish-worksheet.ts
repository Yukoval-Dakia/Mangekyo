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
    const questionNumber = input.questionNumber;
    if (typeof questionNumber !== 'number' || !Number.isSafeInteger(questionNumber) || questionNumber < 1)
      throw new Error('复习单题号无效。');
    return { id: factId(String(input.id)), todoId: factId(String(input.todoId)),
      basis: researchOrder(input.basis), draft: worksheetDraft(input.draft), method, questionNumber };
  } },
  async write(ctx, { id, basis, questionNumber, ...result }): Promise<readonly FactWrite[]> {
    await readResearchBasis(ctx.read, basis);
    return [{ kind: 'create', id, factType: researchWorksheetType, purpose: [researchPurpose],
      data: { ...result, source: basis.source, deliveredAt: new Date().toISOString(),
        digest: `已为这次作答备好第 ${questionNumber} 题的复习单。` } }];
  },
});
