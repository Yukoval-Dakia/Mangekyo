import { defineSlot } from '@mangekyo/kernel';
import { assetType } from '../asset.ts';
import { questionVerificationKey, questionStateType, questionVerificationType, type QuestionVerification } from '../question-state.ts';

export default defineSlot<{ id: string; rev: number; recheck?: number }, QuestionVerification>({
  type: questionVerificationType,
  key: questionVerificationKey,
  triggers: [{ kind: 'fact', factType: assetType }, { kind: 'fact', factType: questionStateType }],
  policy: 'lazy',
});
