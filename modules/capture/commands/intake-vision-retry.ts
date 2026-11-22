import { defineCommand, FactNotFoundError, type Revision } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import {
  canRetryVisionExtraction,
  intakeDocument,
  intakeDocumentPages,
  intakeFactType,
  IntakeVisionRetryConflict,
  intakePreview,
  materialType,
  pendingVisionExtraction,
  retryableVisionPages,
  retryVisionIntakeCommand,
  retryVisionIntakeSchema,
  type IntakeDocument,
  type IntakePageExtraction,
} from '../intake-values.ts';
import { validateStructuredPaperDrafts, visionPaperDraftsVersion } from '../vision-paper-ocr.ts';

export default defineCommand({
  type: retryVisionIntakeCommand,
  destructive: true,
  schema: retryVisionIntakeSchema,
  async write(ctx, input) {
    const document = await ctx.read.fact(input.intakeId, { mode: 'following' });
    if (document.type !== intakeFactType) throw new FactNotFoundError(input.intakeId);
    if (document.ref.rev !== input.expectedRev)
      throw new IntakeVisionRetryConflict('原文版本已经变更，请刷新后再重试视觉识别。');
    const archived = intakeDocument(document.value);
    if (archived.materialId !== input.materialId)
      throw new IntakeVisionRetryConflict('材料标识与交入记录不匹配。');
    if (archived.extraction.status === 'corrected' || archived.extraction.method === 'learner')
      throw new IntakeVisionRetryConflict('这份文字已由你手动更正，无法自动重跑覆盖。');
    if (!canRetryVisionExtraction(archived))
      throw new IntakeVisionRetryConflict('当前交入记录不处于可重试视觉识别的状态。');

    const material = await ctx.read.fact(archived.materialId, { mode: 'following' });
    if (material.type !== materialType) throw new FactNotFoundError(archived.materialId);
    if (input.expectedMaterialRev !== undefined && material.ref.rev !== input.expectedMaterialRev)
      throw new IntakeVisionRetryConflict('材料版本已经变更，请刷新后再试。');
    const saved = materialFact.schema.parse(material.value);

    const allPages = intakeDocumentPages(archived);
    let nextExtraction = pendingVisionExtraction('queued');
    if (allPages.length > 1) {
      const targetPages = input.pages ?? retryableVisionPages(archived);
      if (targetPages.length === 0 || targetPages.some(page => page < 1 || page > allPages.length)) {
        throw new IntakeVisionRetryConflict('指定重试页码超出当前试卷页数范围。');
      }
      const targetSet = new Set(targetPages);
      const existingByPage = new Map((archived.extraction.pageExtractions ?? []).map(item => [item.page, item]));
      const nextPageExtractions: IntakePageExtraction[] = allPages.map(page => {
        const current = existingByPage.get(page.page);
        if (!targetSet.has(page.page) && current && current.status !== 'pending') {
          return current;
        }
        return {
          page: page.page,
          status: 'pending',
          method: 'vision_llm',
          text: '',
          error: null,
          warnings: [],
          questionCount: 0,
        };
      });
      const readyPages = new Set(nextPageExtractions.filter(item => item.status === 'ready').map(item => item.page));
      const keptQuestions = archived.extraction.drafts && readyPages.size > 0
        ? archived.extraction.drafts.questions
            .filter(question => question.pageNumber !== undefined && readyPages.has(question.pageNumber))
            .map((question, index) => ({ ...question, index: index + 1 }))
        : [];
      const preservedDrafts = keptQuestions.length > 0 && archived.extraction.drafts
        ? validateStructuredPaperDrafts({
            version: visionPaperDraftsVersion,
            confirmationRequired: true,
            paperTitle: archived.extraction.drafts.paperTitle,
            subject: archived.extraction.drafts.subject,
            questions: keptQuestions,
            pendingConfirmationCount: keptQuestions.length,
          })
        : undefined;
      nextExtraction = pendingVisionExtraction('queued', {
        pageExtractions: nextPageExtractions,
        ...(preservedDrafts ? { preservedDrafts } : {}),
      });
    } else if (input.pages && input.pages.some(page => page !== 1)) {
      throw new IntakeVisionRetryConflict('单页试卷仅支持重试第 1 页。');
    }

    const nextDocument: IntakeDocument = {
      ...archived,
      requestedExtraction: 'vision_llm',
      extraction: nextExtraction,
    };
    return [
      {
        kind: 'correct' as const,
        id: material.ref.id,
        expectedRev: material.ref.rev as Revision,
        data: {
          title: archived.title,
          text: intakePreview(nextExtraction),
          ...(saved.savedAt === undefined ? {} : { savedAt: saved.savedAt }),
        },
      },
      {
        kind: 'correct' as const,
        id: input.intakeId,
        expectedRev: document.ref.rev as Revision,
        data: nextDocument,
      },
    ];
  },
});
