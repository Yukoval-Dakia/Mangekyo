import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import {
  setWorkspaceTeachingCommand,
  setWorkspaceTeachingInput,
  workspaceShareableTypes,
} from '../workspace-values.ts';
import { intakeDocument, intakeFactType } from '../intake-values.ts';
import { materialType, storagePurpose } from '../library-values.ts';

const teachingPurpose = 'teaching';

/**
 * Learner-only by intent: the command is destructive so a companion request is
 * stored as a proposal instead of escalating its own teaching purpose.
 */
export default defineCommand({
  type: setWorkspaceTeachingCommand,
  destructive: true,
  schema: {
    parse(value: unknown) {
      const input = setWorkspaceTeachingInput(value);
      if (!value || typeof value !== 'object' || !('intakeId' in value)) return input;
      if (typeof value.intakeId !== 'string') throw new Error('交入记录标识无效。');
      return { ...input, intakeId: factId(value.intakeId) };
    },
  },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    if (current.ref.rev !== input.expectedRev) {
      throw new Error('工作区条目已在别处更新。');
    }
    if (!workspaceShareableTypes.includes(current.type)) throw new Error('这类记录不能从工作区开放。');
    const targets = [current];
    if ('intakeId' in input && input.intakeId !== undefined) {
      if (current.type !== materialType) throw new Error('只有材料可以关联交入记录。');
      const intake = await ctx.read.fact(input.intakeId, { mode: 'following' });
      if (intake.type !== intakeFactType || intakeDocument(intake.value).materialId !== current.ref.id)
        throw new Error('材料与交入记录不匹配。');
      targets.push(intake);
    }
    return targets.flatMap((fact): FactWrite[] => {
      if (fact.purpose.includes('all')) throw new Error('这条记录允许全部用途，请先明确其他用途。');
      if (fact.purpose.includes(teachingPurpose) === input.enabled) return [];
      const purpose = input.enabled
        ? [...fact.purpose, teachingPurpose]
        : fact.purpose.filter((item) => item !== teachingPurpose);
      return [{
        kind: 'set_purpose',
        id: fact.ref.id,
        expectedRev: fact.ref.rev,
        purpose: purpose.length ? purpose : [storagePurpose],
      }];
    });
  },
});
