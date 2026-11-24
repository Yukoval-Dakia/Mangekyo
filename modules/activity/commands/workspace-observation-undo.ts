import {defineCommand, factId, type FactWrite} from '@mangekyo/kernel';
import {WorkspaceInputError, workspaceEntry, workspaceEntryType} from '../workspace-values.ts';

export default defineCommand({
  type:'activity.withdrawWorkspaceObservation', destructive:true,
  schema:{parse(input: unknown) {
    if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string')
      throw new WorkspaceInputError('观察引用无效。');
    return {id:factId(input.id)};
  }},
  async write(ctx, {id}): Promise<readonly FactWrite[]> {
    const current = await ctx.read.fact(id,{mode:'following'});
    if (current.ref.rev !== 1 || current.type !== workspaceEntryType || workspaceEntry(current.value).kind !== 'observation')
      throw new WorkspaceInputError('观察已编辑，不能撤回原始版本。');
    return [{kind:'retract',id,expectedRev:current.ref.rev}];
  },
});
