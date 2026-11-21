import { defineCommand } from '@mangekyo/kernel';
import { assetType, parseAsset } from '@mangekyo/module-content/facts/asset-contract';
import { storagePurpose } from '../library-values.ts';
import {
  ownWordsClaim, ownWordsClaimType, saveOwnWordsTakeawayCommand, saveOwnWordsTakeawayInput,
} from '../takeaway-values.ts';
import { sameWorkbookJson, workbookAttempt, workbookPaper, workbookPaperType } from '../workbook-values.ts';

export default defineCommand({
  type: saveOwnWordsTakeawayCommand,
  destructive: false,
  schema: {parse: saveOwnWordsTakeawayInput},
  async write(ctx, {id, binding, concept}) {
    const paperFact = await ctx.read.fact(binding.paperId, {mode: 'following'});
    if (paperFact.type !== workbookPaperType) throw new Error('口诀只能绑定普通练习卷。');
    const attemptFact = await ctx.read.fact(binding.attempt.id, {mode: 'pinned', rev: binding.attempt.rev});
    if (attemptFact.type !== 'activity.workbookAttempt') throw new Error('口诀必须绑定正式作答。');
    const attempt = workbookAttempt(attemptFact.value);
    if (attempt.paperId !== binding.paperId || !sameWorkbookJson(attempt.paper, workbookPaper(paperFact.value)) ||
        !attempt.feedback.some(item => item.questionId === binding.itemId &&
          (item.result === 'incorrect' || item.result === 'partial'))) {
      throw new Error('口诀题位与实际作答不匹配。');
    }
    if (concept !== undefined) {
      const conceptFact = await ctx.read.fact(concept.id, {mode: 'following'});
      if (conceptFact.type !== assetType || parseAsset(conceptFact.value).kind !== 'concept' ||
          conceptFact.ref.rev !== concept.rev || conceptFact.accessEpoch !== concept.accessEpoch) {
        throw new Error('口诀概念锚点已变化。');
      }
    }
    return [{
      kind: 'create',
      id,
      factType: ownWordsClaimType,
      data: ownWordsClaim(binding, concept, attemptFact.accessEpoch),
      purpose: [storagePurpose],
    }];
  },
});
