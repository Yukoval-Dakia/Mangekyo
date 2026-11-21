import { defineCommand, factId, type Revision } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import {
  completeCloudIntakeCommand,
  intakeDocument,
  intakeExtraction,
  intakeFactType,
  intakePreview,
  materialType,
} from '../intake-values.ts';

const schema = {
  parse(input: unknown) {
    if (!input || typeof input !== 'object' || !('intakeId' in input) ||
        typeof input.intakeId !== 'string' || !('expectedRev' in input) ||
        typeof input.expectedRev !== 'number' || !Number.isSafeInteger(input.expectedRev) ||
        input.expectedRev < 1 || !('expectedMaterialRev' in input) ||
        typeof input.expectedMaterialRev !== 'number' || !Number.isSafeInteger(input.expectedMaterialRev) ||
        input.expectedMaterialRev < 1 || !('extraction' in input))
      throw new Error('云识别任务缺少有效的交入版本。');
    const extraction = intakeExtraction(input.extraction);
    if (extraction.method !== 'mineru' || extraction.status === 'pending' || extraction.status === 'corrected')
      throw new Error('云识别任务没有可保存的结果。');
    return {
      intakeId: factId(input.intakeId),
      expectedRev: input.expectedRev as Revision,
      expectedMaterialRev: input.expectedMaterialRev as Revision,
      extraction,
    };
  },
};

export default defineCommand({
  type: completeCloudIntakeCommand,
  destructive: true,
  schema,
  async write(ctx, { intakeId, expectedRev, expectedMaterialRev, extraction }) {
    const document = await ctx.read.fact(intakeId, { mode: 'following' });
    if (document.type !== intakeFactType || document.ref.rev !== expectedRev) return [];
    const archived = intakeDocument(document.value);
    if (archived.requestedExtraction !== 'mineru' || archived.extraction.status !== 'pending') return [];
    const material = await ctx.read.fact(archived.materialId, { mode: 'following' });
    if (material.type !== materialType || material.ref.rev !== expectedMaterialRev) return [];
    const saved = materialFact.schema.parse(material.value);
    return [
      {
        kind: 'correct',
        id: material.ref.id,
        expectedRev: material.ref.rev,
        data: { title: archived.title, text: intakePreview(extraction),
          ...(saved.savedAt === undefined ? {} : { savedAt: saved.savedAt }) },
      },
      {
        kind: 'correct',
        id: intakeId,
        expectedRev: document.ref.rev,
        data: { ...archived, extraction },
      },
    ];
  },
});
