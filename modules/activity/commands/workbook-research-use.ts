import { defineCommand, factId, type FactWrite, type Revision } from '@mangekyo/kernel';
import { setWorkbookResearchUse, workbookAttempt, workbookResearchPurpose } from '../workbook-values.ts';

export default defineCommand({
  type: setWorkbookResearchUse, destructive: true,
  schema: { parse(value: unknown) {
    const { paperId, attemptId, revision, allowed } = value as Record<string, unknown>;
    if (typeof allowed !== 'boolean' || typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) || revision < 1) throw new Error('原作用途或版本无效。');
    return { paperId: factId(String(paperId)), attemptId: factId(String(attemptId)),
      revision: revision as Revision, allowed };
  } },
  async write(ctx, { paperId, attemptId, revision, allowed }): Promise<readonly FactWrite[]> {
    const attempt = await ctx.read.fact(attemptId, { mode: 'following' });
    if (workbookAttempt(attempt.value).paperId !== paperId) throw new Error('原作不属于这份试卷。');
    if (attempt.ref.rev !== revision) throw new Error('Fact revision conflict');
    const purposes = attempt.purpose.filter(purpose => purpose !== workbookResearchPurpose);
    if (allowed) purposes.push(workbookResearchPurpose);
    if (attempt.purpose.includes(workbookResearchPurpose) === allowed) return [];
    return [{ kind: 'set_purpose', id: attemptId, expectedRev: revision, purpose: purposes }];
  },
});
