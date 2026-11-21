import { readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { learnerReviewPorts } from '../../kernel/src/commands/learner-review.ts';
import { FactReadDeniedError, FactNotFoundError } from '../../kernel/src/commands/reads.ts';
import type { CommandRuntimeOptions } from '../../kernel/src/commands/contracts.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { AssetReadContext } from '../../modules/content/asset.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { textbookDiffReview } from '../../modules/content/textbook-diff.ts';
import { previewSelectedPage, selectedPagePreview, parsePageConfirmation, recordedPageConfirmation } from '../../modules/content/selected-page-distillation.ts';
import { readCurrentLearningObject } from './current-learning-object.ts';
import { studioLearner } from './identity.ts';
import { notionReadScope, type CheckNotionRead } from './notion.ts';
import { RequestError } from './sessions.ts';

const unavailable = () => new RequestError(409, '本轮或所选教材的存储依据已变更，请重新预览。');

export function openTurnDistillation(db: Db, options: CommandRuntimeOptions,
  storage: (tx: ReadTransaction, check: CheckNotionRead) => AssetReadContext['read']) {
  const review = (tx: DbTransaction) => textbookDiffReview(learnerReviewPorts(db, tx, options));
  return {
    async distill(id: string, request: Record<string,unknown>) {
      const scope = notionReadScope(db, studioLearner);
      async function preview(tx: ReadTransaction, check: CheckNotionRead) {
        const read = storage(tx, check);
        const turn = await read.fact(factId(id), {mode:'following'});
        if (turn.type !== 'activity.studyTurn') throw unavailable();
        const {answer, caseId, currentObject} = studyTurn(turn.value);
        if (!answer || caseId !== 'companion' || currentObject?.kind !== 'page') throw unavailable();
        const opened = await readCurrentLearningObject(tx, currentObject, () => true, true);
        if (!opened || opened.basisDigest !== currentObject.basisDigest) throw unavailable();
        const result = await previewSelectedPage({read, isUnavailable: denied}, turn, answer, currentObject, opened.basis);
        if (result.status !== 'ready') throw unavailable();
        return {...result, answer};
      }
      try {
        if (request.action === 'preview') return selectedPagePreview(await scope.read(preview));
        const confirmation = parsePageConfirmation(request);
        if (!confirmation) throw new RequestError(400, '请确认已预览的教材和原话。');
        return await scope.publishAfterChecks(async (tx, check) => {
          const replay = await recordedPageConfirmation(tx.learner, factId(id), confirmation, key => readRecordedCommand(tx,key));
          if (replay) return {replay};
          const fresh = await preview(tx, check);
          if (fresh.target.page.id !== confirmation.page || fresh.confirmationId !== confirmation.confirmationId) throw unavailable();
          return {fresh};
        }, async (tx, result) => result.replay ?? review(tx).confirmStorage({learner:tx.learner,...confirmation}, async () => result.fresh!));
      } catch (error) {
        if (denied(error)) throw unavailable();
        throw error;
      }
    },
    undoGroup: (tx: DbTransaction, page: ReturnType<typeof factId>, token: ReturnType<typeof commandId>) =>
      review(tx).undo({learner:tx.learner, page, token}),
  };
}
const denied = (error: unknown) => error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
