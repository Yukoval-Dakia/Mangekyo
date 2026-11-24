import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {createCommandReadContext, factId, matchKernelError, type CommandHooks, type Db} from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { studyKit } from '../../executors/teaching/study-kit.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { purpose, studioLearner } from './identity.ts';
import type { NotionReadScope } from './notion.ts';
import { openRecall, recallItemId, RecallRequestError } from './recall.ts';
import { displaySigner, parseDisplayBody, readMount, readRequestId, verifyDisplayReceipt } from '../../modules/activity/recall-http-support.ts';
import { studioHost } from './fact-read-helpers.ts';

export { recallDisplayToken } from '../../modules/activity/recall-http-support.ts';

export function openRecallHttp(db: Db, activity: LoadedModule, hooks?: CommandHooks) {
  const key = randomBytes(32);
  const sign = displaySigner(studioLearner, key);
  const host = studioHost(db);

  const service = openRecall(db, activity, {
    ...(hooks ? { hooks } : {}),
    async verifyDisplay(receipt: unknown) {
      // Only display() below forwards a receipt to the service. A signed grant
      // binds the app's report to the delivered reveal and its original request.
      return verifyDisplayReceipt(receipt, sign);
    },
  });

  async function requireSessionTurn(sessionId: string, turnId: string) {
    try {
      await host.snapshot(async tx => {
        const read = createCommandReadContext(tx, purpose);
        const root = await read.fact(factId(sessionId), { mode: 'following' });
        const turn = sessionId === turnId ? root : await read.fact(factId(turnId), { mode: 'following' });
        if (root.type !== 'activity.studyTurn' || turn.type !== root.type ||
            studyTurn(root.value).sessionId !== sessionId || studyTurn(root.value).parentId !== null ||
            studyTurn(turn.value).sessionId !== sessionId) {
          throw new RecallRequestError(404, '回忆题不属于该会话。');
        }
      });
    } catch (error) {
      throw matchKernelError(error, {
        not_found: () => new RecallRequestError(404, '回忆题不属于该会话。'),
        denied: () => new RecallRequestError(403, '回忆题依据已不可读。'),
        otherwise: err => err.cause,
      });
    }
  }

  return {
    async project(sessionId: string, turnId: string, derivationId: string, rawKit: unknown, notion: NotionReadScope) {
      if (rawKit === undefined) return undefined;
      const kit = studyKit(rawKit);
      if (!kit) throw new RecallRequestError(409, '此会话的回忆题格式无效。');
      await requireSessionTurn(sessionId, turnId);
      const items = [];
      for (const index of kit.questions.keys()) {
        const mount = { turnId, derivationId, itemId: recallItemId(turnId, derivationId, index) };
        try {
          items.push(await service.get(mount, notion));
        } catch (error) {
          if (index !== 0 || !(error instanceof RecallRequestError) || error.status !== 404) throw error;
          // One mount seals this version's complete set of items.
          items.push(await service.mount(mount, notion));
        }
      }
      return { title: kit.title, lesson: kit.lesson, items };
    },
    async readState(sessionId: string, query: URLSearchParams) {
      if (query.size !== 3) throw new RecallRequestError(400, '回忆题挂载标识无效。');
      const mount = readMount(Object.fromEntries(query));
      await requireSessionTurn(sessionId, mount.turnId);
      return service.readState(mount);
    },
    async reveal(sessionId: string, body: Record<string, unknown>) {
      const mount = readMount(body.mount);
      const requestId = readRequestId(body.requestId);
      await requireSessionTurn(sessionId, mount.turnId);
      const data = await service.requestReveal(body);
      return { data, token: sign({ sessionId, mount, revealId: data.revealId, requestId }).toString('hex') };
    },
    async display(sessionId: string, body: Record<string, unknown>, headers: IncomingHttpHeaders) {
      const { mount, revealId, requestId, token } = parseDisplayBody(body, headers);
      await requireSessionTurn(sessionId, mount.turnId);
      return service.confirmDisplay({ sessionId, mount, revealId, requestId, token });
    },
    async submit(sessionId: string, body: Record<string, unknown>) {
      const mount = readMount(body.mount);
      await requireSessionTurn(sessionId, mount.turnId);
      // This host cannot account for all pre-submission help channels.
      return service.submit(body);
    },
  };
}

export type RecallHttp = ReturnType<typeof openRecallHttp>;
