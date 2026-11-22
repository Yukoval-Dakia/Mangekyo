import { defineCommand, type Revision } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import {
  canRetryVisionExtraction,
  intakeDocument,
  intakeFactType,
  IntakeVisionRetryConflict,
  intakePreview,
  materialType,
  pendingVisionExtraction,
  retryVisionIntakeCommand,
  retryVisionIntakeSchema,
  type IntakeDocument,
} from '../intake-values.ts';

export default defineCommand({
  type: retryVisionIntakeCommand,
  destructive: true,
  schema: retryVisionIntakeSchema,
  async write(ctx, input) {
    const document = await ctx.read.fact(input.intakeId, { mode: 'following' });
    if (document.type !== intakeFactType) throw new Error('找不到这份原件。');
    if (document.ref.rev !== input.expectedRev)
      throw new IntakeVisionRetryConflict('原文版本已经变更，请刷新后再重试视觉识别。');
    const archived = intakeDocument(document.value);
    if (archived.materialId !== input.materialId) throw new Error('材料标识与交入记录不匹配。');
    if (archived.extraction.status === 'corrected' || archived.extraction.method === 'learner')
      throw new IntakeVisionRetryConflict('这份文字已由你手动更正，无法自动重跑覆盖。');
    if (!canRetryVisionExtraction(archived))
      throw new IntakeVisionRetryConflict('当前交入记录不处于可重试视觉识别的状态。');

    const material = await ctx.read.fact(archived.materialId, { mode: 'following' });
    if (material.type !== materialType) throw new Error('找不到对应材料。');
    if (input.expectedMaterialRev !== undefined && material.ref.rev !== input.expectedMaterialRev)
      throw new IntakeVisionRetryConflict('材料版本已经变更，请刷新后再试。');
    const saved = materialFact.schema.parse(material.value);
    const nextExtraction = pendingVisionExtraction('queued');
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
