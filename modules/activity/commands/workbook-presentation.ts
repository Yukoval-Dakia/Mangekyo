import { defineCommand } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { creation } from '../values.ts';
import {
  authorizeWorkbookPresentation, recordWorkbookPresentationCommand, workbookPresentation, workbookPresentationType,
} from '../workbook-presentation.ts';

export default defineCommand({
  type: recordWorkbookPresentationCommand, destructive: false, schema: creation(workbookPresentation),
  async write(ctx, { id, data }) {
    await authorizeWorkbookPresentation(ctx.read, data);
    return [{ kind: 'create', id, factType: workbookPresentationType, data, purpose: [storagePurpose] }];
  },
});
