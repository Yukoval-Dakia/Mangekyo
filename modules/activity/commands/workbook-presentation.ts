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
    const shown = await ctx.read.fact(data.paper.id, { mode: 'pinned', rev: data.paper.rev });
    if (shown.type !== workbookPaperType) throw new WorkbookPresentationError('需要已送达的普通试卷。');
    const paper = workbookPaper(shown.value);
    if (!data.items.every(id => paper.questions.some(question => question.id === id))) {
      throw new WorkbookPresentationError('呈现题项与卷面不匹配。');
    }
    if (data.kind === 'solution') {
      const submission = await ctx.read.fact(data.submission.id, { mode: 'pinned', rev: data.submission.rev });
      if (submission.type !== workbookAttemptType) throw new WorkbookPresentationError('需要已送达的作答反馈。');
      const attempt = workbookAttempt(submission.value);
      if (attempt.paperId !== shown.ref.id || !sameWorkbookJson(attempt.paper, paper) ||
          !data.items.every(id => attempt.feedback.some(item => item.questionId === id &&
            item.result !== 'unanswered' && item.expected.kind !== 'rubric'))) {
        throw new WorkbookPresentationError('参考答案与实际反馈不匹配。');
      }
    }
    return [{ kind: 'create', id, factType: workbookPresentationType, data, purpose: [storagePurpose] }];
  },
});
