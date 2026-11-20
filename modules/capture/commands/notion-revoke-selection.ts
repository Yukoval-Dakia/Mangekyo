import { defineCommand } from '@mangekyo/kernel';
import { changeNotionSelection, revokeNotionSelectionCommand, selectionChange } from '../notion-selection.ts';

export default defineCommand({
  type: revokeNotionSelectionCommand, destructive: true, schema: { parse: selectionChange },
  write: (ctx, input) => changeNotionSelection(ctx, input),
});
