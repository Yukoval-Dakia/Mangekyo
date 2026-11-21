import { defineDeriver } from '@mangekyo/kernel';
import { gather, projectQuestionMeta, questionMetaDeriver, questionMetaMethodVersion, questionMetaType } from '../question-meta.ts';

export default defineDeriver({
  name: questionMetaDeriver,
  version: questionMetaMethodVersion,
  slot: questionMetaType,
  gather,
  derive({ draft, gardening, reason }) {
    return projectQuestionMeta(draft, gardening
      ? { status: 'needs-review', reason: '园艺候选需要封存计划和效果回执。' }
      : { status: 'skipped', reason: reason ?? '本次没有园艺请求。' });
  },
});
