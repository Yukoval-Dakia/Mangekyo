import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import {
  WorkspaceInputError,
  saveWorkspaceEntryCommand,
  saveWorkspaceEntryInput,
  verifyWorkspaceEntry,
  workspaceEntry,
  workspaceEntryType,
  type WorkspaceEntry,
} from '../workspace-values.ts';

const teachingPurpose = 'teaching';

export default defineCommand({
  type: saveWorkspaceEntryCommand, destructive: false, schema: { parse: saveWorkspaceEntryInput },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const data: WorkspaceEntry = { ...input.entry, basis: input.basis };
    if (input.expectedRev !== undefined) {
      const current = await ctx.read.fact(input.id, { mode: 'following' });
      if (current.ref.rev !== input.expectedRev) {
        throw new WorkspaceInputError('条目已有新版本。请用 read_workspace 读取当前版本，再用 id 和需要修改的字段保存。');
      }
      if (current.type !== workspaceEntryType || workspaceEntry(current.value).kind !== input.entry.kind)
        throw new WorkspaceInputError('修改时请沿用原条目的 kind，或省略 kind 只传有变化的字段。');
    }
    await verifyWorkspaceEntry(ctx, input.id, input.entry, input.basis);
    if (input.expectedRev === undefined) {
      return [{
        kind: 'create', id: input.id, factType: workspaceEntryType,
        data,
        purpose: input.purpose === storagePurpose ? [storagePurpose] : [storagePurpose, teachingPurpose],
      }];
    }
    return [{
      kind: 'revise', id: input.id, expectedRev: input.expectedRev,
      data,
    }];
  },
});
