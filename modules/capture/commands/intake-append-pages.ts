import { defineCommand, FactNotFoundError, type Revision } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import {
  appendIntakePagesCommand,
  appendIntakePagesSchema,
  IntakeAppendPagesConflict,
  intakeDocument,
  intakeDocumentPages,
  intakeFactType,
  intakePreview,
  materialType,
  maxIntakePhotoPages,
  pendingVisionExtraction,
  type IntakeDocument,
  type IntakePageExtraction,
  type IntakePageOriginal,
} from '../intake-values.ts';
import {
  validateStructuredPaperDrafts,
  visionOcrSupports,
  visionPaperDraftsVersion,
} from '../vision-paper-ocr.ts';

function pendingPageExtraction(page: number): IntakePageExtraction {
  return {
    page,
    status: 'pending',
    method: 'vision_llm',
    text: '',
    error: null,
    warnings: [],
    questionCount: 0,
  };
}

function existingPageExtractions(archived: IntakeDocument): readonly IntakePageExtraction[] {
  const pages = intakeDocumentPages(archived);
  if (archived.extraction.pageExtractions && archived.extraction.pageExtractions.length === pages.length) {
    return archived.extraction.pageExtractions;
  }
  if (pages.length > 1) {
    return pages.map(page => pendingPageExtraction(page.page));
  }
  const { extraction } = archived;
  if (extraction.status === 'failed' &&
      (extraction.method === 'vision_llm' || extraction.method === 'vision_fallback')) {
    return [{
      page: 1,
      status: 'failed',
      method: extraction.method,
      text: '',
      error: extraction.error ?? '视觉识别失败。',
      warnings: [],
      questionCount: 0,
    }];
  }
  if (extraction.method === 'vision_fallback' || extraction.stage === 'fallback') {
    return [{
      page: 1,
      status: 'fallback',
      method: 'vision_fallback',
      text: extraction.text,
      error: null,
      warnings: extraction.warnings,
      questionCount: 0,
    }];
  }
  if (extraction.method === 'vision_llm' && (extraction.status === 'ok' || extraction.status === 'partial')) {
    return [{
      page: 1,
      status: 'ready',
      method: 'vision_llm',
      text: extraction.text,
      error: null,
      warnings: extraction.warnings,
      questionCount: extraction.drafts?.questions.length ?? 0,
      ...(extraction.drafts?.paperTitle !== undefined ? { paperTitle: extraction.drafts.paperTitle } : {}),
      ...(extraction.drafts?.subject !== undefined ? { subject: extraction.drafts.subject } : {}),
    }];
  }
  return [pendingPageExtraction(1)];
}

export default defineCommand({
  type: appendIntakePagesCommand,
  destructive: true,
  schema: appendIntakePagesSchema,
  async write(ctx, input) {
    const document = await ctx.read.fact(input.intakeId, { mode: 'following' });
    if (document.type !== intakeFactType) throw new FactNotFoundError(input.intakeId);
    if (document.ref.rev !== input.expectedRev) {
      throw new IntakeAppendPagesConflict('原文版本已经变更，请刷新后再续拍加页。');
    }
    const archived = intakeDocument(document.value);
    if (archived.materialId !== input.materialId) {
      throw new IntakeAppendPagesConflict('材料标识与交入记录不匹配。');
    }
    if (!visionOcrSupports(archived.original.mediaType)) {
      throw new IntakeAppendPagesConflict('只有照片试卷支持续拍加页合并。');
    }
    if (archived.extraction.status === 'corrected' || archived.extraction.method === 'learner') {
      throw new IntakeAppendPagesConflict('这份文字已由你手动更正，无法自动合并覆盖。');
    }
    if (archived.extraction.status === 'pending') {
      throw new IntakeAppendPagesConflict('当前试卷正在视觉识别中，请稍候完成后再续拍加页。');
    }

    const priorPages = intakeDocumentPages(archived);
    if (priorPages.length + input.pages.length > maxIntakePhotoPages) {
      throw new IntakeAppendPagesConflict(`同一份拍卷最多合并 ${maxIntakePhotoPages} 页照片。`);
    }

    const material = await ctx.read.fact(archived.materialId, { mode: 'following' });
    if (material.type !== materialType) throw new FactNotFoundError(archived.materialId);
    if (input.expectedMaterialRev !== undefined && material.ref.rev !== input.expectedMaterialRev) {
      throw new IntakeAppendPagesConflict('材料版本已经变更，请刷新后再试。');
    }
    const saved = materialFact.schema.parse(material.value);

    const nextOriginals: IntakePageOriginal[] = [
      ...priorPages,
      ...input.pages.map((page, offset) => ({ ...page, page: priorPages.length + offset + 1 })),
    ];
    const priorPageExtractions = existingPageExtractions(archived);
    const nextPageExtractions: IntakePageExtraction[] = [
      ...priorPageExtractions,
      ...input.pages.map((_, offset) => ({
        page: priorPages.length + offset + 1,
        status: 'pending' as const,
        method: 'vision_llm' as const,
        text: '',
        error: null,
        warnings: [],
        questionCount: 0,
      })),
    ];

    const readyPages = new Set(priorPageExtractions.filter(item => item.status === 'ready').map(item => item.page));
    const keptQuestions = archived.extraction.drafts && readyPages.size > 0
      ? archived.extraction.drafts.questions
          .map(question => ({ ...question, pageNumber: question.pageNumber ?? 1 }))
          .filter(question => readyPages.has(question.pageNumber))
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

    const nextExtraction = pendingVisionExtraction('queued', {
      pageExtractions: nextPageExtractions,
      ...(preservedDrafts ? { preservedDrafts } : {}),
    });
    const nextDocument: IntakeDocument = {
      ...archived,
      originals: nextOriginals,
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
