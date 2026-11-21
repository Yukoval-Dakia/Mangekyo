import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import {
  setWorkspaceTeachingCommand,
  setWorkspaceTeachingInput,
  workspaceShareableTypes, workspaceEntry, workspaceEntryType,
} from '../workspace-values.ts';
import intake from '@mangekyo/module-capture/facts/intake';
import { studyTurn, turnResearchPurpose } from '../values.ts';
import { materialType, storagePurpose } from '../library-values.ts';
import { workbookPaperType, workbookResearchPurpose } from '../workbook-values.ts';
import { isWorkbookAnswerDisplay, workbookPresentationType } from '../workbook-presentation.ts';

/**
 * Learner-only by intent: the command is destructive so a companion request is
 * stored as a proposal instead of escalating its own teaching purpose.
 */
export default defineCommand({
  type: setWorkspaceTeachingCommand,
  destructive: true,
  schema: {
    parse(value: unknown) {
      const parsed = setWorkspaceTeachingInput(value);
      const use = value && typeof value === 'object' && 'use' in value ? value.use : parsed.purpose ?? 'teaching';
      if (parsed.purpose && parsed.purpose !== use) throw new Error('用途不一致。');
      if (use !== 'teaching' && use !== workbookResearchPurpose) throw new Error('用途无效。');
      const input = {...parsed, use};
      if (!value || typeof value !== 'object' || !('intakeId' in value)) return input;
      if (typeof value.intakeId !== 'string') throw new Error('交入记录标识无效。');
      return { ...input, intakeId: factId(value.intakeId) };
    },
  },
  write: async (ctx, input): Promise<readonly FactWrite[]> => {
    const current = await ctx.read.fact(input.id, { mode: 'following' });
    if (current.ref.rev !== input.expectedRev) {
      throw new Error(`Fact revision conflict: ${input.id}`);
    }
    const use = input.use;
    const revokingTurn = !input.enabled && current.type === 'activity.studyTurn' && studyTurn(current.value).caseId === 'companion';
    const sharingAnswerDisplay = use === 'teaching' && current.type === workbookPresentationType &&
      isWorkbookAnswerDisplay(current.value);
    if (!revokingTurn && !sharingAnswerDisplay && !workspaceShareableTypes.includes(current.type)) {
      throw new Error('这类记录不能从工作区开放。');
    }
    if (!revokingTurn && use === workbookResearchPurpose && current.type !== workbookPaperType &&
        !(current.type === workspaceEntryType && workspaceEntry(current.value).kind === 'question'))
      throw new Error('只能选择试卷或来源题的后台用途。');
    const targets = [current];
    if ('intakeId' in input && input.intakeId !== undefined) {
      if (current.type !== materialType) throw new Error('只有材料可以关联交入记录。');
      const intakeFact = await ctx.read.fact(input.intakeId, { mode: 'following' });
      if (intakeFact.type !== intake.type || intake.schema.parse(intakeFact.value).materialId !== current.ref.id)
        throw new Error('材料与交入记录不匹配。');
      targets.push(intakeFact);
    }
    return targets.flatMap((fact): FactWrite[] => {
      if (fact.purpose.includes('all')) throw new Error('这条记录允许全部用途，请先明确其他用途。');
      if (fact.purpose.includes(use) === input.enabled) return [];
      const purpose = input.enabled
        ? [...fact.purpose, use]
        : fact.purpose.filter((item) => item !== use);
      return [{
        kind: 'set_purpose',
        id: fact.ref.id,
        expectedRev: fact.ref.rev,
        purpose: purpose.length ? purpose : [storagePurpose],
        ...(revokingTurn && use === turnResearchPurpose ? { scopedPurpose: use } : {}),
      }];
    });
  },
});
