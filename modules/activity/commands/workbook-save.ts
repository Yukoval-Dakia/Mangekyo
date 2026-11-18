import { defineCommand, factId } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { textMaterial } from '../library-values.ts';
import { creation } from '../values.ts';
import {
  saveWorkbookPaperCommand,
  workbookPaper,
  workbookPaperType,
} from '../workbook-values.ts';

export default defineCommand({
  type: saveWorkbookPaperCommand,
  destructive: false,
  schema: creation(workbookPaper),
  write: async (ctx, { id, data }) => {
    if (data.materialId !== null) {
      const source = await ctx.read.fact(factId(data.materialId), { mode: 'following' });
      textMaterial(source.value);
    }
    return [
      { kind: 'create', id, factType: workbookPaperType, data, purpose: [storagePurpose] },
    ];
  },
});
