import { defineCommand, factId } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { closedPosttest, issuedPosttestPaper, posttestIssuance, posttestIssuanceType, posttestSubmissionType, retentionTeachingPurpose } from '../retention-posttest.ts';
import { creation, object } from '../values.ts';
import {
  gradeWorkbook,
  submitWorkbookAttemptCommand,
  workbookAssessmentPurpose,
  workbookAttemptRequest,
  workbookAttemptType,
  workbookGradingVersion,
  workbookPaper,
  workbookPaperType,
  workbookRubricGradingVersion,
} from '../workbook-values.ts';

export default defineCommand({
  type: submitWorkbookAttemptCommand,
  destructive: false,
  schema: { parse(input: unknown) {
    return { ...creation(workbookAttemptRequest).parse(input), controlled: object(input).condition === closedPosttest };
  } },
  write: async (ctx, { id, data, controlled }) => {
    const fact = await ctx.read.fact(factId(data.paperId), { mode: 'following' });
    if (fact.type !== (controlled ? posttestIssuanceType : workbookPaperType)) throw new Error('交卷与发放类型不匹配。');
    const issued = controlled ? posttestIssuance(fact.value) : undefined;
    if (issued && (data.submittedAt < issued.startedAt || data.submittedAt > issued.through)) throw new Error('交卷已超出后测窗口。');
    const current = issued ? await issuedPosttestPaper(ctx.read, issued) : workbookPaper(fact.value);
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
        factType: controlled ? posttestSubmissionType : workbookAttemptType,
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
        purpose: controlled ? [storagePurpose, retentionTeachingPurpose]
          : paper.assessmentRelease ? [storagePurpose, workbookAssessmentPurpose] : [storagePurpose],
      },
    ];
  },
});
