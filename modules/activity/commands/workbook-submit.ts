import { defineCommand, factId, type Revision } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { closedPosttest, issuedPosttestPaper, posttestIssuance, posttestIssuanceType, posttestSubmissionType, retentionTeachingPurpose } from '../retention-posttest.ts';
import { creation, object } from '../values.ts';
import { frozenWorkbookSubmission } from '../question-assessment.ts';
import { readFrozenWorkbookBank } from '../workbook-bank.ts';
import { resolveWorkbookPreSubmitRevised } from '../pre-submit-revision.ts';
import { practiceCustodyId, readPracticeCustody } from '../sealed-practice.ts';
import { authorizeWorkbookSubmissionAttachments } from '../workbook-attachments.ts';
import {
  checkWorkbookPacingItems,
  gradeWorkbook,
  submitWorkbookAttemptCommand,
  workbookAssessmentPurpose,
  workbookAttemptRequest,
  workbookAttemptType,
  workbookGradingVersion,
  workbookPaper,
  workbookPaperType,
  workbookRubricGradingVersion,
  WorkbookRevisionMismatch,
  sameWorkbookJson,
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
    const sealed = controlled || Boolean(await readPracticeCustody(ctx.read, await practiceCustodyId(fact.ref.id)));
    if (data.paperRev !== undefined) {
      if (sealed) {
        throw new Error('只有普通试卷接受逐题过程。');
      }
      if (data.paperRev !== fact.ref.rev || !sameWorkbookJson(current, paper)) {
        throw new WorkbookRevisionMismatch('卷版已变化，请刷新后交卷。');
      }
      checkWorkbookPacingItems(paper, data.pacing);
    }
    await readFrozenWorkbookBank(ctx.read, paper);
    const graded = gradeWorkbook(paper, data.answers, data.questionAttachments);
    const requiredPurposes = paper.assessmentRelease
      ? [storagePurpose, workbookAssessmentPurpose]
      : [storagePurpose];
    const basis = await authorizeWorkbookSubmissionAttachments(
      ctx, fact.ref.id, data.questionAttachments, requiredPurposes,
    );
    if (paper.assessmentRelease) frozenWorkbookSubmission(paper.assessmentRelease, { id, rev: 1 as Revision }, graded.answers, data.questionAttachments);
    const preSubmitRevised = await resolveWorkbookPreSubmitRevised(ctx.read, {
      paperId: fact.ref.id,
      paperRev: fact.ref.rev,
      paper,
      attemptId: id,
      data,
      gradedAnswers: graded.answers,
      sealed,
    });
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
          ...(data.questionAttachments === undefined ? {} : { questionAttachments: data.questionAttachments }),
          ...(basis === undefined ? {} : { basis }),
          feedback: graded.feedback,
          ...(data.effectiveDurationMs === undefined ? {} : { effectiveDurationMs: data.effectiveDurationMs }),
          ...(data.paperRev === undefined ? {} : { paperRev: data.paperRev }),
          ...(data.pacing === undefined ? {} : { pacing: data.pacing }),
          ...(data.assessmentConsent === undefined ? {} : { assessmentConsent: data.assessmentConsent }),
          ...(preSubmitRevised ? { preSubmitRevised: true as const } : {}),
        },
        purpose: controlled ? [storagePurpose, retentionTeachingPurpose]
          : paper.assessmentRelease ? [storagePurpose, workbookAssessmentPurpose] : [storagePurpose],
      },
    ];
  },
});
