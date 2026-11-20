import { defineCommand } from '@mangekyo/kernel';
import {
  intakeDocument, intakeFactType, intakeResearchPermission, intakeResearchPurpose, IntakeResearchConflict,
  materialType, setIntakeResearchCommand,
} from '../intake-values.ts';

export default defineCommand({
  type: setIntakeResearchCommand,
  destructive: true,
  schema: { parse: intakeResearchPermission },
  async write(ctx, input) {
    const material = await ctx.read.fact(input.materialId, { mode: 'following' });
    const fact = await ctx.read.fact(input.intakeId, { mode: 'following' });
    if (material.type !== materialType || fact.type !== intakeFactType || fact.ref.rev !== input.expectedRev)
      throw new IntakeResearchConflict('原件版本已变更，请刷新后重试。');
    const { materialId, extraction } = intakeDocument(fact.value);
    if (materialId !== input.materialId || (input.enabled && (extraction.status !== 'corrected' || extraction.method !== 'learner')))
      throw new IntakeResearchConflict('请先保存本人更正的文字。');
    if (fact.purpose.includes('all')) throw new IntakeResearchConflict('这份原件已设置为全部用途。');
    if (fact.purpose.includes(intakeResearchPurpose) === input.enabled) return [];
    const purpose = input.enabled
      ? [...fact.purpose, intakeResearchPurpose]
      : fact.purpose.filter(use => use !== intakeResearchPurpose);
    return [{ kind: 'set_purpose', id: fact.ref.id, expectedRev: fact.ref.rev, purpose }];
  },
});
