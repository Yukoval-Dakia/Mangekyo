import { defineDeriver, type EffectRequest, type FactId, type GatherContext, type Revision } from '@mangekyo/kernel';
import { assetType, checkQuestionTeachingSources, freezeQuestionAssessment, questionAsset, questionPrompt } from '../asset.ts';
import { evaluateQuestionVerification, questionVerificationType, type VerificationReceipt } from '../question-state.ts';

type Basis = { id: FactId; rev: Revision; accessEpoch: string; recheck: number };

export default defineDeriver({
  name: 'content/question-verification',
  version: '1',
  slot: questionVerificationType,
  async gather(ctx: GatherContext, { id, rev, recheck = 0 }: { id: FactId; rev: Revision; recheck?: number }) {
    const question = await ctx.read.fact(id, { mode: 'following' });
    if (question.type !== assetType || question.ref.rev !== rev) throw new Error('只核验当前题版。');
    const asset = questionAsset(question.value);
    if (!question.purpose.includes('teaching') && !question.purpose.includes('all')) throw new Error('题目未授权教学用途。');
    await checkQuestionTeachingSources(ctx.read, asset);
    const data = { id, rev, accessEpoch: question.accessEpoch, recheck };
    if (!asset.response_schema || !asset.assessment_contract) {
      return { kind: 'input' as const, data, effects: [] };
    }
    const contract = freezeQuestionAssessment(asset, { id, rev });
    // Solvers receive the prompt and public answer shape. The rubric goes exclusively to the validator.
    const publicInput = { title: asset.title, prompt: questionPrompt(asset), response_schema: asset.response_schema,
      blocks: asset.blocks, ref: { id, rev },
    };
    const effects: EffectRequest[] = [1, 2, 3].map(index => ({
      stepKey: `solve-${index}`, label: 'question-independent-solve', input: publicInput,
    }));
    effects.push({ stepKey: 'contract', label: 'question-contract-validation', input: { ...publicInput, contract } });
    return { kind: 'input' as const, data, effects };
  },
  derive(input: Basis & { checks?: readonly VerificationReceipt[] }) {
    return { kind: 'value' as const, value: evaluateQuestionVerification(input) };
  },
});
