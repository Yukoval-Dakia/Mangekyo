import { defineCommand } from '@mangekyo/kernel';
import { changeNotionSelection, grantNotionSelectionCommand, selectionGrant } from '../notion-selection.ts';

export default defineCommand({
  type: grantNotionSelectionCommand, destructive: true, schema: { parse: selectionGrant },
  write: (ctx, input) => changeNotionSelection(ctx, input, input.settings),
});
