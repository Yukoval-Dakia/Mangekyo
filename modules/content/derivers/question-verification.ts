import { defineDeriver } from '@mangekyo/kernel';
import { gather, questionVerificationMethodVersion, questionVerificationType } from '../question-verification.ts';
import { questionVerificationReview, type QuestionVerificationBasis } from '../question-state.ts';

export default defineDeriver({
  name: 'content/question-verification',
  version: questionVerificationMethodVersion,
  slot: questionVerificationType,
  gather,
  // An effect-aware host submits settle(sealed, receipts) for this deriver.
  derive(basis: QuestionVerificationBasis) {
    return { kind: 'value' as const, value: questionVerificationReview(basis, '验题需要封存计划与效果账本回执。') };
  },
});
