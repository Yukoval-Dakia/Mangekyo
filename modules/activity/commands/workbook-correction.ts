import { defineCommand } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { creation } from '../values.ts';
import {
  openWorkbookCorrectionTarget, recordWorkbookCorrection, workbookCorrectionTarget, workbookCorrectionType,
} from '../workbook-correction.ts';

export default defineCommand({
  type: recordWorkbookCorrection,
  destructive: false,
  schema: creation(workbookCorrectionTarget),
  async write(ctx, { id, data }) {
    const fact = await openWorkbookCorrectionTarget(ctx.read, data);
    return [{ kind: 'create', id, factType: workbookCorrectionType, purpose: [storagePurpose],
      data: { ...data, accessEpoch: fact.accessEpoch, correctedAt: new Date().toISOString() } }];
  },
});
