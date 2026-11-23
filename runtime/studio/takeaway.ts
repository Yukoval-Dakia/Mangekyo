import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import {
  createCommandReadContext, createLearnerHost, factId, isFactUnavailable,
  type CommandHooks, type CommandId, type CommandReceipt, type Db, type DbTransaction, type Json,
} from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { takeawayDisplay, takeawayFeedback, takeawayOpen, takeawaySave, takeawayUndo } from '../../modules/activity/takeaway-host.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { createStudioCommandHooks } from './command-hooks.ts';

const reject = (status: number, message: string) => new RequestError(status, message);

export function openTakeaway(db: Db, activity: LoadedModule, hooks: CommandHooks = createStudioCommandHooks()) {
  const key = randomBytes(32);
  const sign = (scope: unknown) => createHmac('sha256', key).update(canonicalJsonString(scope)).digest('base64url');
  const host = createLearnerHost(db, studioLearner);
  const commands = { modules: [activity], hooks };
  type Handle = (request: { id: CommandId; type: string; input: unknown; purpose: string }) => Promise<CommandReceipt>;
  const deps = (tx: DbTransaction, handle: Handle) => ({
    scope: tx, read: createCommandReadContext(tx, storagePurpose), handle, reject, sign, stable: stableId,
    unavailable: isFactUnavailable,
  });

  const locked = (run: (tx: DbTransaction, handle: Handle) => Promise<unknown>) =>
    host.lockedTx(async tx => {
      const bound = host.boundHandler(commands.modules, commands.hooks, tx);
      return run(tx, request => bound({ ...request, input: request.input as Json }));
    });
  const asRequest = async <T>(run: () => Promise<T>) => {
    try { return await run(); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(400, error instanceof Error ? error.message : '请求无效。');
    }
  };

  const mutate = async (paperId: string, attemptId: string | undefined, op: 'save' | 'open' | 'display' | 'undo', input: unknown) => {
    return asRequest(() => locked((tx, handle) => {
        const bound = deps(tx, handle);
        if (op === 'save') {
          if (!attemptId) throw reject(400, '口诀需要绑定正式作答。');
          return takeawaySave(bound, factId(paperId), factId(attemptId), input);
        }
        return op === 'undo' ? takeawayUndo(bound, input)
          : op === 'open' ? takeawayOpen(bound, factId(paperId), input)
          : takeawayDisplay(bound, factId(paperId), input);
      }));
  };
  const read = async (paperId: string, attemptId: string, itemId: string) => {
    return asRequest(() => host.snapshot(tx =>
      takeawayFeedback({ scope: tx, read: createCommandReadContext(tx, storagePurpose), handle: () => Promise.reject(new Error('feedback is read-only')), reject, sign, stable: stableId, unavailable: isFactUnavailable }, factId(paperId), factId(attemptId), itemId)));
  };
  return { mutate, read };
}
