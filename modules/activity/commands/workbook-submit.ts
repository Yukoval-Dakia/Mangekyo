import { defineCommand, factId } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { creation } from '../values.ts';
import {
  gradeWorkbook,
  submitWorkbookAttemptCommand,
  workbookAssessmentPurpose,
  workbookAttemptRequest,
  workbookAttemptType,
  workbookGradingVersion,
  workbookPaper,
  workbookRubricGradingVersion,
} from '../workbook-values.ts';

export default defineCommand({
  type: submitWorkbookAttemptCommand,
  destructive: false,
  schema: creation(workbookAttemptRequest),
  write: async (ctx, { id, data }) => {
    const fact = await ctx.read.fact(factId(data.paperId), { mode: 'following' });
    const current = workbookPaper(fact.value);
    const release = current.assessmentRelease?.releaseRef;
    if (release && release.id !== fact.ref.id) throw new Error('评估发放与试卷不匹配。');
    const paper = release
      ? workbookPaper((await ctx.read.fact(release.id, { mode: 'pinned', rev: release.rev })).value)
      : current;
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
          gradingVersion: paper.questions.some((question) => question.kind === 'rubric')
            ? workbookRubricGradingVersion
            : workbookGradingVersion,
          paper,
          answers: graded.answers,
          feedback: graded.feedback,
          ...(data.assessmentConsent === undefined ? {} : { assessmentConsent: data.assessmentConsent }),
        },
        purpose: paper.assessmentRelease ? [storagePurpose, workbookAssessmentPurpose] : [storagePurpose],
      },
    ];
  },
});
