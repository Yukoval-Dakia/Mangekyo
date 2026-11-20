import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { studyKit } from '../../executors/teaching/study-kit.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { parseRecallMount } from '../../modules/activity/recall-values.ts';
import { workbookRequestId } from '../../modules/activity/workbook-values.ts';
import { purpose, studioLearner } from './identity.ts';
import type { NotionReadScope } from './notion.ts';
import { openRecall, recallItemId, RecallRequestError, type RecallMount } from './recall.ts';

export const recallDisplayToken = 'x-recall-display-token';
const idPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);

function readMount(value: unknown): RecallMount {
  try { return parseRecallMount(value); }
  catch { throw new RecallRequestError(400, '回忆题挂载标识无效。'); }
}

function readRequestId(value: unknown) {
  try { return workbookRequestId(value); }
  catch { throw new RecallRequestError(400, '回忆题请求标识无效。'); }
}

type DisplayReceipt = { sessionId: string; mount: RecallMount; revealId: string; requestId: string; token: string };

export function openRecallHttp(db: Db, activity: LoadedModule, hooks?: CommandHooks) {
  const key = randomBytes(32);
  function sign({ sessionId, mount, revealId, requestId }: Omit<DisplayReceipt, 'token'>) {
    return createHmac('sha256', key).update(JSON.stringify([
      studioLearner, sessionId, mount.turnId, mount.derivationId, mount.itemId, revealId, requestId,
    ])).digest();
  }

  const service = openRecall(db, activity, {
    ...(hooks ? { hooks } : {}),
    async verifyDisplay(receipt: unknown) {
      // Only display() below forwards a receipt to the service. A signed grant
      // binds the app's report to the delivered reveal and its original request.
      const report = receipt as DisplayReceipt;
      const supplied = Buffer.from(report.token, 'hex');
      if (supplied.length !== 32 || !timingSafeEqual(supplied, sign(report))) return null;
      return { mount: report.mount, revealId: report.revealId };
    },
  });

  async function requireSessionTurn(sessionId: string, turnId: string) {
    try {
      await db.snapshot({ learner: studioLearner }, async tx => {
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
      if (error instanceof FactNotFoundError) throw new RecallRequestError(404, '回忆题不属于该会话。');
      if (error instanceof FactReadDeniedError) throw new RecallRequestError(403, '回忆题依据已不可读。');
      throw error;
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
      const token = headers[recallDisplayToken];
      const { revealId, requestId, observed } = body;
      if (headers['sec-fetch-site'] !== 'same-origin' || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) ||
          observed !== 'mounted-visible') throw new RecallRequestError(403, '缺少获准的回忆题显示回执。');
      if (Object.keys(body).length !== 4 || !isId(revealId)) throw new RecallRequestError(400, '回忆题显示回执格式无效。');
      const mount = readMount(body.mount);
      const id = readRequestId(requestId);
      await requireSessionTurn(sessionId, mount.turnId);
      return service.confirmDisplay({ sessionId, mount, revealId, requestId: id, token } satisfies DisplayReceipt);
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
