import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import {
  setWorkspaceTeachingCommand,
  setWorkspaceTeachingInput,
  workspaceShareableTypes,
} from '../workspace-values.ts';

const teachingPurpose = 'teaching';

/**
 * Learner-only by intent: the command is destructive so a companion request is
 * stored as a proposal instead of escalating its own teaching purpose.
 */
export default defineCommand({
  type: setWorkspaceTeachingCommand,
  destructive: true,
  schema: { parse: setWorkspaceTeachingInput },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    if (current.ref.rev !== input.expectedRev) {
      throw new Error('工作区条目已在别处更新。');
    }
    if (!workspaceShareableTypes.includes(current.type)) throw new Error('这类记录不能从工作区开放。');
    if (current.purpose.includes('all')) throw new Error('这条记录允许全部用途，请先明确其他用途。');
    const enabled = current.purpose.includes(teachingPurpose);
    if (input.enabled === enabled) return [];
    const purpose = input.enabled
      ? [...current.purpose, teachingPurpose]
      : current.purpose.filter((item) => item !== teachingPurpose);
    return [{
      kind: 'set_purpose',
      id: input.id,
      expectedRev: input.expectedRev,
      purpose: purpose.length ? purpose : ['storage'],
    }];
  },
});
