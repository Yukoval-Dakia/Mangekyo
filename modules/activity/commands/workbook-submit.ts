import { defineCommand, factId } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { creation } from '../values.ts';
import {
  gradeWorkbook,
  submitWorkbookAttemptCommand,
  workbookAttemptRequest,
  workbookAttemptType,
  workbookGradingVersion,
  workbookPaper,
} from '../workbook-values.ts';

export default defineCommand({
  type: submitWorkbookAttemptCommand,
  destructive: false,
  schema: creation(workbookAttemptRequest),
  write: async (ctx, { id, data }) => {
    const fact = await ctx.read.fact(factId(data.paperId), { mode: 'following' });
    const paper = workbookPaper(fact.value);
    const graded = gradeWorkbook(paper, data.answers);
    return [
      {
        kind: 'create',
        id,
        factType: workbookAttemptType,
        data: {
          paperId: data.paperId,
          requestId: data.requestId,
          submittedAt: data.submittedAt,
          gradingVersion: workbookGradingVersion,
          paper,
          answers: graded.answers,
          feedback: graded.feedback,
        },
        purpose: [storagePurpose],
      },
    ];
  },
});
