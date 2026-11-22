import { FactNotFoundError, defineCommand, type FactWrite } from '@mangekyo/kernel';
import materialFact from '../facts/material.ts';
import {
  assetType,
  confirmIntakeQuestionsCommand,
  intakeQuestionFullPrompt,
  intakeQuestionId,
  materialType,
  parseConfirmIntakeQuestions,
} from '../intake-question-bank.ts';
import { questionAsset } from '../asset.ts';
import { writeQuestion } from '../question-writes.ts';

export default defineCommand({
  type: confirmIntakeQuestionsCommand,
  destructive: false,
  schema: { parse: parseConfirmIntakeQuestions },
  async write(ctx, input): Promise<readonly FactWrite[]> {
    const material = await ctx.read.fact(input.materialId, { mode: 'following' });
    if (material.type !== materialType) throw new Error('来源不是拍卷材料。');
    if (material.ref.rev !== input.expectedMaterialRev) throw new Error('材料版本已变化，请重新核对拍卷题目。');
    materialFact.schema.parse(material.value);
    if (input.purpose === 'teaching' && !material.purpose.includes('teaching') && !material.purpose.includes('all')) {
      throw new Error('这份材料未授权教学用途。');
    }
    const purpose = input.purpose ?? 'storage';
    const basis = [{
      id: material.ref.id, rev: material.ref.rev, epoch: material.accessEpoch, type: materialType,
    }];
    const writes: FactWrite[] = [];
    for (const item of input.items) {
      const id = await intakeQuestionId(input.materialId, item.draftId);
      if (item.questionId !== undefined && item.questionId !== id) throw new Error('题目标识与来源草案不匹配。');
      let existing;
      try {
        existing = await ctx.read.fact(id, { mode: 'following' });
      } catch (error) {
        if (!(error instanceof FactNotFoundError)) throw error;
      }
      if (existing) {
        if (existing.type !== assetType) throw new Error('题目标识已被其他记录占用。');
        questionAsset(existing.value);
        continue;
      }
      const fullPrompt = intakeQuestionFullPrompt(item);
      const asset = questionAsset({
        kind: 'question',
        title: item.title,
        promptBlockId: 'prompt',
        basis,
        blocks: [
          { id: 'prompt', parentId: null, body: { kind: 'text', text: fullPrompt } },
          {
            id: 'source', parentId: null,
            body: {
              kind: 'reference', role: 'citation',
              target: { fact: material.ref, type: materialType, anchor: { kind: 'whole' } },
            },
          },
        ],
      });
      writes.push(...await writeQuestion(ctx, { id, asset, teaching: purpose === 'teaching' }, 'revise'));
    }
    return writes;
  },
});
