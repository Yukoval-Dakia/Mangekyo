import { isWorksheetProfile } from '../worker-consent.ts';
import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { matchesWorkbookAttachmentBasis } from '@mangekyo/module-activity/facts/workbook-attachments';
import { parseWorksheetAttachmentBasis, publishWorksheet, readResearchBasis, researchOrder, researchPurpose,
  researchWorksheetType, retentionReviewPermission, retentionReviewPermissionType, ResearchBasisChanged, worksheetDraft, worksheetBilling } from '../research.ts';

export default defineCommand({
  type: publishWorksheet,
  destructive: false,
  schema: { parse(value: unknown) {
    const input = value as Record<string, unknown>;
    const { method } = input;
    if (method !== 'deterministic-v1' && method !== 'local-agent' && !isWorksheetProfile(method)) throw new Error('复习单方法无效。');
    const questionNumber = input.questionNumber;
    if (typeof questionNumber !== 'number' || !Number.isSafeInteger(questionNumber) || questionNumber < 1)
      throw new Error('复习单题号无效。');
    const attachmentBasis = parseWorksheetAttachmentBasis(input.attachmentBasis);
    return { id: factId(String(input.id)), todoId: factId(String(input.todoId)),
      ...worksheetBilling(input), basis: researchOrder(input.basis), draft: worksheetDraft(input.draft), method, questionNumber,
      ...(attachmentBasis ? { attachmentBasis } : {}) };
  } },
  async write(ctx, { id, basis, questionNumber, ...result }): Promise<readonly FactWrite[]> {
    const source = await readResearchBasis(ctx.read, basis);
    const retention = source.type === retentionReviewPermissionType;
    if (retention && !retentionReviewPermission(source.value).allowed)
      throw new ResearchBasisChanged('后测教研授权已撤回。');
    for (const entry of result.attachmentBasis ?? []) {
      const live = await ctx.read.fact(entry.id, { mode: 'following' });
      if (!live.purpose.includes(researchPurpose) || !matchesWorkbookAttachmentBasis(live, entry)) {
        throw new ResearchBasisChanged('复习单所依图片附件权限或版本已变更。');
      }
    }
    return [{ kind: 'create', id, factType: researchWorksheetType, purpose: [researchPurpose],
      data: { ...result, source: basis.source, deliveredAt: new Date().toISOString(),
        digest: retention ? '已根据一次独立后测的预测偏差备好复习单。' : `已为这次作答备好第 ${questionNumber} 题的复习单。` } }];
  },
});
