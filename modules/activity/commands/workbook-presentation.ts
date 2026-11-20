import { defineCommand } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { creation } from '../values.ts';
import {
  sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType,
} from '../workbook-values.ts';
import {
  recordWorkbookPresentationCommand, workbookPresentation, WorkbookPresentationError, workbookPresentationType,
} from '../workbook-presentation.ts';

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
    const shown = await ctx.read.fact(data.paper.id, { mode: 'pinned', rev: data.paper.rev });
    if (shown.type !== workbookPaperType) throw new WorkbookPresentationError('需要已送达的普通试卷。');
    const paper = workbookPaper(shown.value);
    if (!data.items.every(id => paper.questions.some(question => question.id === id))) {
      throw new WorkbookPresentationError('呈现题项与卷面不匹配。');
    }
    const submitted = data.kind === 'solution' ? data.submission : data.attemptRef;
    if (submitted) {
      const submission = await ctx.read.fact(submitted.id, {mode:'pinned',rev:submitted.rev});
      if (submission.type !== workbookAttemptType) throw new WorkbookPresentationError('需要已送达的作答反馈。');
      const attempt = workbookAttempt(submission.value);
      if (attempt.paperId !== shown.ref.id || !sameWorkbookJson(attempt.paper, paper) ||
          (data.kind === 'solution' && !data.items.every(id => attempt.feedback.some(item => item.questionId === id &&
            item.result !== 'unanswered' && item.expected.kind !== 'rubric')))) {
        throw new WorkbookPresentationError('参考答案与实际反馈不匹配。');
      }
    }
    return [{ kind: 'create', id, factType: workbookPresentationType, data, purpose: [storagePurpose] }];
  },
});
