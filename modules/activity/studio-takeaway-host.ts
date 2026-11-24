import {
  createCommandReadContext, factId, isFactUnavailable,
  type CommandId, type CommandReceipt, type Db, type DbTransaction, type Json, type ReadTransaction,
} from '@mangekyo/kernel';
import { storagePurpose } from './library-values.ts';
import { takeawayDisplay, takeawayFeedback, takeawayOpen, takeawaySave, takeawayUndo } from './takeaway-host.ts';

type LoadedModule = any;
export type StudioTakeawayDeps = {
  readonly stableId: (...parts: string[]) => string;
  readonly canonicalJsonString: (value: unknown) => string;
  readonly studioHost: (db: Db) => any;
  readonly createStudioCommandHooks: () => any;
  readonly RequestError: new (status: number, message: string) => Error;
  readonly createHmac: (algo: string, key: Uint8Array) => { update(data: string): { digest(encoding: string): string } };
  readonly randomBytes: (size: number) => Uint8Array;
};

export function openTakeaway(deps: StudioTakeawayDeps, db: Db, activity: LoadedModule, hooks = deps.createStudioCommandHooks()) {
  const key = deps.randomBytes(32);
  const sign = (scope: unknown) => deps.createHmac('sha256', key).update(deps.canonicalJsonString(scope)).digest('base64url');
  const host = deps.studioHost(db);
  const commands = { modules: [activity], hooks };
  type Handle = (request: { id: CommandId; type: string; input: unknown; purpose: string }) => Promise<CommandReceipt>;
  const reject = (status: number, message: string) => new deps.RequestError(status, message);
  const bound = (tx: DbTransaction, handle: Handle) => ({
    scope: tx, read: createCommandReadContext(tx, storagePurpose), handle, reject, sign, stable: deps.stableId,
    unavailable: isFactUnavailable,
  });
  const locked = (run: (tx: DbTransaction, handle: Handle) => Promise<unknown>) =>
    host.lockedTx(async (tx: DbTransaction) => run(tx, request => host.boundHandler(commands.modules, commands.hooks, tx)({ ...request, input: request.input as Json })));
  const asRequest = async <T>(run: () => Promise<T>) => {
    try { return await run(); }
    catch (error) {
      if (error instanceof deps.RequestError) throw error;
      throw new deps.RequestError(400, error instanceof Error ? error.message : '请求无效。');
    }
  };
  const mutate = async (paperId: string, attemptId: string | undefined, op: 'save' | 'open' | 'display' | 'undo', input: unknown) =>
    asRequest(() => locked((tx, handle) => {
      const b = bound(tx, handle);
      if (op === 'save') {
        if (!attemptId) throw reject(400, '口诀需要绑定正式作答。');
        return takeawaySave(b, factId(paperId), factId(attemptId), input);
      }
      return op === 'undo' ? takeawayUndo(b, input)
        : op === 'open' ? takeawayOpen(b, factId(paperId), input)
        : takeawayDisplay(b, factId(paperId), input);
    }));
  const read = async (paperId: string, attemptId: string, itemId: string) =>
    asRequest(() => host.snapshot((tx: ReadTransaction) =>
      takeawayFeedback({ scope: tx, read: createCommandReadContext(tx, storagePurpose), handle: () => Promise.reject(new Error('feedback is read-only')), reject, sign, stable: deps.stableId, unavailable: isFactUnavailable }, factId(paperId), factId(attemptId), itemId)));
  return { mutate, read };
}
