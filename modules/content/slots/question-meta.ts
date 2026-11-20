import { defineSlot } from '@mangekyo/kernel';
import { assetType } from '../asset.ts';
import { questionKey, questionMetaDraftType, questionMetaType } from '../question-state.ts';

export default defineSlot({
  type: questionMetaType,
  key: questionKey,
  triggers: [
    { kind: 'fact', factType: assetType },
    { kind: 'fact', factType: questionMetaDraftType },
  ],
  policy: 'lazy',
});
