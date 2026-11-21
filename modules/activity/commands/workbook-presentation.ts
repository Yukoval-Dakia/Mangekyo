import { defineCommand, FactNotFoundError } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { helpRef } from '../help-exposure-values.ts';
import { creation, object } from '../values.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
} from '../workbook-values.ts';
import {
  recordWorkbookPresentationCommand, workbookPresentation, WorkbookPresentationError, workbookPresentationType,
} from '../workbook-presentation.ts';
import { openSealedPractice } from '../sealed-practice.ts';

export default defineCommand({
  type: recordWorkbookPresentationCommand,
  destructive: false,
  schema: creation(workbookPresentation),
  async write(ctx, { id, data }) {
    if (data.phase === 'displayed') {
      const { phase, permit, ...scope } = data;
      if (!permit) throw new WorkbookPresentationError('缺少呈现许可。');
      const reservation = await ctx.read.fact(permit, { mode: 'following' });
      if (reservation.type !== workbookPresentationType ||
          !sameWorkbookJson(reservation.value, { ...scope, phase: 'permit' })) {
        throw new WorkbookPresentationError('许可与题面或反馈版本不匹配。');
      }
    }
    const shown = await ctx.read.fact(data.paper.id, { mode: 'pinned', rev: data.paper.rev }).catch(error => {
      if (!(error instanceof FactNotFoundError) || data.kind !== 'question' || data.issuanceId || data.paper.rev !== 1) throw error;
    });
    const paper = shown?.type === workbookPaperType ? workbookPaper(shown.value) : !shown
      ? (await openSealedPractice(ctx.read,data.paper.id))?.paper : undefined;
    if (!paper) throw new WorkbookPresentationError('需要已送达的普通试卷。');
    if (!data.items.every(id => paper.questions.some(question => question.id === id))) {
      throw new WorkbookPresentationError('呈现题项与卷面不匹配。');
    }
    if ('issuanceId' in data && data.issuanceId) {
      const issue = await ctx.read.fact(data.issuanceId, { mode: 'following' });
      if (issue.type !== 'capture.paperIssuance' || issue.ref.rev !== 1 ||
          !sameWorkbookJson(helpRef(object(issue.value).source), data.paper))
        throw new WorkbookPresentationError('纸面发放与固定卷面不匹配。');
    }
    if (data.kind === 'solution') {
      const submission = await ctx.read.fact(data.submission.id, { mode: 'pinned', rev: data.submission.rev });
      if (submission.type !== workbookAttemptType) throw new WorkbookPresentationError('需要已送达的作答反馈。');
      const attempt = workbookAttempt(submission.value);
      if (attempt.paperId !== data.paper.id || !sameWorkbookJson(attempt.paper, paper) ||
          !data.items.every(id => attempt.feedback.some(item => item.questionId === id &&
            item.result !== 'unanswered' && item.expected.kind !== 'rubric'))) {
        throw new WorkbookPresentationError('参考答案与实际反馈不匹配。');
      }
    }
    return [{ kind: 'create', id, factType: workbookPresentationType, data, purpose: [storagePurpose] }];
  },
});
