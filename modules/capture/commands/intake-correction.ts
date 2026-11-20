import { defineCommand } from '@mangekyo/kernel';
import { correctIntakeCommand, correctIntakeSchema, materialPreview, intakeDocument } from '../intake-values.ts';

export default defineCommand({
  type: correctIntakeCommand,
  destructive: true,
  schema: correctIntakeSchema,
  write: async (ctx, input) => {
    const material = await ctx.read.fact(input.materialId, { mode: 'following' });
    const document = await ctx.read.fact(input.intakeId, { mode: 'following' });
    if (document.ref.rev !== input.expectedRev) throw new Error('原文版本已经变更。');
    const archived = intakeDocument(document.value);
    if (archived.materialId.toString() !== input.materialId.toString()) {
      throw new Error('材料标识与交入记录不匹配。');
    }
    const corrected = {
      status: 'corrected' as const,
      method: 'learner' as const,
      text: input.text,
      error: null as null,
      warnings: ['这段文字由你手动填写或更正。'],
      pages: null,
      truncated: false,
      characterCount: input.text.length,
    };
    return [
      {
        kind: 'correct' as const,
        id: input.materialId,
        expectedRev: material.ref.rev,
        data: { title: archived.title, text: materialPreview(input.text).text },
      },
      {
        kind: 'correct' as const,
        id: input.intakeId,
        expectedRev: document.ref.rev,
        data: {
          ...archived,
          extraction: corrected,
        },
      },
    ];
  },
});
